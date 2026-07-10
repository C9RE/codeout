// Shared newline-delimited JSON-RPC 2.0 transport over a child process's stdio.
//
// Both the OpenAI Codex `app-server` and the Gemini `--acp` (Agent Client Protocol) backends
// speak ndJSON JSON-RPC 2.0 and are BIDIRECTIONAL: we send requests (id-correlated) + fire
// notifications, and the peer sends back responses, its own notifications, AND server-initiated
// requests (which expect a reply — e.g. tool-permission approvals). This module owns ONLY that
// transport (framing, id→pending-promise map, routing). The per-agent SEMANTIC mapping
// (item taxonomy vs ACP sessionUpdate variants, decision enums) lives in codex-chat.js /
// gemini-chat.js — they don't overlap.
import { spawn } from 'node:child_process';

/**
 * Spawn a child and wrap its stdio as a JSON-RPC 2.0 peer.
 * @param {string} command
 * @param {string[]} args
 * @param {object} o
 * @param {object}   [o.env]
 * @param {(method:string, params:any)=>void} [o.onNotification]  peer notification (no id)
 * @param {(method:string, params:any, id:number|string)=>any|Promise<any>} [o.onRequest]
 *        peer REQUEST (has id) — return its result (or throw to send a JSON-RPC error)
 * @param {(code:number|null, signal:string|null)=>void} [o.onExit]
 * @param {(err:Error)=>void} [o.onError]
 * @param {(line:string)=>void} [o.onStderr]
 * @returns {{ request:(m:string,p?:any)=>Promise<any>, notify:(m:string,p?:any)=>void, kill:()=>void, child:import('node:child_process').ChildProcess }}
 */
export function jsonRpcChild(command, args, { env, onNotification, onRequest, onExit, onError, onStderr } = {}) {
	const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true });
	let nextId = 0;
	const pending = new Map(); // id -> { resolve, reject }
	let buf = '';

	const write = (obj) => { try { child.stdin.write(JSON.stringify(obj) + '\n'); } catch { /* stdin gone */ } };
	const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
	const replyError = (id, e) => write({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e?.message ?? e) } });
	const failPending = (why) => { for (const [, p] of pending) { try { p.reject(new Error(why)); } catch { /* ignore */ } } pending.clear(); };

	// Decode multibyte chars correctly across pipe-chunk boundaries (a StringDecoder buffers a
	// split UTF-8 sequence). Without this, emoji/accents/CJK in streamed output become U+FFFD.
	child.stdout.setEncoding('utf8');
	child.stdout.on('data', (d) => {
		buf += d;
		let i;
		while ((i = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, i).trim();
			buf = buf.slice(i + 1);
			if (!line) continue;
			let m;
			try { m = JSON.parse(line); } catch { continue; } // ignore non-JSON noise on stdout
			if (m.id != null && (m.result !== undefined || m.error !== undefined)) {
				// response to one of OUR requests
				const p = pending.get(m.id);
				if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message || JSON.stringify(m.error))) : p.resolve(m.result); }
			} else if (m.id != null && m.method) {
				// server/peer-INITIATED request — we must reply
				Promise.resolve()
					.then(() => onRequest?.(m.method, m.params, m.id))
					.then((result) => reply(m.id, result ?? {}))
					.catch((e) => replyError(m.id, e));
			} else if (m.method) {
				// notification (no id)
				try { onNotification?.(m.method, m.params); } catch { /* swallow — one bad note shouldn't wedge the stream */ }
			}
		}
	});
	if (onStderr) {
		let ebuf = '';
		child.stderr.on('data', (d) => { ebuf += d; let j; while ((j = ebuf.indexOf('\n')) >= 0) { const l = ebuf.slice(0, j); ebuf = ebuf.slice(j + 1); if (l.trim()) onStderr(l); } });
	}
	child.on('exit', (code, signal) => {
		failPending('backend exited'); // so in-flight requests don't hang on a dead child
		onExit?.(code, signal);
	});
	child.on('error', (e) => { failPending('backend spawn error'); onError?.(e); }); // ENOENT fires error, not exit

	function request(method, params) {
		const id = ++nextId;
		return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); write({ jsonrpc: '2.0', id, method, params }); });
	}
	function notify(method, params) { write({ jsonrpc: '2.0', method, params }); }
	function kill() { try { child.kill(); } catch { /* already gone */ } }

	return { request, notify, kill, child };
}
