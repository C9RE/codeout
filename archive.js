// codeout archive: the retention layer behind "archive replaces kill".
//
// Archiving a chat session ends the agent but KEEPS the conversation: the session's
// chat log + uploads move into ~/.codeout/archive/<id>/ next to a meta.json.
// When unarchiving (reopening), the complete 1:1 chat transcript is restored into
// the new session so conversation history is preserved with zero loss and zero LLM delay.
// Deleting an archive is the one true kill.
//
// Layout per archived session:
//   ~/.codeout/archive/<id>/meta.json    { id, name, avatar, cwd, agent, model, effort,
//                                          permissionMode, created, archivedAt, resumeId,
//                                          sizeBytes }
//   ~/.codeout/archive/<id>/chat.jsonl   the full retained transcript (moved, not copied)
//   ~/.codeout/archive/<id>/uploads/     the session's uploaded files (moved, if any)

import { randomBytes } from 'node:crypto';
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

/** @returns {string} the absolute path to the archived chat.jsonl */
export function chatFilePath(id) {
	return chatFile(id);
}

/** @returns {string} the absolute path to the archived uploads directory */
export function uploadsDirPath(id) {
	return join(dirOf(id), 'uploads');
}

/** Atomic meta write (tmp + rename) — a crash mid-write must not corrupt the record. */
function writeMeta(id, meta) {
	const tmp = `${metaFile(id)}.${randomBytes(6).toString('hex')}.tmp`;
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
		sizeBytes: 0
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

/** The one true kill: removes the transcript, uploads, meta — everything. */
export function deleteArchive(id) {
	if (!validId(id)) return false;
	if (!existsSync(metaFile(id))) return false;
	rmSync(dirOf(id), { recursive: true, force: true });
	return true;
}

/** Read + parse the archived transcript (corrupt lines skipped, like the live log). */
export function readArchivedEvents(id) {
	let raw = '';
	try { raw = readFileSync(chatFile(id), 'utf8'); } catch { return []; }
	const out = [];
	for (const line of raw.split('\n')) {
		if (!line) continue;
		try { out.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
	}
	return out;
}
