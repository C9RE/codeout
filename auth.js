// codeout - auth gate for the session API and the /pty WebSocket.
//
// The owner token is a single long-lived secret, generated on first run and stored at
// ~/.codeout/config.json (printed once on startup). The local console gets it via
// ?token=… on first load and keeps it in localStorage; it then sends it as a Bearer
// header on the API and a query param on the WebSocket (browsers can't set WS headers).
// Origin is checked as defence-in-depth against cross-site WebSocket hijacking. Remote
// devices don't use this token at all: they pair for a device token over the E2E channel.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { devicePkForToken } from './crypto.js';

const CONFIG_DIR = process.env.CODEOUT_HOME || join(homedir(), '.codeout');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

function loadOrCreateToken() {
	try {
		if (existsSync(CONFIG_FILE)) {
			const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
			if (typeof cfg.token === 'string' && cfg.token) return cfg.token;
		}
	} catch {
		/* unreadable/corrupt → regenerate below */
	}
	const token = randomBytes(32).toString('base64url');
	try {
		mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
		writeFileSync(CONFIG_FILE, JSON.stringify({ token }, null, 2), { mode: 0o600 });
	} catch (e) {
		console.error('[codeout] WARNING: could not persist token:', e?.message ?? e);
	}
	return token;
}

/** The session auth token (stable across restarts via ~/.codeout/config.json). */
export const TOKEN = loadOrCreateToken();

/** Constant-time string compare (avoids leaking the token via timing). */
function safeEq(a, b) {
	if (typeof a !== 'string' || typeof b !== 'string') return false;
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
}

const EXTRA_ORIGINS = (process.env.CODEOUT_ALLOWED_ORIGINS || '')
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);

// Headers the Cloudflare edge injects on EVERY request it proxies to an origin. cloudflared
// (the only tunnel ingress here, daemon-spawned, forwarding to 127.0.0.1:8400) passes them
// through to us. A loopback/LAN/Tailscale request straight to the port carries NONE of them.
// So their presence === "this came over the public tunnel". We check a SET, not one header:
//   - cf-ray         added on every edge request; no documented transform removes it (primary).
//   - cf-connecting-ip / x-forwarded-for / true-client-ip / cf-ipcountry / cf-visitor
//                    also edge-added; some are strippable via a "Remove visitor IP headers"
//                    Managed Transform, but checking the whole set means removing any one still
//                    trips detection. The self-host tunnel configures no transforms anyway.
// Fail-safe direction: a forged cf-* header on a LOCAL request only makes that request STRICTER
// (treated as tunnel), never weaker. A real tunnel request always carries cf-ray, so it can
// never be mis-read as local. The owner is never locked out; an attacker is never let in.
const CF_EDGE_HEADERS = [
	'cf-ray',
	'cf-connecting-ip',
	'cf-ipcountry',
	'cf-visitor',
	'true-client-ip',
	'x-forwarded-for'
];

/**
 * Did this request arrive over the public Cloudflare tunnel (vs. loopback/LAN/Tailscale)?
 * True if it carries any Cloudflare-edge-injected header. Used to lock the control plane:
 * over the tunnel only DEVICE tokens + the E2E WS path are accepted; the owner token and the
 * plaintext WS are LOCAL-only.
 * @param {import('node:http').IncomingMessage} req
 */
export function isTunnelRequest(req) {
	const h = req?.headers || {};
	return CF_EDGE_HEADERS.some((k) => typeof h[k] === 'string' && h[k] !== '');
}

/**
 * Is the request's Origin acceptable? An absent Origin (same-origin navigation
 * or a non-browser client) passes - the token is the real gate. A present,
 * non-matching Origin is rejected, which blocks cross-site WebSocket hijacking.
 * @param {import('node:http').IncomingMessage} req
 */
export function originOk(req) {
	const origin = req.headers?.origin;
	if (!origin) return true;
	let host;
	try {
		host = new URL(origin).host;
	} catch {
		return false;
	}
	if (host === req.headers.host) return true;
	if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return true;
	if (host === 'app.codeout.dev') return true; // the official hosted web client
	return EXTRA_ORIGINS.includes(origin) || EXTRA_ORIGINS.includes(host);
}

/** Validate the Bearer token on an API request as the OWNER token.
 *  The owner token is the static master secret. It is LOCAL-ONLY: a request that arrived
 *  over the public tunnel (Cloudflare headers present) is REJECTED here even if the token
 *  matches, so a leaked master secret can't drive the control plane remotely. Loopback/LAN/
 *  Tailscale requests (no CF headers) accept it as before - that's the local console bootstrap. */
export function apiTokenOk(req) {
	if (isTunnelRequest(req)) return false; // owner token never accepted over the tunnel
	const m = String(req.headers?.authorization || '').match(/^Bearer\s+(.+)$/i);
	return !!m && safeEq(m[1], TOKEN);
}

/** True if the request carries an accepted credential for the session endpoints:
 *  a valid paired-DEVICE token (always - local or tunnel), OR the OWNER token (LOCAL only).
 *  Over the tunnel only device tokens pass (apiTokenOk is already tunnel-gated); locally the
 *  owner token also works. Owner-only endpoints keep using apiTokenOk directly. */
export function apiAuthOk(req) {
	if (apiTokenOk(req)) return true; // owner token (local only - apiTokenOk is tunnel-gated)
	const m = String(req.headers?.authorization || '').match(/^Bearer\s+(.+)$/i);
	if (!m) return false;
	try { return !!devicePkForToken(m[1]); } catch { return false; } // device token: local OR tunnel
}

/** Extract the Bearer token from an API request, or null. */
export function bearerToken(req) {
	const m = String(req.headers?.authorization || '').match(/^Bearer\s+(.+)$/i);
	return m ? m[1] : null;
}

/** Validate the token passed as a WebSocket query param (browsers can't set WS headers). */
export function wsTokenOk(token) {
	return safeEq(token, TOKEN);
}
