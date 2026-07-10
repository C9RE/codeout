// Platform layer — POSIX (macOS + Linux).
//
// ALL Unix-specific daemon behaviour lives here so the Windows implementation (windows.js)
// can evolve independently: editing one file can't regress the other. sessions.js and cli.js
// import only ./platform/index.js and call this interface — they never branch on the OS.
//
// Terminal persistence model: `dtach` runs the agent in a DETACHED master process; node-pty is
// just an attached client, so the agent survives a daemon restart and we reattach on boot.
import { spawn as ptySpawn } from '@homebridge/node-pty-prebuilt-multiarch';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

export const name = 'posix';

// dtach is OPTIONAL. When present, terminal sessions run under a detached master and survive a
// daemon restart. When absent, we spawn the agent/shell directly (like Windows) — terminal
// sessions still work, they just don't outlive a restart. Detected once, without running dtach
// (a bad-arg invocation would exit non-zero and falsely read as "missing").
let HAS_DTACH = false;
try { execFileSync('sh', ['-c', 'command -v dtach'], { stdio: 'ignore' }); HAS_DTACH = true; } catch { /* not installed */ }

export const terminalSurvivesRestart = HAS_DTACH;

// The child inherits only a safe, minimal environment, never the daemon's full process.env,
// so host secrets don't leak into every session. Agents read their own creds from $HOME.
const SAFE_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'COLORTERM', 'TMPDIR', 'TZ',
	// BYO-key agent auth (harmless when unset): Gemini / Codex / Claude.
	'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_CLOUD_PROJECT', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];

/** Build the sanitized environment a spawned agent/shell inherits (+ the agent bin dirs on PATH). */
export function buildChildEnv() {
	const env = {};
	for (const k of SAFE_ENV) if (process.env[k] != null) env[k] = process.env[k];
	for (const k of Object.keys(process.env)) if (k.startsWith('LC_')) env[k] = process.env[k];
	// `claude` installs to ~/.local/bin, which a systemd --user service's PATH omits, so a bare
	// spawn('claude') would ENOENT. Add the usual bin dirs so the agent CLIs are findable.
	const parts = env.PATH ? env.PATH.split(':') : [];
	for (const p of [join(homedir(), '.local/bin'), '/usr/local/bin', '/usr/bin', '/bin']) {
		if (!parts.includes(p)) parts.push(p);
	}
	env.PATH = parts.join(':');
	return env;
}

// dtach argv: -E disables its detach keystroke, -r winch forwards resizes. `fresh` creates the
// master (-A) running the agent under a login shell; a reattach (-a) just joins the existing one.
function dtachArgs(socket, agent, fresh) {
	const inner = agent === 'bash' ? 'exec bash -l' : `${agent}; exec bash -l`;
	const base = [fresh ? '-A' : '-a', socket, '-E', '-r', 'winch'];
	return fresh ? [...base, 'bash', '-l', '-c', inner] : base;
}

/** Spawn (or reattach) a terminal session's PTY. Returns the node-pty. With dtach: a detached
 *  master that survives restarts. Without dtach: the agent/shell runs directly (no persistence). */
export function spawnTerminal({ socket, agent, fresh, ptyOpts }) {
	if (HAS_DTACH) return ptySpawn('dtach', dtachArgs(socket, agent, fresh), ptyOpts);
	// No dtach: run the agent/shell directly. Note the minor UX divergence from the dtach path —
	// quitting `claude` here ends the terminal session rather than dropping to a live shell.
	const cmd = agent === 'claude' ? 'claude' : (process.env.SHELL || 'bash');
	const args = agent === 'claude' ? [] : ['-l'];
	return ptySpawn(cmd, args, ptyOpts);
}

/** Kill a terminal session's agent. With dtach, the master is detached from our client, so we
 *  match it by its unique socket path in argv, then drop the socket file. Without dtach, the
 *  node-pty child IS the process, so pty.kill() alone tears it down. */
export function killTerminal(session) {
	if (HAS_DTACH) {
		try { execFileSync('pkill', ['-f', '--', session.socket]); } catch { /* nothing matched */ }
	}
	try { session.pty?.kill(); } catch { /* gone */ }
	if (HAS_DTACH) {
		try { if (session.socket && existsSync(session.socket)) unlinkSync(session.socket); } catch { /* ignore */ }
	}
}

// cloudflared auto-download: the OS+arch release asset (bare binary on Linux, a .tgz on macOS)
// and the local binary name. cli.js fetches this into ~/.codeout/bin when cloudflared isn't on
// PATH, so the public tunnel works with zero manual install.
export const cloudflaredBin = 'cloudflared';
export function cloudflaredAsset() {
	const arch = { x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'arm' }[process.arch];
	if (!arch) return null;
	// macOS ships only amd64/arm64 .tgz; a 32-bit 'arm' Mac doesn't exist, so guard it.
	if (process.platform === 'darwin') {
		if (arch === '386' || arch === 'arm') return null;
		return { name: `cloudflared-darwin-${arch}.tgz`, tgz: true };
	}
	return { name: `cloudflared-linux-${arch}`, tgz: false };
}

// ---- boot service: launchd on macOS, systemd --user on Linux ----
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const plistPath = () => join(homedir(), 'Library', 'LaunchAgents', 'dev.codeout.plist');

function serviceUnit(execArgs) {
	// Quote any arg with a space so systemd doesn't mis-split the argv (e.g. a path under a
	// home directory with a space). systemd honours double quotes in ExecStart.
	const exec = execArgs.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ');
	return `[Unit]
Description=codeout - self-hosted AI coding agents, in your pocket
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${exec}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;
}

function installLaunchd(execArgs, opts, ui) {
	const plist = plistPath();
	const log = join(homedir(), '.codeout', 'codeout.log');
	const args = execArgs.map((a) => `\t\t<string>${xmlEsc(a)}</string>`).join('\n');
	const doc = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>dev.codeout</string>
	<key>ProgramArguments</key>
	<array>
${args}
	</array>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>StandardOutPath</key><string>${xmlEsc(log)}</string>
	<key>StandardErrorPath</key><string>${xmlEsc(log)}</string>
</dict>
</plist>
`;
	try {
		mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
		writeFileSync(plist, doc);
		try { execFileSync('launchctl', ['unload', plist], { stdio: 'ignore' }); } catch { /* not loaded yet */ }
		execFileSync('launchctl', ['load', '-w', plist], { stdio: 'ignore' });
	} catch (e) {
		console.log(ui.dim('  wrote ' + plist + ', but `launchctl load` failed: ' + (e?.message ?? e)));
		console.log(ui.dim('  load it manually: launchctl load -w ' + plist));
		return;
	}
	console.log();
	console.log('  ' + ui.pink('installed') + ' - codeout starts on login' + (opts.local ? ' (local only - LAN + Tailscale).' : ' with a public tunnel.'));
	console.log('    logs     ' + ui.dim(log));
	console.log('    status   ' + ui.dim('launchctl list | grep codeout'));
	console.log('    pair     ' + ui.dim('codeout --pair'));
	console.log('    remove   ' + ui.dim('codeout --uninstall'));
	console.log();
}

/** Install the boot service. `execArgs` is the argv that launches the daemon; `ui` = { dim, pink }. */
export function installService(execArgs, opts, ui) {
	if (process.platform === 'darwin') return installLaunchd(execArgs, opts, ui);
	const dir = join(homedir(), '.config', 'systemd', 'user');
	const unit = join(dir, 'codeout.service');
	mkdirSync(dir, { recursive: true });
	writeFileSync(unit, serviceUnit(execArgs));
	const user = userInfo().username;
	// linger lets the service start at boot without an active login (headless servers).
	try { execFileSync('loginctl', ['enable-linger', user], { stdio: 'ignore' }); }
	catch { console.log(ui.dim('  note: could not enable linger; run `sudo loginctl enable-linger ' + user + '` so it starts at boot.')); }
	try {
		execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
		execFileSync('systemctl', ['--user', 'enable', '--now', 'codeout'], { stdio: 'inherit' });
	} catch (e) {
		console.log(ui.dim('  wrote ' + unit + ', but `systemctl --user` failed: ' + (e?.message ?? e)));
		console.log(ui.dim('  start it manually with: systemctl --user enable --now codeout'));
		return;
	}
	console.log();
	console.log('  ' + ui.pink('installed') + ' - codeout starts on boot' + (opts.local ? ' (local only - LAN + Tailscale).' : ' with a public tunnel.'));
	console.log('    logs     ' + ui.dim('journalctl --user -u codeout -f'));
	console.log('    status   ' + ui.dim('systemctl --user status codeout'));
	console.log('    pair     ' + ui.dim('codeout --pair'));
	console.log('    remove   ' + ui.dim('codeout --uninstall'));
	console.log();
}

export function uninstallService(ui) {
	if (process.platform === 'darwin') {
		const plist = plistPath();
		try { execFileSync('launchctl', ['unload', '-w', plist], { stdio: 'ignore' }); } catch { /* not loaded */ }
		try { unlinkSync(plist); } catch { /* already gone */ }
		console.log(ui.dim('  removed the codeout login agent.'));
		return;
	}
	try { execFileSync('systemctl', ['--user', 'disable', '--now', 'codeout'], { stdio: 'ignore' }); } catch { /* not enabled */ }
	try { unlinkSync(join(homedir(), '.config', 'systemd', 'user', 'codeout.service')); } catch { /* already gone */ }
	try { execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' }); } catch { /* ignore */ }
	console.log(ui.dim('  removed the codeout boot service.'));
}
