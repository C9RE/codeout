// codeout archive: the retention layer behind "archive replaces kill".
//
// Archiving a chat session ends the agent but KEEPS the conversation: the session's
// chat log + uploads move into ~/.codeout/archive/<id>/ next to a meta.json, and an
// automatic summary is generated so a future reopen can hand the agent context
// without replaying the whole transcript. Deleting an archive is the one true kill.
//
// Layout per archived session:
//   ~/.codeout/archive/<id>/meta.json    { id, name, avatar, cwd, agent, model, effort,
//                                          permissionMode, created, archivedAt, resumeId,
//                                          sizeBytes, summary, summaryStatus }
//   ~/.codeout/archive/<id>/chat.jsonl   the full retained transcript (moved, not copied)
//   ~/.codeout/archive/<id>/uploads/     the session's uploaded files (moved, if any)
//
// The summarizer is a one-shot `claude -p --model haiku` fed a compacted transcript.
// It runs async after archive (archive returns immediately); a failed/missed summary
// stays "pending" and is retried at reopen time.

import { spawn } from 'node:child_process';
import {
	existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync,
	statSync, writeFileSync
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CODEOUT_HOME = process.env.CODEOUT_HOME || join(homedir(), '.codeout');
export const ARCHIVE_DIR = join(CODEOUT_HOME, 'archive');

// Same id discipline as sessions.js: validated before ANY path join, so nothing can
// escape the archive root.
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;
const validId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 80 && SAFE_ID.test(id);

const dirOf = (id) => join(ARCHIVE_DIR, id);
const metaFile = (id) => join(dirOf(id), 'meta.json');
const chatFile = (id) => join(dirOf(id), 'chat.jsonl');

/** Atomic meta write (tmp + rename) — a crash mid-write must not corrupt the record. */
function writeMeta(id, meta) {
	const tmp = metaFile(id) + '.tmp';
	writeFileSync(tmp, JSON.stringify(meta, null, 2), { mode: 0o600 });
	renameSync(tmp, metaFile(id));
}

/** @returns {object|null} the parsed meta.json, or null when absent/invalid. */
export function readArchiveMeta(id) {
	if (!validId(id)) return null;
	try { return JSON.parse(readFileSync(metaFile(id), 'utf8')); } catch { return null; }
}

/** Recursive byte size of the archive folder (uploads included). Best-effort. */
function dirSize(dir) {
	let total = 0;
	try {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			try { total += e.isDirectory() ? dirSize(p) : statSync(p).size; } catch { /* race */ }
		}
	} catch { /* gone */ }
	return total;
}

/**
 * Move a just-ended session's artifacts into the archive and write its meta record.
 * The caller (sessions.js) has already torn the backend down and removed the live
 * record; this only relocates files, so a failure here can't strand a half-dead session.
 * @param {object} rec  session fields to preserve (id, name, avatar, cwd, agent, model,
 *                      effort, permissionMode, created, resumeId)
 * @param {{chatLogFile: string, uploadsPath: string}} paths  live locations to move from
 * @returns {object} the written meta
 */
export function archiveMove(rec, { chatLogFile, uploadsPath }) {
	if (!validId(rec.id)) throw new Error('invalid session id');
	mkdirSync(dirOf(rec.id), { recursive: true, mode: 0o700 });
	// rename() is atomic within ~/.codeout (same filesystem); fall back to copy-less
	// skip when a piece doesn't exist (a chat with no uploads, or an empty log).
	if (existsSync(chatLogFile)) renameSync(chatLogFile, chatFile(rec.id));
	if (uploadsPath && existsSync(uploadsPath)) renameSync(uploadsPath, join(dirOf(rec.id), 'uploads'));
	const meta = {
		id: rec.id,
		name: rec.name ?? null,
		avatar: rec.avatar ?? null,
		cwd: rec.cwd,
		agent: rec.agent,
		model: rec.model ?? null,
		effort: rec.effort ?? null,
		permissionMode: rec.permissionMode ?? null,
		created: rec.created,
		archivedAt: Date.now(),
		resumeId: rec.resumeId ?? null,
		sizeBytes: 0,
		summary: null,
		summaryStatus: 'pending'
	};
	meta.sizeBytes = dirSize(dirOf(rec.id));
	writeMeta(rec.id, meta);
	return meta;
}

/** All archives, newest first. Skips entries with a missing/corrupt meta.json. */
export function listArchives() {
	let names = [];
	try { names = readdirSync(ARCHIVE_DIR); } catch { return []; }
	const out = [];
	for (const n of names) {
		if (!validId(n)) continue;
		const meta = readArchiveMeta(n);
		if (meta) out.push(meta);
	}
	return out.sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));
}

/** The one true kill: removes the transcript, uploads, summary — everything. */
export function deleteArchive(id) {
	if (!validId(id)) return false;
	if (!existsSync(metaFile(id))) return false;
	rmSync(dirOf(id), { recursive: true, force: true });
	return true;
}

// ----- transcript compaction (summarizer input) -----

/**
 * Flatten archived ChatEvents into a compact plain-text transcript for the
 * summarizer. Streamed text deltas share an id — they're stitched back together in
 * arrival order. Tools become one-line labels (the reply text is what matters for a
 * handoff summary; tool output is noise at this altitude). Exported for tests.
 * @param {object[]} events  parsed ChatEvents in log order
 * @param {number} [cap]     keep at most this many chars from the TAIL (recency wins)
 */
export function compactTranscript(events, cap = 40_000) {
	/** @type {string[]} */
	const lines = [];
	/** @type {Map<string, number>} id -> index in lines, for stitching text deltas */
	const textAt = new Map();
	for (const ev of events) {
		if (!ev || typeof ev !== 'object') continue;
		switch (ev.t) {
			case 'user':
				lines.push(`User${ev.senderName ? ` (${ev.senderName})` : ''}: ${ev.text ?? ''}`);
				break;
			case 'text': {
				const at = ev.id != null ? textAt.get(ev.id) : undefined;
				if (at != null) lines[at] += ev.text ?? '';
				else { textAt.set(ev.id, lines.length); lines.push(`Assistant: ${ev.text ?? ''}`); }
				break;
			}
			case 'tool':
				// One line per tool CALL (the "running" emit); result emits carry no name.
				if (ev.name) lines.push(`[tool] ${ev.name}${ev.title ? `: ${ev.title}` : ''}`);
				break;
			case 'system':
				if (ev.text && !ev.text.includes(' · ')) lines.push(`[system] ${ev.text}`);
				break;
			case 'error':
				lines.push(`[error] ${ev.message ?? ''}`);
				break;
			default:
				break; // thinking/stats/typing/etc — not summary input
		}
	}
	const joined = lines.join('\n');
	return joined.length > cap ? joined.slice(-cap) : joined;
}

/** Read + parse the archived transcript (corrupt lines skipped, like the live log). */
function readArchivedEvents(id) {
	let raw = '';
	try { raw = readFileSync(chatFile(id), 'utf8'); } catch { return []; }
	const out = [];
	for (const line of raw.split('\n')) {
		if (!line) continue;
		try { out.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
	}
	return out;
}

const SUMMARY_PROMPT = [
	'You are writing a HANDOFF SUMMARY of the coding-agent conversation below, for a future',
	'session of the same agent to pick the work back up. Write it as briefing prose, max 400',
	'words, covering: the goal, the current state (what was done and verified), key decisions',
	'made and why, files/paths touched, and unfinished work / concrete next steps. No greetings,',
	'no meta-commentary — start directly with the substance.'
].join(' ');

const SUMMARY_TIMEOUT_MS = 120_000;
const SUMMARY_MODEL = 'haiku'; // cheap + fast; a summary doesn't need a frontier model

/**
 * Default runner: one-shot `claude -p --model haiku` with the prompt on stdin.
 * Injectable (see summarize) so tests never spawn a real agent.
 * @returns {Promise<string>} the summary text
 */
function runClaudeOneShot(prompt, env) {
	return new Promise((resolve, reject) => {
		const child = spawn('claude', ['-p', '--model', SUMMARY_MODEL], {
			env, stdio: ['pipe', 'pipe', 'pipe']
		});
		let out = '', err = '';
		const timer = setTimeout(() => {
			try { child.kill('SIGKILL'); } catch { /* gone */ }
			reject(new Error('summary timed out'));
		}, SUMMARY_TIMEOUT_MS);
		timer.unref?.();
		child.stdout.on('data', (d) => { out += d; });
		child.stderr.on('data', (d) => { err += d; });
		child.on('error', (e) => { clearTimeout(timer); reject(e); });
		child.on('close', (code) => {
			clearTimeout(timer);
			if (code === 0 && out.trim()) resolve(out.trim());
			else reject(new Error(`summarizer exited ${code}: ${err.slice(0, 400)}`));
		});
		child.stdin.end(`${SUMMARY_PROMPT}\n\n--- CONVERSATION ---\n${prompt}`);
	});
}

/**
 * Generate (or re-generate) the archive's summary and persist it into meta.json.
 * Safe to fire-and-forget after archive; awaited at reopen when still pending.
 * @param {string} id
 * @param {{env?: object, runner?: (prompt:string, env:object)=>Promise<string>}} [opts]
 * @returns {Promise<string|null>} the summary, or null on failure (status stays pending)
 */
export async function summarize(id, { env = process.env, runner = runClaudeOneShot } = {}) {
	const meta = readArchiveMeta(id);
	if (!meta) return null;
	if (meta.summary && meta.summaryStatus === 'done') return meta.summary;
	const events = readArchivedEvents(id);
	if (events.length === 0) {
		// Nothing to summarize (empty chat archived) — mark done so reopen doesn't wait.
		meta.summary = null; meta.summaryStatus = 'done';
		writeMeta(id, meta);
		return null;
	}
	try {
		const summary = (await runner(compactTranscript(events), env)).slice(0, 8_000);
		// Re-read before write: a concurrent delete must not resurrect the folder.
		if (!readArchiveMeta(id)) return null;
		meta.summary = summary; meta.summaryStatus = 'done';
		writeMeta(id, meta);
		return summary;
	} catch {
		return null; // stays "pending"; retried at reopen
	}
}
