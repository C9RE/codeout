// codeout chat-mode shared helpers. The daemon normalizes agent-specific output
// (e.g. Claude's stream-json) into ChatEvents (see CHAT-EVENTS.md) and streams them
// to clients in 0x03 frames as { type:'chat', ev:<ChatEvent> }.
//
// Every emitted event also carries `seq` (monotonic per-session order/dedup) and `ts`
// (epoch ms wall-clock, for client day/time separators) — added centrally in emit().
//
// ChatEvent shapes (discriminated by `t`):
//   { t:'user',     id, text, senderName?, senderId?, clientId?, queued?, attachments? }
//     clientId = the sender's optimistic-bubble id, echoed back for retry-safe reconcile.
//   { t:'text',     id, text, final?, parent? }
//   { t:'thinking', id, text, final?, parent? }
//   { t:'tool',     id, name, title?, input?, status:'running'|'ok'|'error', output?, parent? }
//   { t:'turn',     phase:'start'|'end', status? }
//   { t:'title',    title }
//   { t:'error',    message }
//   { t:'system',   text }
//   { t:'slash-commands', commands:[...] }   // agent's available `/` commands (init), for autocomplete
// `parent` (when present) = the Task tool_use id a subagent's activity nests under.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

/** Short opaque id for a ChatEvent stream (text/thinking) when the agent gives none. */
export const evId = () => randomUUID().slice(0, 12);

/**
 * A bounded per-session ring of ChatEvents. Capped by BOTH event count and a rough
 * byte budget so a long tool-output run can't grow memory without bound. Replayed to
 * a client on attach (covers refresh / reconnect). User events are stored too.
 */
export class ChatLog {
	/** @param {{maxEvents?:number, maxBytes?:number}} [opts] */
	constructor({ maxEvents = 2000, maxBytes = 2 * 1024 * 1024 } = {}) {
		this.maxEvents = maxEvents;
		this.maxBytes = maxBytes;
		/** @type {Array<{ev:object, bytes:number}>} */
		this.items = [];
		this.bytes = 0;
	}

	/** Append a ChatEvent, evicting oldest until within both caps. */
	push(ev) {
		let bytes;
		try { bytes = Buffer.byteLength(JSON.stringify(ev)); } catch { return; }
		this.items.push({ ev, bytes });
		this.bytes += bytes;
		while (this.items.length > this.maxEvents || this.bytes > this.maxBytes) {
			const dropped = this.items.shift();
			if (!dropped) break;
			this.bytes -= dropped.bytes;
		}
	}

	/** All retained ChatEvents, oldest first, for replay on attach. */
	all() {
		return this.items.map((it) => it.ev);
	}

	/**
	 * Retained ChatEvents with `seq` GREATER THAN `seq` (exclusive), oldest first — for
	 * incremental replay when a client reconnects with a locally-cached transcript and only
	 * needs what it's missing. A null/undefined/NaN `seq` returns everything (same as all()),
	 * so callers can pass an absent query param straight through. Events without a numeric
	 * `seq` are skipped (they can't be ordered) rather than blindly re-sent.
	 * @param {number|null|undefined} seq
	 */
	since(seq) {
		if (seq === null || seq === undefined || Number.isNaN(seq)) return this.all();
		return this.items
			.filter((it) => typeof it.ev.seq === 'number' && it.ev.seq > seq)
			.map((it) => it.ev);
	}

	/** Drop all retained events (e.g. `/clear` starts a fresh conversation). */
	clear() {
		this.items = [];
		this.bytes = 0;
	}
}

/**
 * A ChatLog that ALSO durably appends every event to an ndJSON file on disk, so a
 * daemon restart/crash can replay full scrollback instead of an empty UI. The
 * in-memory ring (inherited) still bounds what's held in RAM and replayed on attach;
 * the disk file is the source of truth across restarts and is itself bounded by a byte
 * cap with rotation (rewrite from the in-memory tail when it grows too large).
 *
 * File layout: one JSON event per line at `<dir>/<sessionId>.jsonl`. On construction
 * the existing file is read and its tail loaded into the ring, so replay-on-attach
 * works immediately after a restart.
 */
export class PersistentChatLog extends ChatLog {
	/**
	 * @param {string} dir            directory to hold per-session .jsonl files
	 * @param {string} sessionId      session id (validated by caller; used as filename)
	 * @param {{maxEvents?:number, maxBytes?:number, maxFileBytes?:number}} [opts]
	 */
	constructor(dir, sessionId, { maxEvents = 2000, maxBytes = 2 * 1024 * 1024, maxFileBytes = 8 * 1024 * 1024 } = {}) {
		super({ maxEvents, maxBytes });
		this.dir = dir;
		this.file = join(dir, `${sessionId}.jsonl`);
		this.maxFileBytes = maxFileBytes;
		this.fileBytes = 0;
		this._load();
	}

	/** Read any persisted log into the in-memory ring (tail wins via push eviction). */
	_load() {
		try {
			if (!existsSync(this.file)) return;
			const raw = readFileSync(this.file, 'utf8');
			this.fileBytes = Buffer.byteLength(raw);
			for (const line of raw.split('\n')) {
				if (!line.trim()) continue;
				try { super.push(JSON.parse(line)); } catch { /* skip a corrupt line */ }
			}
		} catch { /* unreadable file → start fresh in RAM, keep appending */ }
	}

	/** Rewrite the file from the in-memory ring (rotation: drops events already evicted). */
	_rotate() {
		try {
			const lines = this.items.map((it) => JSON.stringify(it.ev)).join('\n');
			const body = lines ? lines + '\n' : '';
			const tmp = this.file + '.tmp';
			writeFileSync(tmp, body, { mode: 0o600 });
			renameSync(tmp, this.file);
			this.fileBytes = Buffer.byteLength(body);
		} catch { /* leave the file as-is; RAM ring is still authoritative for replay */ }
	}

	/** Drop the ring AND truncate the on-disk log (e.g. `/clear` wipes the conversation). */
	clear() {
		super.clear();
		this.fileBytes = 0;
		try { writeFileSync(this.file, '', { mode: 0o600 }); } catch { /* leave as-is; ring is empty regardless */ }
	}

	/** Append to the ring AND durably to disk; rotate when the file outgrows its cap. */
	push(ev) {
		super.push(ev);
		let line;
		try { line = JSON.stringify(ev) + '\n'; } catch { return; }
		try {
			if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
			appendFileSync(this.file, line, { mode: 0o600 });
			this.fileBytes += Buffer.byteLength(line);
			if (this.fileBytes > this.maxFileBytes) this._rotate();
		} catch { /* disk write failed → RAM ring still works for this run */ }
	}
}

/**
 * Flatten a Claude tool_result `content` (string | array of blocks) to a string.
 * Tool results are either a plain string or an array of {type:'text',text} /
 * {type:'image',...} blocks. We surface text; non-text blocks become a short note.
 */
export function flattenToolResult(content) {
	if (content == null) return '';
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content
			.map((b) => {
				if (typeof b === 'string') return b;
				if (b && b.type === 'text' && typeof b.text === 'string') return b.text;
				if (b && b.type === 'image') return '[image]';
				try { return JSON.stringify(b); } catch { return ''; }
			})
			.filter(Boolean)
			.join('\n');
	}
	try { return JSON.stringify(content); } catch { return String(content); }
}

/** Cap a string to a sane length so a giant tool output can't bloat one event. */
export function clip(str, max = 16 * 1024) {
	if (typeof str !== 'string') return str;
	return str.length > max ? str.slice(0, max) + `\n…[truncated ${str.length - max} chars]` : str;
}
