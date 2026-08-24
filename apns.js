// apns.js: push notifications to Apple devices, token-based (.p8 auth key).
//
// codeout is self-hosted: the daemon talks to Apple's APNs DIRECTLY over HTTP/2
// with a short-lived ES256 JWT signed by the team's .p8 auth key. No third-party
// relay. Returns { ok:false, reason:'disabled' } (a no-op) when the key is absent.
//
// Config (env overrides; only the .p8 is secret):
//   CODEOUT_APNS_KEY      .p8 path     (default ~/.codeout/apns.p8)
//   CODEOUT_APNS_KEY_ID   key id       (default 8DVSZLXH2W)
//   CODEOUT_APNS_TEAM_ID  team id      (default M26K3ZA2X5)
//   CODEOUT_APNS_TOPIC    bundle id    (default dev.codeout.app)

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { sign } from 'node:crypto';
import http2 from 'node:http2';
import { daemonFingerprint } from './crypto.js';

const HOME = process.env.CODEOUT_HOME || join(homedir(), '.codeout');
const KEY_PATH = process.env.CODEOUT_APNS_KEY || join(HOME, 'apns.p8');
const KEY_ID = process.env.CODEOUT_APNS_KEY_ID || '8DVSZLXH2W';
const TEAM_ID = process.env.CODEOUT_APNS_TEAM_ID || 'M26K3ZA2X5';
const TOPIC = process.env.CODEOUT_APNS_TOPIC || 'dev.codeout.app';

const HOSTS = {
	production: 'https://api.push.apple.com',
	sandbox: 'https://api.sandbox.push.apple.com',
};

let keyPem; // undefined = not loaded yet, '' = absent
function key() {
	if (keyPem === undefined) {
		try { keyPem = existsSync(KEY_PATH) ? readFileSync(KEY_PATH, 'utf8') : ''; } catch { keyPem = ''; }
	}
	return keyPem;
}

export function apnsEnabled() { return !!key(); }

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// A provider JWT may be reused up to 60 min; refresh at ~45.
let jwtCache = null, jwtAt = 0;
function providerJwt() {
	const now = Math.floor(Date.now() / 1000);
	if (jwtCache && now - jwtAt < 45 * 60) return jwtCache;
	const header = b64url(JSON.stringify({ alg: 'ES256', kid: KEY_ID }));
	const claims = b64url(JSON.stringify({ iss: TEAM_ID, iat: now }));
	const input = `${header}.${claims}`;
	const sig = b64url(sign('sha256', Buffer.from(input), { key: key(), dsaEncoding: 'ieee-p1363' }));
	jwtCache = `${input}.${sig}`; jwtAt = now;
	return jwtCache;
}

// One persistent HTTP/2 session per environment, re-dialed on close.
const conns = {};
function conn(env) {
	let c = conns[env];
	if (c && !c.closed && !c.destroyed) return c;
	c = http2.connect(HOSTS[env]);
	c.on('error', () => { if (conns[env] === c) conns[env] = null; try { c.destroy(); } catch {} });
	c.on('close', () => { if (conns[env] === c) conns[env] = null; });
	conns[env] = c;
	return c;
}

function postOnce(env, token, payloadBuf, { pushType, priority, collapseId }) {
	return new Promise((resolve) => {
		let c;
		try { c = conn(env); } catch (e) { resolve({ status: 0, reason: String(e?.message ?? e) }); return; }
		const headers = {
			':method': 'POST',
			':path': `/3/device/${token}`,
			authorization: `bearer ${providerJwt()}`,
			'apns-topic': TOPIC,
			'apns-push-type': pushType || 'alert',
			'apns-priority': String(priority ?? 10),
			'content-type': 'application/json',
			'content-length': payloadBuf.length,
		};
		if (collapseId) headers['apns-collapse-id'] = String(collapseId).slice(0, 64);
		let req;
		try { req = c.request(headers); } catch (e) { resolve({ status: 0, reason: String(e?.message ?? e) }); return; }
		let status = 0, data = '';
		req.setTimeout(8000, () => { try { req.close(); } catch {}; resolve({ status: 0, reason: 'timeout' }); });
		req.on('response', (h) => { status = h[':status']; });
		req.on('data', (d) => { data += d; });
		req.on('end', () => {
			let reason = '';
			if (status !== 200) { try { reason = JSON.parse(data || '{}').reason || ''; } catch {} }
			resolve({ status, reason });
		});
		req.on('error', (e) => resolve({ status: 0, reason: String(e?.message ?? e) }));
		req.end(payloadBuf);
	});
}

/**
 * Send one notification.
 * @param {string} token  APNs device token (hex)
 * @param {object} o      { title, body, sessionId, kind, badge, sound, priority, pushType, collapseId, env }
 * @returns {Promise<{ ok:boolean, env?:string, reason?:string, remove?:boolean }>}
 *          remove=true => the token is dead (BadDeviceToken / Unregistered); drop it.
 */
export async function sendPush(token, o = {}) {
	if (!apnsEnabled() || !token) return { ok: false, reason: 'disabled' };
	const aps = { alert: { title: o.title || 'codeout', body: o.body || '' }, sound: o.sound || 'default' };
	if (o.badge != null) aps.badge = o.badge;
	if (o.sessionId) aps['thread-id'] = o.sessionId;
	if (o.kind === 'permission') aps['interruption-level'] = 'time-sensitive';
	const payload = { aps };
	if (o.sessionId) payload.sessionId = o.sessionId; // custom key: iOS routes the tap by this
	if (o.kind) payload.kind = o.kind;
	// Which daemon sent this (fingerprint, XXXX-XXXX) — a multi-host client routes the
	// tap to the right host by it; single-host clients just ignore it.
	try { payload.daemon = daemonFingerprint(); } catch { /* identity not minted yet */ }
	const buf = Buffer.from(JSON.stringify(payload));
	const opts = { pushType: o.pushType || 'alert', priority: o.priority ?? 10, collapseId: o.collapseId };
	// Try the token's known env first, then the other (TestFlight=production, Xcode dev=sandbox).
	const order = o.env ? [o.env, o.env === 'production' ? 'sandbox' : 'production'] : ['production', 'sandbox'];
	let last = { status: 0, reason: 'no-env' };
	for (const env of order) {
		last = await postOnce(env, token, buf, opts);
		if (last.status === 200) return { ok: true, env };
		if (last.reason === 'BadDeviceToken') continue;            // wrong env -> try the other
		if (last.reason === 'Unregistered') return { ok: false, reason: 'Unregistered', remove: true };
		return { ok: false, reason: last.reason || `status ${last.status}` };
	}
	return { ok: false, reason: last.reason || 'BadDeviceToken', remove: last.reason === 'BadDeviceToken' };
}
