// Server-side session manager. Each session is a RAW pty (plain bash, real
// TERM=xterm-256color - nothing between it and the program, so `claude` behaves
// exactly as over SSH). The pty is kept alive independent of any browser
// connection, so sessions survive refresh / closing the site / switching device.
// (They do NOT survive a node-server restart - by design; that's fine.)
import { spawn } from '@homebridge/node-pty-prebuilt-multiarch';
import { execFileSync } from 'node:child_process';
import Busboy from 'busboy';
import { homedir } from 'node:os';
import { basename, join, resolve as resolvePath, isAbsolute, sep, extname } from 'node:path';
import { existsSync, mkdirSync, createWriteStream, writeFileSync, readFileSync, unlinkSync, readdirSync, statSync, createReadStream, accessSync, realpathSync, rmSync, constants as FS } from 'node:fs';
import { apiTokenOk, apiAuthOk, originOk, bearerToken } from './auth.js';
import { initCrypto, mintPairCode, consumePairCode, registerDevice, mintDeviceToken, daemonPublicKeyB64, formatPairCode, daemonFingerprint, listDevices, deviceIdForToken, revokeDevice, updateDevice, isValidColour, isValidAvatar, setDevicePush, clearDevicePush, pushTargets } from './crypto.js';
import { sendPush, apnsEnabled } from './apns.js';
import { closeDeviceConnections } from './pty-bridge.js';
import { PersistentChatLog, evId } from './chat-events.js';
import { startClaudeChat } from './claude-chat.js';

const MAX_BUFFER = 256 * 1024; // recent output replayed on reattach (for redraw)
const MAX_UPLOAD = Number(process.env.COCKPIT_MAX_UPLOAD) || 100 * 1024 * 1024; // 100 MB/file cap
// Per-request upload caps (DoS defence): a single multipart POST can otherwise stream an
// unbounded number of files/fields. Cap both. Busboy emits `filesLimit`/`fieldsLimit` and
// then stops parsing past the cap.
const MAX_UPLOAD_FILES = Number(process.env.CODEOUT_MAX_UPLOAD_FILES) || 20;
const MAX_UPLOAD_FIELDS = Number(process.env.CODEOUT_MAX_UPLOAD_FIELDS) || 20;

// Session-creation budget (fork-bomb defence): any device token can otherwise spawn
// unlimited heavy `claude`/`bash` processes over the public tunnel. Cap the total live
// sessions, cap per-device live sessions, and rate-limit creates per device per window.
const MAX_TOTAL_SESSIONS = Number(process.env.CODEOUT_MAX_SESSIONS) || 50;
const MAX_SESSIONS_PER_DEVICE = Number(process.env.CODEOUT_MAX_SESSIONS_PER_DEVICE) || 12;
const CREATE_RATE_WINDOW_MS = Number(process.env.CODEOUT_CREATE_RATE_WINDOW_MS) || 60 * 1000;
const CREATE_RATE_MAX = Number(process.env.CODEOUT_CREATE_RATE_MAX) || 10; // creates / window / device
// creator id -> array of create timestamps within the rolling window (owner token: 'owner').
const createTimes = new Map();

// codeout state: per-session dtach sockets + a metadata file, so sessions survive a
// daemon restart - the dtach master keeps the agent alive and we reattach on boot.
const CODEOUT_HOME = process.env.CODEOUT_HOME || join(homedir(), '.codeout');
const SOCKET_DIR = join(CODEOUT_HOME, 'sockets');
const STATE_FILE = join(CODEOUT_HOME, 'sessions.json');
const LOCK_FILE = join(CODEOUT_HOME, 'daemon.lock');
// Chat scrollback persists here as append-only ndJSON per session, so a daemon
// restart/crash replays full history to reconnecting clients (not an empty UI).
const CHAT_LOG_DIR = join(CODEOUT_HOME, 'chat');

// The user's configured default reasoning effort. Claude reads `effortLevel` from
// ~/.claude/settings.json when we launch it WITHOUT an explicit --effort, so we read the
// same file to DISPLAY the real level (e.g. "xhigh") on the status bar instead of the
// unhelpful word "default". NOT memoized: this is only read when a stats accumulator is
// built (once per backend wire, a cold path), so re-reading the small file each time is
// cheap. A memo would show a STALE effort if the user edits settings.json mid-run
// (the bar would keep the old value, and a session launched after the change would run at
// the NEW effort but display the OLD). null if unset/unreadable.
function userDefaultEffort() {
	try {
		const cfg = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'));
		if (typeof cfg?.effortLevel === 'string' && cfg.effortLevel) return cfg.effortLevel;
	} catch {}
	return null;
}

// ---- Permission mode (per-session, with an owner-settable default) ----
// The set of permission postures we expose, mapped to the real `--permission-mode` value claude
// accepts (claude 4.8: default|acceptEdits|plan|bypassPermissions|auto|dontAsk). We surface only
// these four (UI labels: Default / Accept edits / Plan / Auto). `bypassPermissions` is the
// real flag for "Auto" - it runs every tool without asking (no separate --dangerously-skip-
// permissions needed, and no conflict with --permission-prompt-tool: claude just never prompts).
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions']);
const DEFAULT_PERMISSION_MODE = 'default';
/** Validate a proposed permission mode; returns the canonical value or null if unknown. */
const validatePermissionMode = (m) => (typeof m === 'string' && PERMISSION_MODES.has(m) ? m : null);

function acquireDaemonLock() {
	while (true) {
		try {
			writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
			
			const cleanup = () => { try { unlinkSync(LOCK_FILE); } catch {} };
			process.on('exit', cleanup);
			process.on('SIGINT', () => { cleanup(); process.exit(0); });
			process.on('SIGTERM', () => { cleanup(); process.exit(0); });
			return;
		} catch (err) {
			if (err.code === 'EEXIST') {
				try {
					const lockStr = readFileSync(LOCK_FILE, 'utf8').trim();
					const lockPid = Number(lockStr);
					
					if (!lockStr || Number.isNaN(lockPid) || lockPid <= 0) {
						const stats = statSync(LOCK_FILE);
						if (Date.now() - stats.mtimeMs < 2000) {
							console.error(`[codeout] daemon lock file is corrupted/empty but recently modified. Refusing to start to avoid race.`);
							process.exit(1);
						} else {
							unlinkSync(LOCK_FILE);
							continue;
						}
					}
					
					try {
						process.kill(lockPid, 0);
						console.error(`[codeout] daemon already running (pid ${lockPid}).`);
						process.exit(1);
					} catch (killErr) {
						if (killErr.code === 'ESRCH') {
							try { unlinkSync(LOCK_FILE); } catch {}
							continue;
						}
						throw killErr;
					}
				} catch (readErr) {
					if (readErr.code === 'ENOENT') continue;
					throw readErr;
				}
			} else {
				throw err;
			}
		}
	}
}

// Root the "+" menu discovers project folders under (override with COCKPIT_ROOT).
const ROOT = process.env.COCKPIT_ROOT || join(homedir(), 'core');

// ---- Upload directory (server-side, shared across all devices) ----
// WHERE uploaded files land on the SERVER is a daemon concern, not a per-device one, so it's
// persisted in ~/.codeout/upload-config.json as { uploadDir }. Resolution order at runtime:
//   1) the persisted uploadDir (if valid), 2) CODEOUT_UPLOADS env, 3) ~/.codeout/uploads.
// The dir is HARD-validated (validateUploadDir) before it's ever accepted: an absolute path
// that resolves UNDER the user's home dir, created 0700 if missing, confirmed writable. This
// is security-sensitive (an upload writes arbitrary bytes there), so the gate is strict.
const UPLOAD_CONFIG_FILE = join(CODEOUT_HOME, 'upload-config.json');
const DEFAULT_UPLOADS = process.env.CODEOUT_UPLOADS || join(CODEOUT_HOME, 'uploads');

/** Read the persisted uploadDir, or null if unset/unreadable. */
function readUploadConfig() {
	try {
		const cfg = JSON.parse(readFileSync(UPLOAD_CONFIG_FILE, 'utf8'));
		if (typeof cfg?.uploadDir === 'string' && cfg.uploadDir) return cfg.uploadDir;
	} catch { /* missing/corrupt → fall back */ }
	return null;
}

/** Persist the chosen uploadDir. */
function writeUploadConfig(dir) {
	mkdirSync(CODEOUT_HOME, { recursive: true, mode: 0o700 });
	writeFileSync(UPLOAD_CONFIG_FILE, JSON.stringify({ uploadDir: dir }, null, 2), { mode: 0o600 });
}

// ---- Default permission mode (server-side, owner-settable) ----
// The permission posture a NEW chat session inherits when the client doesn't pass one. Like the
// upload dir, this is a control-plane setting shared across every device (NOT a per-device
// preference), so it's persisted under ~/.codeout and changing it is owner-only. Out-of-box
// default: 'default' (the interactive ask-before-each-tool posture).
const PERMISSION_CONFIG_FILE = join(CODEOUT_HOME, 'permission-config.json');

/** Read the persisted default permission mode, or the out-of-box default if unset/unreadable. */
function readDefaultPermissionMode() {
	try {
		const cfg = JSON.parse(readFileSync(PERMISSION_CONFIG_FILE, 'utf8'));
		return validatePermissionMode(cfg?.mode) || DEFAULT_PERMISSION_MODE;
	} catch { /* missing/corrupt → out-of-box default */ }
	return DEFAULT_PERMISSION_MODE;
}

/** Persist the chosen default permission mode (assumes `mode` is already validated). */
function writeDefaultPermissionMode(mode) {
	mkdirSync(CODEOUT_HOME, { recursive: true, mode: 0o700 });
	writeFileSync(PERMISSION_CONFIG_FILE, JSON.stringify({ mode }, null, 2), { mode: 0o600 });
}

/**
 * Validate + normalize a proposed upload directory. STRICT, because a successful PUT lets a
 * paired client steer where arbitrary uploaded bytes are written on the host. Rules:
 *   - must be a non-empty string,
 *   - resolves to an ABSOLUTE path,
 *   - that path must be UNDER the user's home dir (homedir()) - the home dir itself is rejected
 *     (too broad), and anything outside home (/, /etc, /root, /usr, …) is rejected,
 *   - created recursively at 0700 if missing,
 *   - its REAL path (symlinks resolved) must STILL be under the real home dir, so a symlinked
 *     component (e.g. ~/link -> ~/.ssh) can't smuggle the upload target outside home,
 *   - confirmed writable.
 * On success returns the realpath-resolved dir (symlink-free).
 * @returns {{ ok:true, dir:string } | { ok:false, error:string }}
 */
function validateUploadDir(input) {
	if (typeof input !== 'string' || !input.trim()) return { ok: false, error: 'dir must be a non-empty string' };
	const raw = input.trim();
	// Require an already-absolute path. A relative path would resolve against the daemon's CWD
	// (unpredictable, and could land under home by accident) - reject it explicitly.
	if (!isAbsolute(raw)) return { ok: false, error: 'path must be absolute' };
	const dir = resolvePath(raw);
	const home = resolvePath(homedir());
	// Must be strictly INSIDE home (a child path), never home itself or an ancestor/sibling.
	const prefix = home.endsWith(sep) ? home : home + sep;
	if (dir === home) return { ok: false, error: 'path must be a folder inside your home directory, not the home directory itself' };
	if (!dir.startsWith(prefix)) return { ok: false, error: 'path must resolve to a folder under your home directory' };
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	} catch (e) {
		return { ok: false, error: `could not create directory: ${e?.message ?? e}` };
	}
	// Symlink defence: the LEXICAL under-home check above can be defeated by a symlinked
	// component (e.g. ~/link -> ~/.ssh, or a symlinked parent). Resolve the REAL path of both
	// the target and home, and require the resolved target to stay strictly under resolved
	// home, so an upload can never be steered out of the home tree via a symlink. realpath()
	// also follows every intermediate link, closing the "symlinked parent" hole.
	let realDir, realHome;
	try {
		realDir = realpathSync(dir);
		realHome = realpathSync(home);
	} catch (e) {
		return { ok: false, error: `could not resolve directory: ${e?.message ?? e}` };
	}
	const realPrefix = realHome.endsWith(sep) ? realHome : realHome + sep;
	if (realDir === realHome) return { ok: false, error: 'path must be a folder inside your home directory, not the home directory itself' };
	if (!realDir.startsWith(realPrefix)) return { ok: false, error: 'path must resolve to a folder under your home directory' };
	try {
		const st = statSync(realDir);
		if (!st.isDirectory()) return { ok: false, error: 'path exists but is not a directory' };
		accessSync(realDir, FS.W_OK);
	} catch (e) {
		return { ok: false, error: `directory is not writable: ${e?.message ?? e}` };
	}
	return { ok: true, dir: realDir };
}

/**
 * Resolve the live uploads directory at runtime. Prefers the persisted (and re-validated)
 * uploadDir; falls back to CODEOUT_UPLOADS / ~/.codeout/uploads (created 0700). Re-validated on
 * every call so a config that was made invalid out-of-band (e.g. dir deleted) degrades to the
 * default rather than throwing on an upload.
 */
function uploadsDir() {
	const persisted = readUploadConfig();
	if (persisted) {
		const v = validateUploadDir(persisted);
		if (v.ok) return v.dir;
	}
	try { mkdirSync(DEFAULT_UPLOADS, { recursive: true, mode: 0o700 }); } catch { /* best-effort */ }
	return DEFAULT_UPLOADS;
}

// Garbage-collect a single session's upload directory (uploadsDir()/<id>). Called when a
// session ends so a killed/exited session doesn't leave its uploaded bytes on disk forever.
// The id is validated (SAFE_ID) before any join so this can never escape the uploads root.
function removeSessionUploads(id) {
	if (!validId(id)) return;
	try { rmSync(join(uploadsDir(), id), { recursive: true, force: true }); } catch { /* best-effort */ }
}

// Best-effort sweep of upload subdirs whose owning session is no longer live. Runs once on
// startup (after sessions are restored) so uploads from sessions that didn't survive a daemon
// restart don't accumulate. Only removes entries whose name is a valid id AND has no live
// session, and never touches anything outside uploadsDir() or a live session's dir.
function sweepOrphanUploads() {
	let root;
	try { root = uploadsDir(); } catch { return; }
	let entries;
	try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
	for (const e of entries) {
		if (!e.isDirectory()) continue;
		if (!validId(e.name)) continue;        // not a session-id-shaped dir -> leave it alone
		if (sessions.has(e.name)) continue;     // live session -> keep
		try { rmSync(join(root, e.name), { recursive: true, force: true }); } catch { /* best-effort */ }
	}
}

// The new-session picker offers every immediate subdirectory of ROOT. Nothing is
// hard-coded - the daemon just lists what's actually there.
function projectDirs() {
	try {
		return readdirSync(ROOT, { withFileTypes: true })
			.filter((d) => d.isDirectory() && !d.name.startsWith('.'))
			.map((d) => d.name);
	} catch {
		return [];
	}
}

/** Project folders that exist on disk, for the new-session picker. */
function listProjects() {
	return projectDirs()
		.map((name) => ({ name, path: join(ROOT, name) }))
		.map((p) => ({ ...p, git: existsSync(join(p.path, '.git')) }));
}

/** @typedef {{ id:string, cwd:string, agent:string, name:string|null, socket:string, created:number, lastOutput?:number, pty:any, buffer:string, clients:Set<any> }} Session */
/** @type {Map<string, Session>} */
const sessions = new Map();

import { randomUUID } from 'node:crypto';

const newId = (cwd, chatMode) =>
	chatMode ? randomUUID() : `${(basename(cwd) || 'home').replace(/[^a-zA-Z0-9_-]/g, '') || 'home'}-${Math.random().toString(36).slice(2, 7)}`;

// Persist session metadata (NOT the live pty) so a restarted daemon can reattach.
function persist() {
	try {
		mkdirSync(CODEOUT_HOME, { recursive: true, mode: 0o700 });
		const meta = [...sessions.values()].map((s) => ({
			id: s.id, cwd: s.cwd, agent: s.agent, name: s.name, avatar: s.avatar ?? null, socket: s.socket, created: s.created, chatMode: s.chatMode, resumeId: s.resumeId, model: s.model, effort: s.effort, permissionMode: s.permissionMode, owner: s.owner
		}));
		writeFileSync(STATE_FILE, JSON.stringify(meta, null, 2), { mode: 0o600 });
	} catch (e) {
		console.error('[codeout] could not persist session state:', e?.message ?? e);
	}
}

// Which command a new session boots into. Everything runs in a login shell so PATH
// resolves the agent CLI; agents drop back to a shell on exit (`exec bash`), so the tab
// survives quitting the agent.
const AGENTS = new Set(['bash', 'claude']); // Gemini and Codex land here once their CLIs ship.

// A new session may only start in ROOT or one of the curated project folders
// (exactly what the picker offers) - never an arbitrary path like /etc or /root.
function allowedCwd(cwd) {
	return cwd === ROOT || projectDirs().some((name) => join(ROOT, name) === cwd);
}

// The shell inherits only a safe, minimal environment, never the daemon's full
// process.env, so host secrets (API keys, tokens) don't leak into every session.
// Agents read their own credentials from $HOME (e.g. ~/.claude).
const SAFE_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'COLORTERM', 'TMPDIR', 'TZ'];
function childEnv() {
	const env = {};
	for (const k of SAFE_ENV) if (process.env[k] != null) env[k] = process.env[k];
	for (const k of Object.keys(process.env)) if (k.startsWith('LC_')) env[k] = process.env[k];
	// `claude` installs to ~/.local/bin, which a systemd --user service's PATH omits, so
	// spawn('claude') would ENOENT. Add the usual bin dirs so the agent CLIs are findable
	// however the daemon was started.
	const parts = env.PATH ? env.PATH.split(':') : [];
	for (const p of [join(homedir(), '.local/bin'), '/usr/local/bin', '/usr/bin', '/bin']) {
		if (!parts.includes(p)) parts.push(p);
	}
	env.PATH = parts.join(':');
	return env;
}

// dtach keeps the agent alive in a detached master process; node-pty is just an
// attached client, so the agent survives a daemon restart. -E disables dtach's detach
// key (pass keys straight through); -r winch repaints a full-screen TUI (claude) on
// (re)attach via SIGWINCH. -A = create-or-attach (new session), -a = attach-only (boot).
// CHAT MODE never reaches here: it runs the managed agent backend, not a PTY. Only plain
// TERMINAL sessions build a dtach command; the sessionId is not interpolated into the
// shell on this path, and it's validated at create()/restore().
function dtachArgs(socket, agent, fresh) {
	let inner;
	if (agent === 'bash') {
		inner = 'exec bash -l';
	} else {
		inner = `${agent}; exec bash -l`;
	}
	const base = [fresh ? '-A' : '-a', socket, '-E', '-r', 'winch'];
	return fresh ? [...base, 'bash', '-l', '-c', inner] : base;
}

// Session ids are server-minted (UUID for chat, slug-rand for terminal). Validate
// defensively before any filesystem/shell use so a tampered restore file or future
// caller can never inject a path-traversal or shell metacharacter.
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;
const validId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 80 && SAFE_ID.test(id);

const ptyOpts = (cwd) => ({ name: 'xterm-256color', cols: 80, rows: 24, cwd, env: childEnv() });

// A small JSON broadcaster shared by both modes: frames any object to every client
// sink as a 0x03 frame (the sink encrypts/frames as needed).
function attachBroadcaster(s) {
	s.broadcastJson = (obj) => {
		const jbuf = Buffer.from(JSON.stringify(obj), 'utf8');
		for (const sink of s.clients) {
			try { if (sink.writeJsonRaw) sink.writeJsonRaw(jbuf); } catch { /* ignore */ }
		}
	};
}

// Broadcast a small JSON signal to EVERY connected client across ALL sessions, reusing the
// same 0x03 `writeJsonRaw` sink mechanism (the sink frames/encrypts per its transport). Used
// for global signals like `devices-updated` so every surface refetches the device list and
// re-renders bubbles after an identity edit / pair / revoke. Lightweight by design - the
// signal carries no device data; clients GET /api/devices on receipt.
function broadcastToAllSessions(obj) {
	const jbuf = Buffer.from(JSON.stringify(obj), 'utf8');
	for (const s of sessions.values()) {
		for (const sink of s.clients) {
			try { if (sink.writeJsonRaw) sink.writeJsonRaw(jbuf); } catch { /* ignore */ }
		}
	}
}

/** Signal all clients that the device list changed; they refetch GET /api/devices. */
const broadcastDevicesUpdated = () => broadcastToAllSessions({ type: 'devices-updated' });

// CHAT MODE: run the agent as a managed backend that emits NORMALIZED ChatEvents.
// No PTY, no dtach. Each ChatEvent is stamped with a monotonic per-session `seq`,
// appended to a persistent (disk-backed) bounded log, and broadcast to clients as a
// 0x03 frame { type:'chat', ev }.
//
// Multi-device input is SERIALIZED through a per-session queue + an explicit turn state
// machine: while a turn is live, incoming user messages are ENQUEUED (echoed with a
// `queued` status, never written to the agent mid-turn); each is drained into its own
// real turn on turn:end. This stops two devices from interleaving into one agent stdin.
function wireChat(s, fresh) {
	// Persistent scrollback: replays full history after a daemon restart/crash. The id is
	// server-minted + validated, so it's safe as a filename.
	s.chatLog = new PersistentChatLog(CHAT_LOG_DIR, s.id);
	attachBroadcaster(s);
	// Monotonic per-session event sequence. Persisted across restart so a reconnecting
	// client can order/gap-detect: continue past the highest seq already on disk.
	let seq = 0;
	for (const ev of s.chatLog.all()) if (typeof ev.seq === 'number' && ev.seq >= seq) seq = ev.seq + 1;

	// Emit a ChatEvent: stamp seq, persist to the (disk-backed) ring, broadcast, drive
	// activity + title. Every event the daemon emits carries a monotonic `seq`.
	const emit = (ev) => {
		if (!ev || typeof ev !== 'object') return;
		ev.seq = seq++;
		// Wall-clock stamp (epoch ms) so clients can render day/gap separators. Set once;
		// a re-emit (e.g. a queued bubble clearing, or a clientId retry re-broadcast) keeps
		// its original time only if the caller passed one — otherwise it stamps fresh here.
		if (typeof ev.ts !== 'number') ev.ts = Date.now();
		s.lastOutput = Date.now();
		s.chatLog.push(ev);
		s.broadcastJson({ type: 'chat', ev });
		maybeNotify(s, ev); // fire-and-forget push (errors swallowed inside)
		// The orchestrator watches turn boundaries to gate the input queue drain.
		if (ev.t === 'turn') onTurnEvent(ev);
	};
	s.emitChat = emit;

	const env = childEnv();
	const onResume = (id) => { s.resumeId = id; persist(); };
	// Daemon-curated built-in commands that DO work headless (handled daemon-side, not by the
	// agent). TUI-only built-ins (/compact, /agents, /help …) are intentionally omitted - they
	// have no headless behaviour. Clients merge these with the agent's plugin `commands`.
	const BUILTIN_COMMANDS = [
		{ name: 'model', description: 'Switch model' },
		{ name: 'effort', description: 'low|medium|high|xhigh|max' },
		{ name: 'mode', description: 'default|acceptEdits|plan|bypassPermissions' },
		{ name: 'clear', description: 'Start a fresh chat' }
	];
	// init carries the agent's slash-command list; relay it once so clients can offer a
	// `/` autocomplete. Re-emitted on a backend relaunch (e.g. /model) - same event, new seq.
	// `commands` is the agent's plugin/skill list; `builtins` is the daemon's curated list.
	const onSlashCommands = (commands) => {
		if (!Array.isArray(commands)) return;
		s.slashCommands = commands;
		emit({ t: 'slash-commands', commands, builtins: BUILTIN_COMMANDS });
	};

	// ----- stats / status-bar meta -----
	// Accumulated status the client renders as a top bar. Recomputed from the stream (nothing
	// special persisted): model + contextWindow from init/result, ctxTokens + costUsd from each
	// result, rateLimits kept latest-per-type. effort/model also reflect the launch params.
	const stats = {
		model: s.model || null,
		apiKeySource: null,   // from init; "none" = subscription/OAuth -> cost is notional, client hides it
		contextWindow: null,
		// Show the REAL effort. With no explicit override (no /effort), Claude runs at the user's
		// configured `effortLevel` from ~/.claude/settings.json - read it so the bar shows e.g.
		// "xhigh" rather than the unhelpful word "default".
		effort: s.effort || userDefaultEffort(),
		// Permission posture for this session (default|acceptEdits|plan|bypassPermissions). Always
		// concrete (a session always has one), so the bar can show it without a fallback word.
		permissionMode: s.permissionMode || DEFAULT_PERMISSION_MODE,
		costUsd: 0,
		ctxTokens: null,
		/** @type {Map<string,{type:string,status?:string,resetsAt?:number}>} latest per rateLimitType */
		_rl: new Map()
	};
	// Tracked on the session so kill()/relaunchBackend (outside this closure) can clear it.
	s._statsTimer = null;
	let statsDirty = false;
	// Build the wire-shape `stats` ChatEvent from the accumulator (drop the internal _rl map).
	const statsEvent = () => ({
		t: 'stats',
		model: stats.model,
		apiKeySource: stats.apiKeySource,
		contextWindow: stats.contextWindow,
		effort: stats.effort,
		permissionMode: stats.permissionMode,
		costUsd: stats.costUsd,
		ctxTokens: stats.ctxTokens,
		rateLimits: [...stats._rl.values()]
	});
	// Coalesce emits: result + rate_limit lines can arrive close together, so batch into one
	// `stats` per tick rather than spamming a frame per field. `force` flushes immediately
	// (used after a /model, /effort, or /clear so the bar updates without waiting for a turn).
	const emitStats = (force) => {
		if (force) {
			if (s._statsTimer) { clearTimeout(s._statsTimer); s._statsTimer = null; }
			statsDirty = false;
			emit(statsEvent());
			return;
		}
		statsDirty = true;
		if (s._statsTimer) return;
		s._statsTimer = setTimeout(() => { s._statsTimer = null; if (statsDirty) { statsDirty = false; emit(statsEvent()); } }, 250);
		if (s._statsTimer.unref) s._statsTimer.unref();
	};
	// Fold a raw meta blob from the claude backend into the accumulator, then schedule an emit.
	const onMeta = (meta) => {
		if (!meta || typeof meta !== 'object') return;
		if (meta.model) stats.model = meta.model;
		if (meta.apiKeySource !== undefined) stats.apiKeySource = meta.apiKeySource;
		if (typeof meta.contextWindow === 'number') stats.contextWindow = meta.contextWindow;
		if (typeof meta.ctxTokens === 'number') stats.ctxTokens = meta.ctxTokens;
		if (typeof meta.costUsd === 'number') stats.costUsd = meta.costUsd; // total_cost_usd is already cumulative
		if (meta.rateLimit && meta.rateLimit.type) stats._rl.set(meta.rateLimit.type, meta.rateLimit);
		emitStats(false);
	};
	s._emitStats = emitStats;          // so /model, /effort, /clear can force a refresh
	s._statsModel = (m) => { stats.model = m; };   // keep the bar in sync on a daemon-side model swap
	s._statsEffort = (e) => { stats.effort = e; }; // …and on an effort swap
	s._statsPermissionMode = (m) => { stats.permissionMode = m; }; // …and on a /mode swap
	s._statsReset = () => { stats.costUsd = 0; stats.ctxTokens = null; stats._rl.clear(); }; // /clear: fresh session

	// ----- input queue + turn state machine -----
	// turnLive = a backend turn is in flight (between turn:start and turn:end). A second
	// message arriving while turnLive is queued, not written to the agent.
	// A queue item carries BOTH the user's clean `text` (echoed in bubbles) and `agentText`
	// (the same text WITH any attachment paths appended under the hood, fed to the agent's
	// stdin so it can read the files) plus the `attachments` metadata re-broadcast to clients.
	let turnLive = false;
	// A /model, /effort, or /mode sent mid-turn can't change an in-flight launch flag, so it's
	// QUEUED here and applied at turn:end (params merge, so several collapse into one relaunch).
	/** @type {{ model?:string, effort?:string, permissionMode?:string, notes:string[] }|null} */
	let pendingControl = null;
	/** @type {Array<{id:string, text:string, agentText:string, attachments?:Array<object>, senderId?:string, senderName?:string}>} */
	const queue = [];
	// Events echoed with `queued:true` that still need their status cleared once submitted.
	/** @type {Array<{id:string, text:string, attachments?:Array<object>, senderId?:string, senderName?:string, clientId?:string}>} */
	const queuedEvents = [];
	// Idempotency for optimistic-send retries: a client stamps each user turn with a
	// `clientId` (its optimistic-bubble id). Resending the SAME clientId (a retry of a turn
	// the client thought was lost) must NEVER run the turn twice. We keep the last few
	// accepted clientIds -> the echo we emitted, so a retry just re-broadcasts that echo
	// (fresh seq, so a client past its high-water seq still sees it) instead of re-queuing.
	/** @type {Map<string, {id:string, text:string, senderId?:string, senderName?:string, attachments:Array<object>}>} */
	const seenClientIds = new Map();
	const SEEN_CLIENT_IDS_CAP = 512;

	// Push a user message to the agent, opening a real turn. Sends `agentText` (clean text +
	// any attachment paths) so the agent can read the files; the echoed bubble stays clean.
	// Returns false if the backend refused (e.g. process gone); the caller re-queues so the
	// message is never lost.
	const submit = (item) => {
		try {
			const ok = s.backend.send(item.agentText ?? item.text);
			if (ok) { turnLive = true; s.turnLive = true; } // backend also emits turn:start synchronously; belt + braces
			return ok;
		} catch (e) {
			emit({ t: 'error', message: 'send failed: ' + (e?.message ?? e) });
			return false;
		}
	};

	// Drain the next queued message (if idle) into a real turn. Echoes the {t:'user'}
	// event with no `queued` flag at submit time (or clears the queued one), carrying the
	// CLEAN text + attachments (never the appended paths) so the bubble shows chips.
	const drain = () => {
		if (turnLive || queue.length === 0) return;
		const item = queue.shift();
		// Find the matching already-echoed queued event (so we can flip it to submitted).
		const idx = queuedEvents.findIndex((q) => q.id === item.id);
		const qe = idx >= 0 ? queuedEvents.splice(idx, 1)[0] : null;
		const ok = submit(item);
		if (!ok) {
			// Backend refused: put it back at the head and stop draining; we'll retry on the
			// next turn:end / activity. Nothing is silently dropped.
			queue.unshift(item);
			return;
		}
		// Submitted: tell clients this message is no longer queued (status cleared).
		if (qe) emit({ t: 'user', id: qe.id, text: qe.text, senderId: qe.senderId, senderName: qe.senderName, ...(qe.attachments?.length ? { attachments: qe.attachments } : {}), ...(qe.clientId ? { clientId: qe.clientId } : {}) });
	};

	const onTurnEvent = (ev) => {
		if (ev.phase === 'start') { turnLive = true; s.turnLive = true; }
		else if (ev.phase === 'end') {
			turnLive = false; s.turnLive = false;
			// A turn ended: any still-pending permission prompts from it can never be
			// answered (the agent already moved on / was interrupted). Resolve them as
			// denied so nothing leaks and the client can stop showing a live prompt.
			failPendingPermissions('turn ended before reply');
			applyPendingControl();        // apply any /model|/effort|/mode queued mid-turn
			setImmediate(drain);
		}
	};

	// ----- tool permission gate -----
	// Tools requested by the agent are BLOCKED until a client answers. Each pending
	// request keeps its resolver (+ toolName, for allow_session) here keyed by tool id
	// (= tool_use.id, the same id the later `tool` event uses). `allow_session` adds the
	// tool name to an allow-list so the same tool isn't prompted again this session.
	/** @type {Map<string, {resolve:(decision:object)=>void, toolName:string}>} */
	const pendingPermissions = new Map();
	/** @type {Set<string>} tool names allow-listed for this session via `allow_session`. */
	const allowedTools = new Set();

	const PERMISSION_OPTIONS = [
		{ id: 'allow_once', label: 'Allow once', kind: 'allow' },
		{ id: 'allow_session', label: 'Allow for session', kind: 'allow' },
		{ id: 'deny', label: 'Deny', kind: 'reject' }
	];

	// Deny + clear every outstanding prompt (called on turn end / backend death) so the
	// agent never hangs waiting on us and clients drop any live permission UI.
	const failPendingPermissions = (reason) => {
		for (const [id, p] of pendingPermissions) {
			try { p.resolve({ behavior: 'deny', message: reason }); } catch { /* ignore */ }
			emit({ t: 'permission-resolved', id, decision: 'deny', reason });
		}
		pendingPermissions.clear();
	};
	// Exposed so kill() / relaunchBackend (outside this closure) can settle pending prompts
	// before tearing the backend down - otherwise a prompt's promise never resolves on child
	// death and the client shows a permanently-live permission gate.
	s._failPendingPermissions = failPendingPermissions;

	// Asked by the claude backend before a tool runs. Resolves to the agent's decision.
	const onPermission = (req) => {
		// Session allow-list: a prior `allow_session` for this tool → allow without prompting.
		if (allowedTools.has(req.toolName)) {
			emit({ t: 'permission-resolved', id: req.id, decision: 'allow_session', auto: true, toolName: req.toolName });
			return Promise.resolve({ behavior: 'allow' });
		}
		// Reading a file the user just ATTACHED (under THIS session's upload dir) is implicitly
		// authorized, so don't make them approve reading back a file they uploaded themselves.
		// Scoped to s.id + symlink-safe (realpath); a planted symlink falls through to the prompt.
		if (isAttachmentRead(req.toolName, req.input, s.id)) {
			emit({ t: 'permission-resolved', id: req.id, decision: 'allow_once', auto: true, toolName: req.toolName });
			return Promise.resolve({ behavior: 'allow' });
		}
		// Prompt the client(s) and block until handlePermissionReply resolves.
		return new Promise((resolve) => {
			pendingPermissions.set(req.id, { resolve, toolName: req.toolName });
			emit({ t: 'permission', id: req.id, toolName: req.toolName, input: req.input, options: PERMISSION_OPTIONS });
		});
	};

	// Route a client's permission-reply (from the 0x03 chat path) to the pending gate.
	// `decision` is an option id (allow_once | allow_session | deny). Unknown ids deny.
	s.handlePermissionReply = (id, decision) => {
		const p = pendingPermissions.get(id);
		if (!p) return; // stale / already resolved (e.g. turn ended) - ignore.
		pendingPermissions.delete(id);
		let backendDecision;
		if (decision === 'allow_once') {
			backendDecision = { behavior: 'allow' };
		} else if (decision === 'allow_session') {
			allowedTools.add(p.toolName); // don't prompt for this tool again this session
			backendDecision = { behavior: 'allow' };
		} else {
			backendDecision = { behavior: 'deny', message: 'denied by user' };
		}
		// Persist the resolution so a reconnecting client sees the gate as settled, not live.
		emit({ t: 'permission-resolved', id, decision });
		try { p.resolve(backendDecision); } catch { /* ignore */ }
	};

	if (s.agent === 'claude') {
		// Launch (or relaunch) the claude backend. `/model` tears the child down and calls
		// this again with the new model + the captured session_id, so the conversation
		// continues with the model swapped. Pulls resumeId/model off the session each time.
		s.startClaudeBackend = () => startClaudeChat({
			cwd: s.cwd, env, resumeId: s.resumeId || null, model: s.model || null, effort: s.effort || null,
			permissionMode: s.permissionMode || DEFAULT_PERMISSION_MODE, emit,
			onSessionId: onResume, onSlashCommands, onMeta, onPermission
		});
		s.backend = s.startClaudeBackend();
	} else {
		// chatMode only makes sense for an LLM agent; fall back to an error event.
		s.backend = { send: () => false, kill: () => {} };
		setImmediate(() => emit({ t: 'error', message: `chat mode unsupported for agent "${s.agent}"` }));
	}

	// ----- backend relaunch (the ONE place /model, /effort, /clear all go through) -----
	// Built-in TUI slash commands (/model, /clear, /compact, …) are NOT plugin commands and do
	// NOT function as a stream-json user message in headless `-p` (there's no interactive picker
	// to drive). So they're handled DAEMON-SIDE by tearing the claude child down and relaunching
	// it with the new flags + `--resume <session_id>` (captured at init) so the conversation
	// continues with the model/effort swapped. `/clear` instead relaunches clean (no --resume).
	//
	// Ordering is load-bearing:
	//   1) settle any pending permission prompts (their promises would never resolve once the
	//      child dies → a permanently-live gate on the client), and
	//   2) clear the coalescing stats timer (it would otherwise fire into the new backend),
	//   3) THEN kill the old backend (kill() arms its `killed` flag + drops its listeners, so
	//      a late exit/result from the dying child can't flip turnLive / drain the queue into
	//      the freshly-started child - the stdin-interleave bug), and only THEN start the new
	//      one. resetHistory drops the resume id + scrollback so the relaunch is a fresh chat.
	const relaunchBackend = ({ model, effort, permissionMode, resetHistory } = {}) => {
		if (!s.startClaudeBackend) return false;
		if (model !== undefined) s.model = model;
		if (effort !== undefined) s.effort = effort;
		if (permissionMode !== undefined) s.permissionMode = permissionMode;
		if (resetHistory) {
			// Forget the resume id so the relaunch is a brand-new claude session, and clear the
			// persisted scrollback (in-memory ring + on-disk ndJSON).
			s.resumeId = null;
			try { s.chatLog?.clear?.(); } catch { /* ignore */ }
			if (s._statsReset) s._statsReset();
		}
		// 1) settle pending prompts + 2) kill the coalescing stats timer BEFORE the child dies.
		s._failPendingPermissions?.('backend gone');
		if (s._statsTimer) { clearTimeout(s._statsTimer); s._statsTimer = null; }
		// 3) tear the old backend down (its kill() no-ops any late events), then start fresh.
		try { s.backend?.kill(); } catch { /* gone */ }
		// A relaunch is a clean break: there is no live turn on the new child.
		turnLive = false; s.turnLive = false;
		s.backend = s.startClaudeBackend();
		persist();
		return true;
	};

	// Queue a control switch (/model, /effort, /mode) attempted mid-turn; applied at turn:end by
	// applyPendingControl(). Params merge so several queued switches collapse into one relaunch.
	const queueControl = (params, note) => {
		pendingControl = { ...(pendingControl || { notes: [] }), ...params };
		pendingControl.notes = [...(pendingControl.notes || []), note];
		emit({ t: 'system', text: `${note} - applies when this reply finishes.` });
	};
	const applyPendingControl = () => {
		if (!pendingControl) return;
		const pc = pendingControl; pendingControl = null;
		relaunchBackend({ model: pc.model, effort: pc.effort, permissionMode: pc.permissionMode });
		if (pc.model !== undefined && s._statsModel) s._statsModel(pc.model);
		if (pc.effort !== undefined && s._statsEffort) s._statsEffort(pc.effort);
		if (pc.permissionMode !== undefined && s._statsPermissionMode) s._statsPermissionMode(pc.permissionMode);
		for (const n of pc.notes) emit({ t: 'system', text: n });
		if (s._emitStats) s._emitStats(true);
	};

	const switchModel = (name, senderId, senderName) => {
		const model = String(name || '').trim();
		// Echo the command as a user bubble so the transcript shows what was asked.
		emit({ t: 'user', id: evId(), text: `/model ${model}`.trim(), senderId, senderName });
		if (!model) {
			emit({ t: 'system', text: s.model ? `Current model: ${s.model}. Use /model <name> to switch.` : 'Using the default model. Use /model <name> to switch.' });
			return;
		}
		if (turnLive) { queueControl({ model }, `Model → ${model}`); return; }
		if (!relaunchBackend({ model })) {
			emit({ t: 'error', message: '/model is only available for claude chat sessions.' });
			return;
		}
		emit({ t: 'system', text: `Model switched to ${model}.` });
		// Reflect the new model in the status bar (init will also confirm it shortly).
		if (s._statsModel) s._statsModel(model);
		if (s._emitStats) s._emitStats(true);
	};

	// Built-in `/effort <level>` - real claude flag (low|medium|high|xhigh|max). Refused mid-turn
	// (a relaunch would drop the turn).
	const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
	const switchEffort = (level, senderId, senderName) => {
		const effort = String(level || '').trim().toLowerCase();
		emit({ t: 'user', id: evId(), text: `/effort ${effort}`.trim(), senderId, senderName });
		if (!effort) {
			emit({ t: 'system', text: s.effort ? `Current effort: ${s.effort}. Use /effort <low|medium|high|xhigh|max> to change.` : 'Using the default effort. Use /effort <low|medium|high|xhigh|max> to change.' });
			return;
		}
		if (!EFFORT_LEVELS.has(effort)) {
			emit({ t: 'system', text: `Unknown effort "${effort}". Choose one of: low, medium, high, xhigh, max.` });
			return;
		}
		if (turnLive) { queueControl({ effort }, `Effort → ${effort}`); return; }
		if (!relaunchBackend({ effort })) {
			emit({ t: 'error', message: '/effort is only available for claude chat sessions.' });
			return;
		}
		emit({ t: 'system', text: `Effort → ${effort}.` });
		if (s._statsEffort) s._statsEffort(effort);
		if (s._emitStats) s._emitStats(true);
	};

	// Built-in `/mode <permission-mode>` - the session's tool-permission posture
	// (default|acceptEdits|plan|bypassPermissions). Switching relaunches the backend with the new
	// --permission-mode + --resume so the conversation continues. Refused mid-turn (the relaunch
	// would drop the live turn), exactly like /model and /effort.
	const switchMode = (arg, senderId, senderName) => {
		const mode = String(arg || '').trim();
		emit({ t: 'user', id: evId(), text: `/mode ${mode}`.trim(), senderId, senderName });
		const cur = s.permissionMode || DEFAULT_PERMISSION_MODE;
		if (!mode) {
			emit({ t: 'system', text: `Current permission mode: ${cur}. Use /mode <default|acceptEdits|plan|bypassPermissions> to change.` });
			return;
		}
		if (!validatePermissionMode(mode)) {
			emit({ t: 'system', text: `Unknown permission mode "${mode}". Choose one of: default, acceptEdits, plan, bypassPermissions.` });
			return;
		}
		if (turnLive) { queueControl({ permissionMode: mode }, `Permission mode → ${mode}`); return; }
		if (!relaunchBackend({ permissionMode: mode })) {
			emit({ t: 'error', message: '/mode is only available for claude chat sessions.' });
			return;
		}
		emit({ t: 'system', text: `Permission mode → ${mode}.` });
		if (s._statsPermissionMode) s._statsPermissionMode(mode);
		if (s._emitStats) s._emitStats(true);
	};

	// Built-in `/clear` - start a FRESH chat. The session RECORD survives (same id/cwd/agent) so
	// the tab and pairing stay valid; only its conversation is wiped (resetHistory).
	const clearChat = (senderId, senderName) => {
		if (turnLive) {
			emit({ t: 'system', text: 'Busy. Finish or wait for the current turn, then /clear again.' });
			return;
		}
		if (!s.startClaudeBackend) {
			emit({ t: 'error', message: '/clear is only available for claude chat sessions.' });
			return;
		}
		// relaunchBackend(resetHistory) drops the resume id + wipes scrollback (RAM ring +
		// on-disk ndJSON) and tears the child down before starting clean. Then signal clients
		// to reset their transcript - emitted AFTER the wipe so `chat-cleared` is the first
		// event in the fresh log (not written then immediately truncated).
		relaunchBackend({ resetHistory: true });
		emit({ t: 'chat-cleared' });
		emit({ t: 'system', text: 'Started a fresh chat.' });
		if (s._emitStats) s._emitStats(true);
	};

	// Sanitize a client-supplied attachments array to the wire shape {name,path,size,type}.
	// Drops anything malformed; returns [] if nothing usable. The paths SHOULD originate from the
	// daemon's own upload handler, but the client controls this field, so we validate defensively:
	//   - strip control chars from name + path (they get spliced into `[Attached files: <path>]`
	//     which is fed to the agent's stdin, where a newline/escape could inject extra text),
	//   - require each path to resolve UNDER this session's upload dir (uploadsDir()/<id>); a path
	//     pointing anywhere else (../, /etc/..., another session) is dropped, so the under-the-hood
	//     "[Attached files: ...]" line can never hand the agent an arbitrary host path to read.
	const stripCtrl = (str) => str.replace(/[\u0000-\u001f\u007f]/g, '');
	const sanitizeAttachments = (att) => {
		if (!Array.isArray(att)) return [];
		const out = [];
		let scope;
		try { scope = resolvePath(join(uploadsDir(), s.id)); } catch { return []; }
		for (const a of att.slice(0, 20)) {
			if (!a || typeof a !== 'object') continue;
			const name = typeof a.name === 'string' ? stripCtrl(a.name).slice(0, 256) : '';
			const rawPath = typeof a.path === 'string' ? stripCtrl(a.path) : '';
			if (!rawPath) continue;
			// Must resolve strictly under this session's upload dir (lexical: collapses ../).
			let resolved;
			try { resolved = resolvePath(rawPath); } catch { continue; }
			if (resolved !== scope && !resolved.startsWith(scope + sep)) continue;
			out.push({
				name: name || basename(resolved),
				path: resolved,
				size: Number.isFinite(a.size) ? a.size : 0,
				type: typeof a.type === 'string' ? stripCtrl(a.type).slice(0, 128) : 'application/octet-stream'
			});
		}
		return out;
	};

	// Route a user turn from a client. ENQUEUE it (so concurrent devices serialize) and
	// echo a {t:'user'} event with `queued:true` while it waits; drain submits it into a
	// real turn and re-emits the same id WITHOUT `queued`. Never written to the agent mid-turn.
	// `attachments` (optional) are uploaded-file refs: the CLEAN text is echoed in the bubble
	// (with attachment chips) while the agent receives the text WITH the file paths appended so
	// it can read them.
	s.handleUserInput = (text, senderId, senderName, attachments, clientId) => {
		const clean = String(text == null ? '' : text).replace(/[\r\n]+$/, '');
		const atts = sanitizeAttachments(attachments);
		// Require either text or at least one attachment (an attachments-only turn is allowed).
		if (!clean.trim() && atts.length === 0) return;
		const cid = typeof clientId === 'string' && clientId ? clientId.slice(0, 128) : null;
		// Retry of a turn we already accepted: re-broadcast the original echo (fresh seq so a
		// client past its high-water mark still receives it) and STOP. The turn is never
		// enqueued or sent to the agent twice — this is the idempotency guarantee for retries.
		if (cid) {
			const prev = seenClientIds.get(cid);
			if (prev) {
				// A normal turn re-broadcasts its echo; a built-in (recorded as a dedup-only
				// sentinel with no `id`) just returns so a retried /model|/clear can't re-run.
				if (prev.id) emit({ t: 'user', id: prev.id, clientId: cid, text: prev.text, senderId: prev.senderId, senderName: prev.senderName, ...(prev.attachments.length ? { attachments: prev.attachments } : {}) });
				return;
			}
		}
		// Intercept the daemon-handled built-ins before they reach the agent (handled above).
		// Built-ins only apply to claude chat; for other agents they fall through as plain text.
		// (Slash built-ins never carry attachments - they're typed commands.)
		if (s.agent === 'claude' && atts.length === 0) {
			// Record the clientId BEFORE running a built-in so a retry is deduped (built-ins emit
			// their own user echo + relaunch; re-running would double-relaunch / re-wipe).
			if (cid && /^\/(model|effort|mode|clear)(\s|$)/.test(clean)) {
				seenClientIds.set(cid, { id: null });
				if (seenClientIds.size > SEEN_CLIENT_IDS_CAP) seenClientIds.delete(seenClientIds.keys().next().value);
			}
			const mm = clean.match(/^\/model(?:\s+(.+))?$/);
			if (mm) { switchModel(mm[1] || '', senderId, senderName); return; }
			const em = clean.match(/^\/effort(?:\s+(.+))?$/);
			if (em) { switchEffort(em[1] || '', senderId, senderName); return; }
			const pm = clean.match(/^\/mode(?:\s+(.+))?$/);
			if (pm) { switchMode(pm[1] || '', senderId, senderName); return; }
			if (/^\/clear\s*$/.test(clean)) { clearChat(senderId, senderName); return; }
		}
		// What the AGENT receives: the user's text with the file paths appended under the hood,
		// so Claude can open them. The user's BUBBLE shows only `clean` + chips, never the paths.
		const agentText = atts.length
			? `${clean}${clean ? '\n\n' : ''}[Attached files: ${atts.map((a) => a.path).join(', ')}]`
			: clean;
		const id = evId();
		const willQueue = turnLive || queue.length > 0;
		const attField = atts.length ? { attachments: atts } : {};
		const cidField = cid ? { clientId: cid } : {};
		// Remember this clientId -> echo so a later retry re-broadcasts it instead of re-running.
		if (cid) {
			seenClientIds.set(cid, { id, text: clean, senderId, senderName, attachments: atts });
			if (seenClientIds.size > SEEN_CLIENT_IDS_CAP) seenClientIds.delete(seenClientIds.keys().next().value);
		}
		// Echo the bubble. If it can't go straight to the agent, mark it queued so the UI
		// shows it as pending (status clears when it actually submits).
		emit({ t: 'user', id, text: clean, senderId, senderName, ...attField, ...cidField, ...(willQueue ? { queued: true } : {}) });
		queue.push({ id, text: clean, agentText, attachments: atts, senderId, senderName });
		// Only events echoed as queued need a follow-up "cleared" emit when they submit.
		if (willQueue) queuedEvents.push({ id, text: clean, attachments: atts, senderId, senderName, ...(cid ? { clientId: cid } : {}) });
		drain();
	};

	// Stop the in-flight turn (the composer's Stop button). The bare CLI exposes no soft
	// interrupt, so we abort by tearing the backend down and relaunching it with --resume
	// (the conversation is preserved; whatever already streamed stays in the chat). Then we
	// emit turn:end so clients clear the "working" state and any queued message drains into
	// the fresh child. No-op if nothing is running.
	s.handleInterrupt = () => {
		if (!s.turnLive) return;
		if (s.resumeId) {
			// Fold any /model|/effort|/mode queued mid-turn into THIS relaunch (applyPendingControl
			// does the kill+resume itself + clears pendingControl), so Stop doesn't spawn the backend
			// twice — the turn:end below would otherwise apply it as a second relaunch.
			if (pendingControl) applyPendingControl();
			else relaunchBackend();              // kill the generating child + --resume; clears turnLive
			emit({ t: 'system', text: 'Stopped.' });
		} else {
			// Stopped before claude returned a session id (the brief boot window before the
			// `init` line) - there is nothing to --resume. Reset cleanly: a plain relaunch here
			// would spin up a fresh, empty-context child while the chat log still showed the
			// just-started message, silently discarding it. resetHistory keeps display + child in sync.
			pendingControl = null;               // a queued switch on a discarded boot turn is moot
			relaunchBackend({ resetHistory: true });
			emit({ t: 'system', text: 'Stopped before the reply started, nothing was saved yet. Send your message again.' });
		}
		emit({ t: 'turn', phase: 'end' });       // clear clients' spinner + drain the queue
	};

	return s;
}

// TERMINAL MODE: unchanged. A fresh node-pty (dtach client) wired for raw I/O.
function wireTerminal(s, fresh) {
	const pty = spawn('dtach', dtachArgs(s.socket, s.agent, fresh), ptyOpts(s.cwd));
	s.pty = pty;
	s.buffer = [];
	let bufSize = 0;
	attachBroadcaster(s);

	pty.onData((d) => {
		s.lastOutput = Date.now(); // activity signal for the sessions list (working vs idle)
		let b = Buffer.from(d);
		if (b.length > MAX_BUFFER) b = b.subarray(-MAX_BUFFER);
		s.buffer.push(b);
		bufSize += b.length;
		while (bufSize > MAX_BUFFER) {
			const shifted = s.buffer.shift();
			bufSize -= shifted.length;
		}

		// Each client is a "sink" (plaintext or per-connection-encrypted) owned by pty-bridge,
		// which frames/encrypts as needed. Synchronous loop so secretstream order is preserved.
		for (const sink of s.clients) {
			try { sink.write(d); } catch (e) { /* ignore */ }
		}
	});

	// The client only exits at runtime when the agent really ended or was killed, or a
	// reattach hit a dead/stale socket - all cases mean "gone". (A daemon restart kills
	// the client too, but the process is exiting then, so the map is discarded anyway.)
	pty.onExit(() => {
		try { if (existsSync(s.socket)) unlinkSync(s.socket); } catch { /* ignore */ }
		for (const sink of s.clients) {
			try { sink.close(1000, 'exited'); } catch { /* closed */ }
		}
		sessions.delete(s.id);
		removeSessionUploads(s.id); // GC this session's uploaded files now that it's gone
		persist();
	});
	return s;
}

// Dispatch: chat sessions get the managed backend, terminal sessions get PTY + dtach.
function wire(s, fresh) {
	return s.chatMode ? wireChat(s, fresh) : wireTerminal(s, fresh);
}

// Push a notification on an agent reply (turn end), a permission prompt, or a teammate's
// message. Pushes to ALL devices that have a token; the iOS client suppresses the banner for
// the session it is actively viewing, so the daemon needn't track which device sees what. APNs
// is the only Apple cloud piece, so the alert text (a short reply/message snippet) transits it.
// Fire-and-forget: the whole body is wrapped so a slow or failing APNs call never stalls the
// chat emit or surfaces an unhandled rejection.
async function maybeNotify(s, ev) {
	try {
		if (!apnsEnabled() || !s.chatMode) return;
		// Accumulate this turn's TOP-LEVEL assistant text (skip subagent output) for the snippet.
		if (ev.t === 'text' && ev.text && !ev.parent) s._lastText = ((s._lastText || '') + ev.text).slice(-400);

		const label = s.name || basename(s.cwd) || 'codeout';
		let title, body, kind, exclude;
		if (ev.t === 'permission') {
			title = label; body = `Approve ${ev.toolName || 'a tool'}?`; kind = 'permission';
		} else if (ev.t === 'turn' && ev.phase === 'end') {
			const snip = (s._lastText || '').trim(); s._lastText = '';
			if (!snip) return; // tool-only turn: nothing to say
			title = label; body = snip.length > 160 ? snip.slice(0, 157) + '…' : snip; kind = 'reply';
		} else if (ev.t === 'user' && ev.senderId) {
			title = label; body = `${ev.senderName || 'Someone'}: ${ev.text || '(attachment)'}`; kind = 'message'; exclude = ev.senderId;
		} else {
			return;
		}

		for (const t of pushTargets(exclude)) {
			const r = await sendPush(t.token, {
				title, body, sessionId: s.id, kind, env: t.env, priority: 10,
				collapseId: kind === 'reply' ? s.id : undefined // coalesce rapid replies per session
			});
			if (r && r.remove) clearDevicePush(t.id); // dead token: drop it
			else if (r && r.ok && r.env && r.env !== t.env) setDevicePush(t.id, t.token, r.env); // remember the working env
		}
	} catch (e) {
		console.error('[codeout] push notify failed:', e?.message ?? e);
	}
}

/**
 * A 429-tagged error so the API layer can map an over-budget create to HTTP 429.
 * Anything else thrown from create() stays a 400 (bad request).
 */
class BudgetError extends Error { constructor(msg) { super(msg); this.code = 'EBUDGET'; } }

/** Live sessions created by `creatorId` (owner token counts as 'owner'). */
function liveSessionsForCreator(creatorId) {
	let n = 0;
	for (const s of sessions.values()) if (s.owner === creatorId) n++;
	return n;
}

/**
 * Enforce the session-creation budget for `creatorId` (a device id, or 'owner'). Throws a
 * BudgetError (→ 429) when over the total cap, the per-device cap, or the per-device rate.
 * Records the timestamp on success so the rolling-window rate limit accounts for this create.
 */
function enforceCreateBudget(creatorId) {
	if (sessions.size >= MAX_TOTAL_SESSIONS) throw new BudgetError(`session limit reached (${MAX_TOTAL_SESSIONS})`);
	if (liveSessionsForCreator(creatorId) >= MAX_SESSIONS_PER_DEVICE) throw new BudgetError(`per-device session limit reached (${MAX_SESSIONS_PER_DEVICE})`);
	const now = Date.now();
	const times = (createTimes.get(creatorId) || []).filter((t) => now - t < CREATE_RATE_WINDOW_MS);
	if (times.length >= CREATE_RATE_MAX) throw new BudgetError('creating sessions too fast; slow down and retry shortly');
	times.push(now);
	createTimes.set(creatorId, times);
}

/** Spawn a new session in `cwd`, booting into `agent` (bash | claude). `creatorId` is
 *  the requesting device id (or 'owner') for the create budget + per-device accounting.
 *  `name` defaults to the MODE ("Chat" / "Terminal") so a new tab has a stable label
 *  immediately (no model round-trip); an explicitly-passed name still wins. */
export function create(cwd = ROOT, agent = 'bash', chatMode = false, creatorId = 'owner', name = null, permissionMode = null) {
	if (!allowedCwd(cwd)) throw new Error('cwd is not in the allowed project list');
	if (!existsSync(cwd)) throw new Error('cwd does not exist');
	const a = AGENTS.has(agent) ? agent : 'bash';
	// Budget check is LAST among the cheap guards (after cwd/agent validation) but BEFORE we
	// spend a slug + spawn anything, so an over-budget request costs nothing.
	enforceCreateBudget(creatorId);
	const id = newId(cwd, chatMode);
	if (!validId(id)) throw new Error('generated session id is invalid'); // belt + braces
	mkdirSync(SOCKET_DIR, { recursive: true, mode: 0o700 });
	// The new session's permission posture: an explicit (validated) body value wins; otherwise it
	// inherits the owner-set default. An unknown body value is rejected (not silently coerced).
	if (permissionMode != null && !validatePermissionMode(permissionMode)) throw new Error('invalid permissionMode');
	const permMode = validatePermissionMode(permissionMode) || readDefaultPermissionMode();
	/** @type {Session} */
	const s = { id, cwd, agent: a, name: name || (chatMode ? 'Chat' : 'Terminal'), avatar: null, socket: join(SOCKET_DIR, id), created: Date.now(), pty: null, buffer: [], clients: new Set(), chatMode: !!chatMode, permissionMode: permMode, owner: creatorId };
	wire(s, true);
	sessions.set(id, s);
	persist();
	return { id, cwd, agent: a, created: s.created, chatMode: s.chatMode, permissionMode: s.permissionMode };
}

/**
 * On daemon boot, restore sessions. TERMINAL sessions reattach to a still-live dtach
 * socket (master gone → drop). CHAT sessions have no PTY/socket: they restart the
 * managed backend with --resume <resumeId> so the conversation continues, and history
 * replays from the stored ChatEvent log (which is rebuilt as the agent reruns; older
 * events from before the restart are gone, which is acceptable - the contract allows a
 * bounded ring). A chat session only restores if it has a resumeId to resume.
 */
export function restoreSessions() {
	acquireDaemonLock();
	let meta = [];
	try { meta = JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return; }
	let n = 0;
	for (const m of Array.isArray(meta) ? meta : []) {
		if (!m?.id || !validId(m.id)) continue; // tampered/invalid id → skip
		if (m.chatMode) {
			// Restore a chat tab if it has a resumeId (resume the conversation) OR a name
			// (a NAMED tab the user kept - e.g. one that was /clear'd, or named-but-not-yet-sent).
			// Without the name check, a /clear'd named tab vanishes on a daemon restart because
			// /clear nulls resumeId; relaunch it clean (null resumeId → fresh claude session).
			if (!m.resumeId && !(typeof m.name === 'string' && m.name.trim())) continue;
			/** @type {Session} */
			const s = { id: m.id, cwd: m.cwd, agent: m.agent, name: m.name ?? null, avatar: m.avatar ?? null, socket: m.socket, created: m.created, pty: null, buffer: [], clients: new Set(), chatMode: true, resumeId: m.resumeId ?? null, model: m.model ?? null, effort: m.effort ?? null, permissionMode: validatePermissionMode(m.permissionMode) || readDefaultPermissionMode(), owner: m.owner ?? 'owner' };
			try { wire(s, false); sessions.set(s.id, s); n++; } catch { /* skip */ }
			continue;
		}
		if (!m?.socket || !existsSync(m.socket)) continue; // dtach master gone → skip
		/** @type {Session} */
		const s = { id: m.id, cwd: m.cwd, agent: m.agent, name: m.name ?? null, avatar: m.avatar ?? null, socket: m.socket, created: m.created, pty: null, buffer: [], clients: new Set(), chatMode: false, owner: m.owner ?? 'owner' };
		try { wire(s, false); sessions.set(s.id, s); n++; } catch { /* stale → skip */ }
	}
	persist();
	if (n) console.log(`[codeout] reattached ${n} session(s) after restart`);
	// Sweep upload dirs whose owning session didn't survive the restart (now that the live
	// session map is populated, anything not in it is an orphan). Best-effort, never throws.
	try { sweepOrphanUploads(); } catch { /* best-effort */ }
}

export const list = () =>
	[...sessions.values()]
		.map((s) => ({ id: s.id, cwd: s.cwd, agent: s.agent, name: s.name ?? null, avatar: s.avatar ?? null, created: s.created, idleMs: Date.now() - (s.lastOutput || s.created), chatMode: !!s.chatMode, permissionMode: s.permissionMode ?? null, working: !!s.turnLive }))
		.sort((a, b) => a.created - b.created);

export const get = (id) => sessions.get(id);

export function kill(id) {
	const s = sessions.get(id);
	if (!s) return false;
	if (s.chatMode) {
		// Settle any pending permission prompts BEFORE the backend dies - otherwise the
		// prompt's promise never resolves and the client shows a permanently-live gate.
		try { s._failPendingPermissions?.('backend gone'); } catch { /* ignore */ }
		// Clear the coalescing stats timer so it can't fire after teardown.
		if (s._statsTimer) { try { clearTimeout(s._statsTimer); } catch { /* ignore */ } s._statsTimer = null; }
		// Tear down the managed chat backend (the agent child).
		try { s.backend?.kill(); } catch { /* gone */ }
		// Close every connected client sink (mirror the terminal onExit path) so clients
		// don't hang on a half-open socket after the session is gone.
		for (const sink of s.clients) {
			try { sink.close(1000, 'killed'); } catch { /* closed */ }
		}
		s.clients.clear();
		// Drop the persisted scrollback - a killed session is gone, don't leave it to replay.
		try { const f = join(CHAT_LOG_DIR, `${s.id}.jsonl`); if (existsSync(f)) unlinkSync(f); } catch { /* ignore */ }
		sessions.delete(id);
		removeSessionUploads(id); // GC this session's uploaded files
		persist();
		return true;
	}
	// Terminal: kill the dtach master (its argv carries the unique socket path) so the
	// agent actually ends - not just our client. onExit then unlinks the socket + drops it.
	try { execFileSync('pkill', ['-f', '--', s.socket]); } catch { /* nothing matched */ }
	try { s.pty?.kill(); } catch { /* gone */ }
	try { if (existsSync(s.socket)) unlinkSync(s.socket); } catch { /* ignore */ }
	sessions.delete(id);
	removeSessionUploads(id); // GC this session's uploaded files (onExit also GCs; idempotent)
	persist();
	return true;
}

/** Rename a session's tab (empty/blank clears back to the folder name). */
export function rename(id, name) {
	const s = sessions.get(id);
	if (!s) return false;
	s.name = typeof name === 'string' && name.trim() ? name.trim().slice(0, 40) : null;
	persist();
	if (s.broadcastJson) s.broadcastJson({ type: 'rename', name: s.name, avatar: s.avatar ?? null });
	return true;
}

/** Set a session's round avatar (a validated raster data-URL, or null to clear). Persists
 *  and broadcasts on the session's existing per-session signal alongside the name. The caller
 *  must validate `dataUrl` with isValidAvatar (or pass null) before calling. */
export function setSessionAvatar(id, dataUrl) {
	const s = sessions.get(id);
	if (!s) return false;
	s.avatar = dataUrl || null;
	persist();
	if (s.broadcastJson) s.broadcastJson({ type: 'rename', name: s.name, avatar: s.avatar ?? null });
	return true;
}

// Best-effort MIME from a filename extension. Covers the accept-list the composer offers
// (images, pdf, common text/code, archives). Unknown extensions fall back to a generic type.
const MIME_BY_EXT = {
	'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
	'.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.avif': 'image/avif',
	'.heic': 'image/heic', '.ico': 'image/x-icon',
	'.pdf': 'application/pdf',
	'.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
	'.json': 'application/json', '.xml': 'application/xml', '.yaml': 'text/yaml', '.yml': 'text/yaml',
	'.js': 'text/javascript', '.ts': 'text/plain', '.html': 'text/html', '.css': 'text/css',
	'.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
	'.log': 'text/plain'
};
/** @param {string} name */
function mimeFromName(name) {
	return MIME_BY_EXT[extname(name || '').toLowerCase()] || 'application/octet-stream';
}

// Content-types the serve endpoint is allowed to render INLINE in the browser: only raster
// images the UI shows as thumbnails, plus pdf. Anything else (html, svg, js, css, text, and so on) is
// served as a download (Content-Disposition: attachment) with a non-renderable content-type, so
// a malicious upload (e.g. an .html or .svg with script) can never execute in the app's origin.
const INLINE_RENDERABLE = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf']);

/** Stream a multipart upload to uploadsDir()/<id>/ and return file metadata. In CHAT mode it
 *  does NOT auto-inject a message - the user's next turn carries the refs. In TERMINAL mode it
 *  keeps typing the paths into the PTY (no auto-submit). Returns { files:[{name,path,size,type}] }. */
// A read-type tool whose target file lives under THIS session's upload dir is reading a file
// the user just ATTACHED (implicitly authorized), so the permission gate auto-allows it (no
// prompt to read back a file the user uploaded themselves). Bash/Write still prompt as normal.
//
// SYMLINK-SAFE: a lexical startsWith check is symlink-blind, so a symlink planted under the
// upload dir could let an auto-allowed Read follow it out of the upload tree with no prompt.
// So we realpath() BOTH the candidate file and the upload dir and require the REAL file path
// to be strictly under the REAL upload dir. If realpath throws (dangling/broken symlink, or
// the target doesn't exist) we do NOT auto-allow: return false and fall through to the normal
// permission prompt. Scope is the CURRENT session's dir (uploadsDir()/<sessionId>) when a
// session id is known, so one session can't auto-read another session's uploads either.
const READ_TOOLS = new Set(['Read', 'NotebookRead']);
function isAttachmentRead(toolName, input, sessionId) {
	if (!READ_TOOLS.has(toolName)) return false;
	const fp = input && (input.file_path || input.path || input.notebook_path);
	if (typeof fp !== 'string' || !fp) return false;
	try {
		// Scope to this session's upload dir if we have a (validated) id, else the whole root.
		const scope = (typeof sessionId === 'string' && SAFE_ID.test(sessionId))
			? join(uploadsDir(), sessionId)
			: uploadsDir();
		// realpath resolves every symlinked component. Throws if any component is missing or the
		// link is dangling), in which case this is NOT a clean attachment read, so don't auto-allow.
		const root = realpathSync(scope);
		const p = realpathSync(fp);
		return p === root || p.startsWith(root + sep);
	} catch { return false; }
}

function handleUpload(req, res, id, cors) {
	let sent = false;
	const done = (code, obj) => {
		if (sent) return; // a write error + a busboy error can both call done() -> double res.end crash
		sent = true;
		res.writeHead(code, { 'content-type': 'application/json', ...cors });
		res.end(JSON.stringify(obj));
	};
	id = basename(id); // defence-in-depth: never let the id escape the uploads root via traversal
	const session = get(id);
	if (!session) return done(404, { error: 'no such session' });
	const dir = join(uploadsDir(), id);
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	} catch (e) {
		return done(500, { error: String(e?.message ?? e) });
	}
	let bb;
	try {
		bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_UPLOAD, files: MAX_UPLOAD_FILES, fields: MAX_UPLOAD_FIELDS } });
	} catch (e) {
		return done(400, { error: String(e?.message ?? e) });
	}
	// Each entry: { name (original), path (on disk), dest, type, tooBig }. size is read post-write.
	const files = [];
	const pending = [];
	// Per-file cleanup: unlink one written file (used for an over-limit offender or full teardown).
	const unlinkOne = (f) => { try { if (existsSync(f.dest)) unlinkSync(f.dest); } catch { /* ignore */ } };
	// Best-effort cleanup of every partial/garbage file written so far (abort / fatal error).
	const cleanupSaved = () => { for (const f of files) unlinkOne(f); };
	bb.on('file', (_field, file, info) => {
		const origName = info.filename || 'file';
		const safe = `${Date.now()}-${origName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
		const dest = join(dir, safe);
		const entry = { name: origName, path: dest, dest, type: mimeFromName(origName), tooBig: false };
		files.push(entry);
		file.on('limit', () => { entry.tooBig = true; }); // exceeded MAX_UPLOAD -> drop just this file
		pending.push(
			new Promise((resolve) => {
				const w = createWriteStream(dest);
				// On a write-stream error, unpipe + resume the SOURCE so it drains rather than stalling
				// the whole multipart parse, mark the file failed, and resolve (don't reject; one bad
				// file shouldn't 500 the batch; it's dropped from the result + unlinked below).
				w.on('error', () => { try { file.unpipe(w); } catch {} try { file.resume(); } catch {} entry.failed = true; resolve(); });
				w.on('close', resolve);
				file.pipe(w);
			})
		);
	});
	// Client aborted (closed the connection mid-upload): destroy the parser + unlink partials.
	const onAbort = () => { try { req.unpipe(bb); } catch {} try { bb.destroy(); } catch {} cleanupSaved(); done(499, { error: 'upload aborted' }); };
	req.on('aborted', onAbort);
	req.on('error', onAbort);
	bb.on('error', (e) => { cleanupSaved(); done(500, { error: String(e?.message ?? e) }); });
	bb.on('close', async () => {
		try {
			await Promise.all(pending);
		} catch (e) {
			cleanupSaved();
			return done(500, { error: String(e?.message ?? e) });
		}
		// Per-file handling: drop any file that hit the size cap (unlink its truncated partial) or
		// failed to write; keep the good ones. This way one oversized file in a batch no longer
		// nukes the whole upload; only the offender is rejected.
		const good = [];
		let rejected = 0;
		for (const f of files) {
			if (f.tooBig || f.failed) { unlinkOne(f); rejected++; continue; }
			good.push(f);
		}
		// Read final sizes; build the metadata array the client renders chips/thumbnails from.
		const meta = good.map((f) => {
			let size = 0;
			try { size = statSync(f.dest).size; } catch { /* gone? leave 0 */ }
			return { name: f.name, path: f.dest, size, type: f.type };
		});
		// CHAT mode: do NOT auto-inject an "Uploaded N files" message - the user's next message
		// carries the attachment refs (handleUserInput appends the paths under the hood). TERMINAL
		// mode keeps the old behaviour: type the paths into the PTY (no auto-submit).
		if (meta.length && !session.chatMode && session.pty) {
			const noun = meta.length === 1 ? 'file' : 'files';
			session.pty.write(`Uploaded ${meta.length} ${noun}: ${meta.map((m) => m.path).join(' ')} `);
		}
		// All files rejected (e.g. a single oversized file) -> 413 so the client surfaces it; a
		// partial batch returns 200 with the good files + a `rejected` count the UI can note.
		if (!meta.length && rejected) return done(413, { error: `file exceeds ${MAX_UPLOAD}-byte limit`, rejected });
		done(200, { files: meta, ...(rejected ? { rejected } : {}) });
	});
	req.pipe(bb);
}

/** Serve a previously uploaded file so clients can render image thumbnails. Validates the id +
 *  name (basename only, no traversal) and confirms the file exists under uploadsDir()/<id>/.
 *  Streams with a best-effort Content-Type from the extension. */
function handleUploadGet(req, res, id, name, cors) {
	const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json', ...cors }); res.end(JSON.stringify(obj)); };
	const safeId = basename(String(id));
	const safeName = basename(String(name));
	if (!safeId || !safeName) return send(400, { error: 'bad path' });
	// basename('..') is still '..', so require a strict charset on id/name too: that keeps a
	// crafted path from joining its way out of the uploads dir into the rest of the home tree.
	if (!/^[A-Za-z0-9_-]+$/.test(safeId) || !/^[A-Za-z0-9._-]+$/.test(safeName)) return send(400, { error: 'bad path' });
	const root = resolvePath(uploadsDir());
	const file = resolvePath(join(root, safeId), safeName);
	// Defence-in-depth: the resolved file must sit under the uploads ROOT. Check the root, not
	// the per-id dir (which is itself derived from the client-supplied id, so can't be trusted).
	if (!file.startsWith(root + sep)) return send(400, { error: 'bad path' });
	let st;
	try { st = statSync(file); } catch { return send(404, { error: 'not found' }); }
	if (!st.isFile()) return send(404, { error: 'not found' });
	// Content-type safety. nosniff stops the browser from MIME-sniffing past our declared type.
	// Only allow-listed raster images + pdf render inline; everything else is forced to download
	// as application/octet-stream so a served .html/.svg can never render/execute in-page.
	const declared = mimeFromName(safeName);
	const inline = INLINE_RENDERABLE.has(declared);
	const headers = {
		'content-type': inline ? declared : 'application/octet-stream',
		'content-length': st.size,
		'cache-control': 'private, max-age=3600',
		'x-content-type-options': 'nosniff',
		'content-disposition': inline ? `inline; filename="${safeName}"` : `attachment; filename="${safeName}"`,
		...cors
	};
	res.writeHead(200, headers);
	// Stream with explicit lifecycle so a client disconnect doesn't leak the file descriptor:
	// destroy the read stream on res 'close', and fail clean on a read error.
	const rs = createReadStream(file);
	res.on('close', () => rs.destroy());
	rs.on('error', () => { if (!res.headersSent) res.writeHead(500, cors); res.end(); });
	rs.pipe(res);
}

const readJson = (req) =>
	new Promise((resolve) => {
		let b = '';
		req.on('data', (c) => {
			b += c;
			if (b.length > 1024 * 1024) { req.destroy(); resolve({}); }
		});
		req.on('end', () => {
			try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); }
		});
	});

/** Bootstrap pairing: a new device POSTs {devicePk, code, name}; gated by the one-time
 * code (the device has no token yet). Registers the device + mints a 32-byte token. */
async function handlePair(req, res, send) {
	await initCrypto();
	const body = await readJson(req);
	const devicePk = typeof body.devicePk === 'string' ? body.devicePk : '';
	// a crypto_kx public key is 32 bytes -> 43 base64url chars (no padding)
	if (!/^[A-Za-z0-9_-]{43}$/.test(devicePk)) return send(400, { error: 'bad devicePk' });
	if (!consumePairCode(typeof body.code === 'string' ? body.code : '')) {
		return send(403, { error: 'bad or expired pairing code' });
	}
	const id = registerDevice(devicePk, body.name);
	const token = mintDeviceToken(devicePk, body.name);
	// daemonPk + fingerprint so a device that PAIRED BY TYPED CODE (no QR) can still derive
	// session keys and show the fingerprint. The public key is not secret (it's in the QR too).
	send(200, { token, id, daemonPk: daemonPublicKeyB64(), fingerprint: daemonFingerprint() });
	// A new device joined the list - tell every connected client to refetch + re-render.
	broadcastDevicesUpdated();
}

/**
 * Plain http(s) handler for the session API. Returns true if it handled the
 * request. Wired into both the Vite dev server and prod server.js so it shares
 * this module's single in-memory session map with the WebSocket bridge.
 */
export async function handleApi(req, res) {
	const url = new URL(req.url, 'http://localhost');
	if (!url.pathname.startsWith('/api/')) return false;
	// CORS so the hosted web client (app.codeout.dev) can call a daemon cross-origin.
	// The origin is only echoed when originOk passes; the token is still the real gate.
	const origin = req.headers?.origin;
	const allowed = originOk(req);
	const cors = origin && allowed
		? {
			'access-control-allow-origin': origin,
			'access-control-allow-headers': 'authorization, content-type',
			'access-control-allow-methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
			'vary': 'origin'
		}
		: {};
	const send = (code, obj) => {
		res.writeHead(code, { 'content-type': 'application/json', ...cors });
		res.end(JSON.stringify(obj));
	};
	// Auth + Origin gate on every API call (the token is the real gate; Origin is
	// defence-in-depth against cross-site requests). Applies to uploads too.
	if (!allowed) {
		send(403, { error: 'forbidden origin' });
		return true;
	}
	if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return true; }
	// /api/pair is the unauthenticated bootstrap - gated by the one-time pairing code, not a token.
	if (req.method === 'POST' && url.pathname === '/api/pair') {
		await handlePair(req, res, send);
		return true;
	}
	if (!apiAuthOk(req)) {
		send(401, { error: 'unauthorized' });
		return true;
	}
	try {
		const up = url.pathname.match(/^\/api\/sessions\/([^/]+)\/upload$/);
		if (req.method === 'POST' && up) {
			handleUpload(req, res, decodeURIComponent(up[1]), cors);
			return true;
		}
		// Serve a previously uploaded file (for image thumbnails). Streams with a Content-Type.
		const dl = url.pathname.match(/^\/api\/uploads\/([^/]+)\/([^/]+)$/);
		if (req.method === 'GET' && dl) {
			handleUploadGet(req, res, decodeURIComponent(dl[1]), decodeURIComponent(dl[2]), cors);
			return true;
		}
		// Server-side upload directory (shared across devices). GET reports it; PUT changes it
		// after a STRICT under-home validation (security-sensitive: arbitrary server-side write).
		if (url.pathname === '/api/settings/upload-dir') {
			if (req.method === 'GET') { send(200, { dir: uploadsDir() }); return true; }
			if (req.method === 'PUT') {
				// OWNER-ONLY. Repointing where EVERY upload writes on the host is a control-plane
				// change, not a per-device preference; a paired device token must not be able to
				// steer server-side writes. apiTokenOk is the owner token AND is local-only (a
				// tunnel request, even with the owner token, is rejected), so this PUT is owner +
				// local. A device token (which passed the apiAuthOk gate above) gets a 403 here.
				if (!apiTokenOk(req)) { send(403, { error: 'forbidden: changing the upload directory is owner-only' }); return true; }
				const body = await readJson(req);
				const v = validateUploadDir(body?.dir);
				if (!v.ok) { send(400, { error: v.error }); return true; }
				try { writeUploadConfig(v.dir); } catch (e) { send(500, { error: String(e?.message ?? e) }); return true; }
				send(200, { dir: v.dir });
				return true;
			}
		}
		// Default permission mode a NEW chat session inherits (shared across devices). GET reports
		// it (any paired device may read); PUT changes it after validation. Like the upload dir,
		// this is a control-plane setting, so PUT is OWNER-ONLY (apiTokenOk = owner token AND
		// local-only); a paired device token (which cleared the apiAuthOk gate above) gets a 403.
		if (url.pathname === '/api/settings/permission-mode') {
			if (req.method === 'GET') { send(200, { mode: readDefaultPermissionMode() }); return true; }
			if (req.method === 'PUT') {
				if (!apiTokenOk(req)) { send(403, { error: 'forbidden: changing the default permission mode is owner-only' }); return true; }
				const body = await readJson(req);
				const mode = validatePermissionMode(body?.mode);
				if (!mode) { send(400, { error: 'invalid mode (must be one of: default, acceptEdits, plan, bypassPermissions)' }); return true; }
				try { writeDefaultPermissionMode(mode); } catch (e) { send(500, { error: String(e?.message ?? e) }); return true; }
				send(200, { mode });
				return true;
			}
		}
		if (req.method === 'GET' && url.pathname === '/api/projects') {
			send(200, { root: ROOT, projects: listProjects() });
		} else if (req.method === 'GET' && url.pathname === '/api/sessions') {
			send(200, { sessions: list() });
		} else if (req.method === 'GET' && url.pathname === '/api/pair/code') {
			// Any paired device (not just the owner) can mint a code (add a laptop from your phone).
			await initCrypto();
			const code = mintPairCode();
			const host = req.headers.host || `${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 3000}`;
			const spk = daemonPublicKeyB64();
			send(200, { code, display: formatPairCode(code), fingerprint: daemonFingerprint(), daemonPk: spk, uri: `codeout://pair?host=${encodeURIComponent(host)}&spk=${spk}&c=${code}&v=2` });
		} else if (req.method === 'POST' && url.pathname === '/api/sessions') {
			const body = await readJson(req);
			// Attribute the create to the requesting device (for per-device cap + rate). A
			// device token maps to its device id; the owner token (no device) is 'owner'.
			const creatorId = deviceIdForToken(bearerToken(req)) || 'owner';
			try {
				const explicitName = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 40) : null;
				send(200, create(typeof body.cwd === 'string' && body.cwd ? body.cwd : undefined, body.agent, body.chatMode, creatorId, explicitName, body.permissionMode ?? null));
			} catch (e) {
				// Over-budget creates are 429 (retryable); other failures are 400 (bad request).
				if (e && e.code === 'EBUDGET') send(429, { error: String(e?.message ?? e) });
				else send(400, { error: String(e?.message ?? e) });
			}
		} else {
			if (req.method === 'GET' && url.pathname === '/api/devices') {
				const me = deviceIdForToken(bearerToken(req));
				send(200, { devices: listDevices().map((d) => ({ ...d, current: d.id === me })) });
				return true;
			}
			if (req.method === 'DELETE' && url.pathname === '/api/devices/me') {
				const me = deviceIdForToken(bearerToken(req));
				if (me) { const pk = revokeDevice(me); if (pk) closeDeviceConnections(pk); broadcastDevicesUpdated(); }
				send(200, { ok: true });
				return true;
			}
			// Register THIS device's APNs push token (for chat-mode notifications). Kept on the
			// device record (out of listDevices) so it never reaches other clients.
			if (req.method === 'POST' && url.pathname === '/api/push/register') {
				const id = deviceIdForToken(bearerToken(req));
				if (!id) { send(401, { error: 'unknown device' }); return true; }
				const body = await readJson(req);
				if (typeof body.token !== 'string' || !/^[0-9a-fA-F]{8,200}$/.test(body.token)) {
					send(400, { error: 'bad token' }); return true;
				}
				const env = body.env === 'sandbox' ? 'sandbox' : 'production';
				setDevicePush(id, body.token, env);
				send(200, { ok: true });
				return true;
			}
			const dm = url.pathname.match(/^\/api\/devices\/([^/]+)$/);
			// PATCH device identity { name?, colour?, avatar? }. PERMISSIVE / FLAT-TRUST: any paired
			// device token may edit ANY device's name/colour/avatar (the web app is the management
			// console - setting your phone's avatar from your laptop is the primary case). This
			// matches the existing revoke-anyone model. The iOS "self-only" edit is a client-side UX
			// convention, NOT a server boundary. The avatar raster-only allowlist + size cap below
			// stay UNCONDITIONAL (stored-XSS defence).
			// The daemon is the source of truth; a successful edit broadcasts `devices-updated`.
			if (req.method === 'PATCH' && dm) {
				const id = decodeURIComponent(dm[1]);
				const body = await readJson(req);
				const patch = {};
				if (body.colour !== undefined) {
					if (!isValidColour(body.colour)) { send(400, { error: 'invalid colour (must be one of: pink, emerald, violet, amber, sky, rose)' }); return true; }
					patch.colour = body.colour;
				}
				if (body.avatar !== undefined) {
					if (body.avatar !== null && !isValidAvatar(body.avatar)) { send(400, { error: 'invalid avatar (must be a data: URL <= 128 KB, or null)' }); return true; }
					patch.avatar = body.avatar;
				}
				if (body.name !== undefined) {
					if (typeof body.name !== 'string' || !body.name.trim()) { send(400, { error: 'invalid name' }); return true; }
					patch.name = body.name.trim();
				}
				const ok = updateDevice(id, patch);
				if (!ok) { send(404, { error: 'no such device' }); return true; }
				send(200, { ok: true });
				broadcastDevicesUpdated();
				return true;
			}
			if (req.method === 'DELETE' && dm) { const pk = revokeDevice(decodeURIComponent(dm[1])); if (pk) { closeDeviceConnections(pk); broadcastDevicesUpdated(); } send(200, { ok: !!pk }); return true; }
			const m = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
			if (req.method === 'DELETE' && m) send(200, { ok: kill(m[1]) });
			else if (req.method === 'PATCH' && m) {
				const body = await readJson(req);
				if (body.avatar !== undefined) {
					// Raster-only allowlist + 128 KB cap (stored-XSS defence), same gate as device avatars.
					if (body.avatar !== null && !isValidAvatar(body.avatar)) { send(400, { error: 'invalid avatar (must be a data: URL <= 128 KB, or null)' }); return true; }
					if (!setSessionAvatar(m[1], body.avatar)) { send(404, { error: 'no such session' }); return true; }
				}
				if (body.name !== undefined) rename(m[1], body.name);
				send(200, { ok: true });
			} else send(404, { error: 'not found' });
		}
	} catch (e) {
		send(500, { error: String(e?.message ?? e) });
	}
	return true;
}
