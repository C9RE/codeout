// PTY <-> WebSocket bridge. The browser/app attaches to a server-side session (kept
// alive in sessions.js). Each connection registers a "sink" the session broadcasts to;
// the sink decides framing. Two modes:
//   - plaintext (owner token, local-only): JSON in, raw string out.
//   - e2e (?e2e=1, device token): PROTOCOL.md v2 - crypto_kx session keys + secretstream,
//     a daemon challenge that defeats whole-stream replay, 1-byte-typed frames.
import { WebSocketServer } from 'ws';
import { get } from './sessions.js';
import { originOk, wsTokenOk, isTunnelRequest, isLocalRequest } from './auth.js';
import {
	initCrypto, devicePkForToken, serverSessionKeys,
	pushInit, pullInit, encrypt, decrypt, randomChallenge, ctEqual,
	deviceIdForToken, listDevices
} from './crypto.js';

/** A typed frame: type(1) || payload  (PROTOCOL.md v2). */
const framed = (type, payload) => { const b = new Uint8Array(1 + payload.length); b[0] = type; b.set(payload, 1); return b; };
const u8 = (raw) => new Uint8Array(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));

/**
 * Route a client-originated chat event ({type:'chat', ev}).
 *  - `permission-reply` resolves a pending tool-permission gate (NOT re-broadcast - the daemon
 *    emits the authoritative {t:'permission-resolved'}).
 *  - a `user` event (a message WITH attachments, sent structured instead of as raw input) is
 *    routed to handleUserInput so the daemon serializes it through the turn queue and emits the
 *    authoritative, seq-stamped {t:'user'} echo to ALL clients. It is NOT re-broadcast raw.
 *  - any other client chat event is re-broadcast to the OTHER clients so multi-device UIs sync.
 * @param {any} s      the session
 * @param {any} ev     the ChatEvent the client sent
 * @param {any} self   the originating sink (excluded from re-broadcast)
 * @param {string} [senderId]    device attribution (e2e path)
 * @param {string} [senderName]  device display name (e2e path)
 */
function routeChatEvent(s, ev, self, senderId, senderName) {
	if (!ev || typeof ev !== 'object') return;
	if (ev.t === 'permission-reply') { s.handlePermissionReply?.(ev.id, ev.decision); return; }
	if (ev.t === 'interrupt') { s.handleInterrupt?.(); return; }
	if (ev.t === 'user') {
		// A structured user turn (carries attachments and/or a clientId idempotency key). Feed it
		// through the same queue/echo path as a raw input frame; the daemon broadcasts the stamped
		// {t:'user'} itself. The clientId lets a retry reconcile/dedupe without double-running.
		s.handleUserInput?.(ev.text, senderId, senderName, ev.attachments, ev.clientId);
		return;
	}
	const jbuf = Buffer.from(JSON.stringify({ type: 'chat', ev }), 'utf8');
	for (const client of s.clients) {
		try { if (client !== self && client.writeJsonRaw) client.writeJsonRaw(jbuf); } catch { /* ignore */ }
	}
}

// Live e2e connections by device kx pubkey (base64url) so a revoked device can be
// kicked immediately, not just blocked on its next reconnect.
const liveByDevice = new Map(); // pkB64 -> Set<ws>
/** Close every live connection for a device pubkey (called when a device is revoked). */
export function closeDeviceConnections(pkB64) {
	const set = liveByDevice.get(pkB64);
	if (!set) return 0;
	let n = 0;
	for (const ws of set) { try { ws.close(1008, 'device revoked'); n++; } catch { /* already closed */ } }
	liveByDevice.delete(pkB64);
	return n;
}

/** Attach the bridge at /pty?session=<id>&token=<token>[&e2e=1]. @param {import('node:http').Server} httpServer */
export function attachPty(httpServer) {
	const wss = new WebSocketServer({ server: httpServer, path: '/pty' });

	// Heartbeat: a phone that vanishes without a clean close (backgrounded, cell<->wifi handoff,
	// NAT dropping an idle socket) would otherwise leave a ghost connection wired into a session's
	// broadcast set forever. Ping every 30s; a client that misses a pong round is terminated, which
	// fires 'close' and runs the normal cleanup (sink + liveByDevice). `.unref()` so it never holds
	// the process open.
	const heartbeat = setInterval(() => {
		for (const ws of wss.clients) {
			if (ws.isAlive === false) { try { ws.terminate(); } catch { /* already gone */ } continue; }
			ws.isAlive = false;
			try { ws.ping(); } catch { /* will be reaped next round */ }
		}
	}, 30_000);
	heartbeat.unref();
	wss.on('close', () => clearInterval(heartbeat));

	wss.on('connection', async (ws, req) => {
		ws.isAlive = true;
		ws.on('pong', () => { ws.isAlive = true; });
		const q = new URL(req.url, 'http://localhost').searchParams;
		if (!originOk(req)) { ws.close(1008, 'forbidden origin'); return; }
		const cols = Number(q.get('cols')) || 80;
		const rows = Number(q.get('rows')) || 24;
		// Incremental chat replay: a client with a cached transcript passes ?sinceSeq=<n> to get
		// only events newer than what it already has. Absent OR empty -> null -> full replay
		// (back-compat: existing clients that don't send it get the whole log exactly as before).
		// '0' is truthy so since(0) still works; non-numeric -> NaN -> since() falls back to all().
		const sinceSeqRaw = q.get('sinceSeq');
		const sinceSeq = sinceSeqRaw ? Number(sinceSeqRaw) : null;

		// ---------- Plaintext path (owner token), via a sink ----------
		// LOCAL-ONLY: over the public tunnel (Cloudflare headers present) the plaintext path is
		// closed - remote clients MUST use ?e2e=1 + a device token + the secretstream handshake.
		// Loopback/LAN/Tailscale keep the plaintext owner-token path (the local console bootstrap).
		if (q.get('e2e') !== '1') {
			if (isTunnelRequest(req) || !isLocalRequest(req)) { ws.close(1008, 'plaintext path is local-only; use e2e'); return; }
			if (!wsTokenOk(q.get('token'))) { ws.close(1008, 'unauthorized'); return; }
			const s = get(q.get('session'));
			if (!s) { ws.close(1008, 'no such session'); return; }
			const sink = {
				write: (d) => { if (ws.readyState === ws.OPEN) ws.send(d); },
				writeJsonRaw: (jbuf) => {
					if (ws.readyState === ws.OPEN) {
						const frame = Buffer.alloc(jbuf.length + 1);
						frame[0] = 0x03;
						jbuf.copy(frame, 1);
						ws.send(frame);
					}
				},
				close: (c, r) => { try { ws.close(c, r); } catch { /* closed */ } }
			};
			s.clients.add(sink);
			// Terminal sessions replay the raw PTY scrollback; chat sessions replay the
			// bounded ChatEvent log as { type:'chat', ev } frames (user + agent bubbles).
			if (!s.chatMode && s.buffer) {
				const replayBuf = Array.isArray(s.buffer) ? Buffer.concat(s.buffer) : s.buffer;
				sink.write(replayBuf.toString('utf8'));
			}
			if (s.chatMode && s.chatLog) {
				for (const ev of s.chatLog.since(sinceSeq)) {
					sink.writeJsonRaw(Buffer.from(JSON.stringify({ type: 'chat', ev }), 'utf8'));
				}
			}
			if (!s.chatMode) { try { s.pty.resize(cols, rows); } catch { /* race */ } }
			ws.on('message', (raw) => {
				let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
				if (msg.type === 'input') {
					// Chat: an input frame is a user turn (route to the managed backend +
					// echo a {t:'user'} ChatEvent). Terminal: raw bytes into the PTY.
					if (s.chatMode) s.handleUserInput?.(msg.data);
					else s.pty.write(msg.data);
				} else if (msg.type === 'chat' && s.chatMode) {
					// A client-originated chat event. permission-reply resolves a pending tool
					// gate; a `user` event (message with attachments) is fed to the turn queue;
					// anything else is re-broadcast to the other clients (echo). The plaintext
					// path is owner/local, so no per-device sender attribution.
					routeChatEvent(s, msg.ev, sink);
				} else if (msg.type === 'resize') {
					if (!s.chatMode) { try { s.pty.resize(msg.cols, msg.rows); } catch { /* race */ } }
				}
			});
			ws.on('close', () => s.clients.delete(sink));
			return;
		}

		// ---------- E2E path (PROTOCOL.md v2) ----------
		await initCrypto();
		const devicePk = devicePkForToken(q.get('token'));
		if (!devicePk) { ws.close(1008, 'unauthorized device'); return; }
		const deviceId = deviceIdForToken(q.get('token'));
		const me = listDevices().find(d => d.id === deviceId);
		const myName = me ? me.name : 'Unknown';
		const s = get(q.get('session'));
		if (!s) { ws.close(1008, 'no such session'); return; }

		// Track this live connection by device pubkey so a revoke can kick it instantly.
		const pkB64 = Buffer.from(devicePk).toString('base64url');
		let liveSet = liveByDevice.get(pkB64);
		if (!liveSet) { liveSet = new Set(); liveByDevice.set(pkB64, liveSet); }
		liveSet.add(ws);

		const { sharedRx, sharedTx } = serverSessionKeys(devicePk);
		const push = pushInit(sharedTx);                          // { state, header }
		const challenge = randomChallenge();
		ws.send(push.header);                                     // 24-byte plaintext header FIRST
		ws.send(encrypt(push.state, framed(0x02, challenge)));    // then the encrypted challenge

		let pull = null;
		let verified = false;
		let sink = null;
		ws.on('message', (raw) => {
			const buf = u8(raw);
			if (!pull) {                                          // 1st inbound = client header
				try { pull = pullInit(buf, sharedRx); } catch { ws.close(1008, 'bad header'); }
				return;
			}
			const pt = decrypt(pull, buf);
			if (!pt) { ws.close(1008, 'decrypt failed'); return; }
			if (!verified) {                                      // 2nd inbound = challenge response
				if (pt[0] !== 0x02 || !ctEqual(pt.slice(1), challenge)) { ws.close(1008, 'challenge failed'); return; }
				verified = true;
				sink = {
					write: (d) => { if (ws.readyState === ws.OPEN) ws.send(encrypt(push.state, framed(0x00, u8(Buffer.from(d, 'utf8'))))); },
					writeJsonRaw: (jbuf) => { if (ws.readyState === ws.OPEN) ws.send(encrypt(push.state, framed(0x03, jbuf))); },
					close: (c, r) => { try { ws.close(c, r); } catch { /* closed */ } }
				};
				s.clients.add(sink);
				if (!s.chatMode) { try { s.pty.resize(cols, rows); } catch { /* race */ } }
				// Terminal: replay raw PTY scrollback. Chat: replay the bounded ChatEvent log.
				if (!s.chatMode && s.buffer) {
					const replayBuf = Array.isArray(s.buffer) ? Buffer.concat(s.buffer) : s.buffer;
					sink.write(replayBuf);
				}
				if (s.chatMode && s.chatLog) {
					for (const ev of s.chatLog.since(sinceSeq)) {
						sink.writeJsonRaw(u8(Buffer.from(JSON.stringify({ type: 'chat', ev }), 'utf8')));
					}
				}
				return;
			}
			if (pt[0] === 0x00) {
				// Chat: a 0x00 frame from a device is a user turn (attributed). The daemon
				// emits the {t:'user'} ChatEvent to ALL clients itself. Terminal: raw PTY input.
				if (s.chatMode) s.handleUserInput?.(Buffer.from(pt.slice(1)).toString('utf8'), deviceId, myName);
				else s.pty.write(Buffer.from(pt.slice(1)));
			} else if (pt[0] === 0x01 && pt.length >= 5) {
				if (!s.chatMode) {
					const dv = new DataView(pt.buffer, pt.byteOffset + 1, 4);
					try { s.pty.resize(dv.getUint16(0, true), dv.getUint16(2, true)); } catch { /* race */ }
				}
			} else if (pt[0] === 0x03) {
				try {
					const obj = JSON.parse(Buffer.from(pt.slice(1)).toString('utf8'));
					if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
					// A chat event routes through routeChatEvent: permission-reply resolves a
					// pending tool gate, a `user` message (with attachments) feeds the turn
					// queue, both NOT re-broadcast raw (the daemon emits the authoritative,
					// seq-stamped echo). Anything else is re-broadcast with the device sender.
					if (s.chatMode && obj.type === 'chat' && obj.ev) {
						routeChatEvent(s, obj.ev, sink, deviceId, myName);
						return;
					}
					obj.senderId = deviceId;
					obj.senderName = myName;
					const jbuf = u8(Buffer.from(JSON.stringify(obj), 'utf8'));
					for (const client of s.clients) {
						try {
							if (client !== sink && client.writeJsonRaw) client.writeJsonRaw(jbuf);
						} catch (e) { /* ignore */ }
					}
				} catch (e) {
					/* ignore bad json */
				}
			}
		});
		ws.on('close', () => { 
			if (sink) s.clients.delete(sink); 
			liveSet.delete(ws); 
			if (liveSet.size === 0) liveByDevice.delete(pkB64); 
		});
	});

	return wss;
}
