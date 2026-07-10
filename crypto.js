// codeout - end-to-end channel crypto (PROTOCOL.md v1).
//
// Vetted libsodium primitives only (no hand-rolled crypto): crypto_kx for the
// device/daemon key exchange, crypto_secretstream (XChaCha20-Poly1305) for the
// channel. The daemon is the trust root: it holds a long-term crypto_kx keypair;
// devices pair to it and register their own kx public key. Same library + framing
// as the Swift client (swift-sodium).
import sodium from 'libsodium-wrappers';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

const CODEOUT_HOME = process.env.CODEOUT_HOME || join(homedir(), '.codeout');
const ID_FILE = join(CODEOUT_HOME, 'identity.json');
const DEVICES_FILE = join(CODEOUT_HOME, 'devices.json');

/** Write a file atomically (tmp + rename) so a crash/power-loss mid-write can't leave a
 *  truncated JSON that the loader then reads as empty — which would silently drop every
 *  paired device or token. rename() is atomic on the same filesystem. */
function writeAtomic(path, data, mode) {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, data, { mode });
	renameSync(tmp, path);
}

let ready = false;
/** Must be awaited once before any other call (libsodium loads its WASM async). */
export async function initCrypto() {
	if (!ready) { await sodium.ready; ready = true; }
	return sodium;
}

const b64 = (u8) => sodium.to_base64(u8, sodium.base64_variants.URLSAFE_NO_PADDING);
const unb64 = (s) => sodium.from_base64(s, sodium.base64_variants.URLSAFE_NO_PADDING);

// ---- Daemon long-term identity (crypto_kx server keypair) ----
let identity = null;
export function loadIdentity() {
	if (identity) return identity;
	try {
		if (existsSync(ID_FILE)) {
			const j = JSON.parse(readFileSync(ID_FILE, 'utf8'));
			identity = { publicKey: unb64(j.publicKey), privateKey: unb64(j.privateKey) };
			return identity;
		}
	} catch { /* corrupt → regenerate */ }
	const kp = sodium.crypto_kx_keypair();
	identity = { publicKey: kp.publicKey, privateKey: kp.privateKey };
	try {
		mkdirSync(CODEOUT_HOME, { recursive: true, mode: 0o700 });
		writeAtomic(ID_FILE, JSON.stringify({ publicKey: b64(kp.publicKey), privateKey: b64(kp.privateKey) }, null, 2), 0o600);
	} catch (e) {
		console.error('[codeout] identity persist failed:', e?.message ?? e);
	}
	return identity;
}
export const daemonPublicKeyB64 = () => b64(loadIdentity().publicKey);

// ---- Device identity: bubble colour + avatar (daemon-side, single source of truth) ----
// `colour` is a palette KEY (not a hex value) from a fixed set; clients map it to their
// own theme. `pink` is the default/accent. `avatar` is a bounded data-URL image or null.
// Both are 2-way synced to all clients.
export const DEVICE_PALETTE = ['pink', 'emerald', 'violet', 'amber', 'sky', 'rose'];
const AVATAR_MAX_BYTES = 128 * 1024; // bound the data-URL so the device record stays small
/** True if `c` is one of the fixed palette keys. */
export const isValidColour = (c) => typeof c === 'string' && DEVICE_PALETTE.includes(c);
/**
 * True if `a` is a base64-encoded RASTER image data URL within the size cap.
 *
 * Avatars are broadcast verbatim to every client, so the mediatype is locked to a small
 * raster whitelist (png/jpeg/webp/gif). `data:image/svg+xml` and `data:text/html` (and any
 * non-image type) are stored-XSS vectors when a client renders them, so they are rejected.
 * The payload must be `;base64,` and must actually decode, so a malformed string can't slip
 * through the regex and then break a client that tries to render it.
 */
const AVATAR_RE = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;
export function isValidAvatar(a) {
	if (typeof a !== 'string') return false;
	if (Buffer.byteLength(a, 'utf8') > AVATAR_MAX_BYTES) return false;
	const m = AVATAR_RE.exec(a);
	if (!m) return false;
	// The base64 body must decode (and be non-empty) - reject a well-formed-looking but
	// invalid payload so we never broadcast garbage that errors on the client.
	try {
		const buf = Buffer.from(m[2], 'base64');
		return buf.length > 0;
	} catch {
		return false;
	}
}

// ---- Paired devices ----
// Cached in memory: the file was re-read + JSON.parsed on every WS connect, every API call,
// and every devices-updated refetch. The daemon is the ONLY writer, so the cache is the
// source of truth once loaded; every saveDevices() rewrites it in lockstep with the file.
let devicesCache = null;
function loadDevices() {
	if (devicesCache) return devicesCache;
	try { devicesCache = JSON.parse(readFileSync(DEVICES_FILE, 'utf8')); } catch { devicesCache = {}; }
	return devicesCache;
}
function saveDevices(d) {
	devicesCache = d; // keep the cache in lockstep with the file
	try { mkdirSync(CODEOUT_HOME, { recursive: true, mode: 0o700 }); writeAtomic(DEVICES_FILE, JSON.stringify(d, null, 2), 0o600); }
	catch (e) { console.error('[codeout] devices persist failed:', e?.message ?? e); }
}
/** Register a paired device's kx public key (base64url). Returns a device id. */
export function registerDevice(devicePkB64, name) {
	const d = loadDevices();
	const id = b64(sodium.randombytes_buf(8));
	d[id] = { pk: devicePkB64, name: (name || 'device').slice(0, 40), paired: Date.now() };
	saveDevices(d);
	return id;
}
/** A paired device's kx public key as a Uint8Array, or null. */
export function devicePublicKey(id) { const d = loadDevices(); return d[id]?.pk ? unb64(d[id].pk) : null; }

// ---- Push notification tokens (APNs), stored per device in devices.json ----
// Deliberately kept OUT of listDevices() so a device's push token never reaches clients.
/** Set or clear this device's APNs push token + the env it belongs to. */
export function setDevicePush(id, token, env) {
	const d = loadDevices();
	if (!d[id]) return false;
	if (token) {
		// An APNs token belongs to exactly one install. If an earlier pairing of the SAME
		// phone (a different device identity) still carries it, drop it there so the phone
		// can't end up a push target twice and get duplicate notifications.
		for (const [other, r] of Object.entries(d)) {
			if (other !== id && r.pushToken === token) { delete r.pushToken; delete r.apnsEnv; }
		}
		d[id].pushToken = token; d[id].apnsEnv = env || 'production';
	} else { delete d[id].pushToken; delete d[id].apnsEnv; }
	saveDevices(d);
	return true;
}
export function clearDevicePush(id) { return setDevicePush(id, null); }
/** Devices that have a push token, for fan-out; optionally exclude one (the sender).
 *  Deduped by token: one phone re-paired under several identities shares ONE APNs
 *  token, and APNs collapse only de-dups per token, so without this it would receive
 *  N copies of every alert. Belt-and-suspenders with setDevicePush's cleanup. */
export function pushTargets(excludeId) {
	const d = loadDevices();
	const seen = new Set();
	const out = [];
	for (const [id, r] of Object.entries(d)) {
		if (!r.pushToken || id === excludeId) continue;
		if (seen.has(r.pushToken)) continue;   // same token (same phone, re-paired) — one push only
		seen.add(r.pushToken);
		out.push({ id, token: r.pushToken, env: r.apnsEnv || 'production' });
	}
	return out;
}

// ---- One-time pairing codes (in-memory, single-use, 5-min TTL) ----
// Human-typeable so a device can pair BY HAND when scanning a QR is not possible.
// Crockford base32 (no ambiguous I/L/O/U), 12 chars = 60 bits, shown XXXX-XXXX-XXXX.
// The QR carries the same raw code; manual entry tolerates dashes, spaces, and case.
const PAIR_CODE_TTL = 5 * 60 * 1000;
const pairCodes = new Map(); // raw code -> expiryMs
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford (drops I L O U)
function toBase32(bytes) {
	let bits = 0, val = 0, out = '';
	for (const b of bytes) {
		val = (val << 8) | b; bits += 8;
		while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
	}
	if (bits > 0) out += B32[(val << (5 - bits)) & 31];
	return out;
}
/** Normalize a typed code: upper-case, strip separators, map look-alikes to Crockford. */
export function normalizePairCode(s) {
	return String(s).toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');
}
/** Group a raw code for display: XXXX-XXXX-XXXX. */
export const formatPairCode = (raw) => (raw.match(/.{1,4}/g) || [raw]).join('-');
export function mintPairCode() {
	const raw = toBase32(sodium.randombytes_buf(8)).slice(0, 12); // 60 bits
	pairCodes.set(raw, Date.now() + PAIR_CODE_TTL);
	return raw;
}
/** Short, comparable fingerprint of the daemon public key for manual pairing:
 *  the user confirms the app shows the same value codeout printed -> defeats MITM. */
export function daemonFingerprint() {
	return formatPairCode(toBase32(sodium.crypto_generichash(10, loadIdentity().publicKey)).slice(0, 8)); // XXXX-XXXX
}
/** Verify + consume a one-time pairing code (single-use, must be unexpired). */
export function consumePairCode(code) {
	const key = normalizePairCode(code);
	const exp = pairCodes.get(key);
	if (exp == null) return false;
	pairCodes.delete(key); // single-use, even on failure
	return Date.now() < exp;
}

// ---- Device tokens (32-byte) bound to a device kx pubkey, persisted ----
// Cached in memory like devices: looked up on every auth check + WS connect. Daemon-only
// writer, so the cache is authoritative once loaded; saveTokens() updates both together.
const TOKENS_FILE = join(CODEOUT_HOME, 'device-tokens.json');
let tokensCache = null;
function loadTokens() {
	if (tokensCache) return tokensCache;
	try { tokensCache = JSON.parse(readFileSync(TOKENS_FILE, 'utf8')); } catch { tokensCache = {}; }
	return tokensCache;
}
function saveTokens(t) {
	tokensCache = t; // keep the cache in lockstep with the file
	try { mkdirSync(CODEOUT_HOME, { recursive: true, mode: 0o700 }); writeAtomic(TOKENS_FILE, JSON.stringify(t, null, 2), 0o600); }
	catch (e) { console.error('[codeout] device-tokens persist failed:', e?.message ?? e); }
}
/** Mint a 32-byte device token bound to a device kx pubkey (base64url). */
export function mintDeviceToken(devicePkB64, name) {
	const token = b64(sodium.randombytes_buf(32));
	const t = loadTokens();
	t[token] = { devicePk: devicePkB64, name: (name || 'device').slice(0, 40), created: Date.now() };
	saveTokens(t);
	return token;
}
/** Look up a device's kx public key (Uint8Array) from its token, or null. */
export function devicePkForToken(token) {
	if (typeof token !== 'string' || !token) return null;
	const rec = loadTokens()[token];
	return rec?.devicePk ? unb64(rec.devicePk) : null;
}

// ---- Device management (listing + revocation) ----
/** All paired devices for the settings UI: [{ id, name, paired, colour, avatar }].
 *  Old records without colour/avatar are backward-compatible: colour falls back to the
 *  default palette key (`pink`), avatar to null. */
export function listDevices() {
	const d = loadDevices();
	return Object.entries(d)
		.map(([id, v]) => ({
			id,
			name: v.name,
			paired: v.paired,
			colour: isValidColour(v.colour) ? v.colour : DEVICE_PALETTE[0],
			avatar: typeof v.avatar === 'string' ? v.avatar : null
		}))
		.sort((a, b) => a.paired - b.paired);
}

/** Update a paired device's identity (name / colour / avatar). Permissive: any caller may
 *  edit any device (flat trust, matches the revoke-anyone model). Only the fields present in
 *  `patch` are touched. Returns true if the device exists and was persisted, false if the id
 *  is unknown. Callers validate colour/avatar with isValidColour/isValidAvatar first. */
export function updateDevice(id, patch) {
	const d = loadDevices();
	const dev = d[id];
	if (!dev) return false;
	if (typeof patch.name === 'string') dev.name = patch.name.slice(0, 40);
	if (typeof patch.colour === 'string') dev.colour = patch.colour;
	if (patch.avatar === null) delete dev.avatar;
	else if (typeof patch.avatar === 'string') dev.avatar = patch.avatar;
	saveDevices(d);
	return true;
}
/** The device id a token belongs to (matches the token's kx pubkey), or null. */
export function deviceIdForToken(token) {
	const rec = loadTokens()[token];
	if (!rec?.devicePk) return null;
	const d = loadDevices();
	return Object.keys(d).find((id) => d[id].pk === rec.devicePk) || null;
}
/** Revoke a device: drop it from the registry AND delete every token bound to its kx
 *  pubkey. Returns the device's kx pubkey (base64url) so the caller can close live
 *  connections, or null if the id was unknown. */
export function revokeDevice(id) {
	const d = loadDevices();
	const dev = d[id];
	if (!dev) return null;
	const pk = dev.pk;
	delete d[id];
	saveDevices(d);
	const t = loadTokens();
	let changed = false;
	for (const tok of Object.keys(t)) {
		if (t[tok].devicePk === pk) { delete t[tok]; changed = true; }
	}
	if (changed) saveTokens(t);
	return pk;
}

// ---- Channel handshake challenge (replay protection, PROTOCOL.md v2) ----
export function randomChallenge() { return sodium.randombytes_buf(16); }
/** Constant-time equality of two Uint8Arrays. */
export function ctEqual(a, b) {
	if (!a || !b || a.length !== b.length) return false;
	return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ---- Session keys + secretstream framing ----
/** Daemon-side session keys for a given device kx public key. → {sharedRx, sharedTx} */
export function serverSessionKeys(devicePkU8) {
	const id = loadIdentity();
	return sodium.crypto_kx_server_session_keys(id.publicKey, id.privateKey, devicePkU8);
}
/** Start a send stream keyed by `txKey`. → {state, header(24 bytes)} */
export function pushInit(txKey) { return sodium.crypto_secretstream_xchacha20poly1305_init_push(txKey); }
/** Start a receive stream from a peer header keyed by `rxKey`. → state */
export function pullInit(header, rxKey) { return sodium.crypto_secretstream_xchacha20poly1305_init_pull(header, rxKey); }
/** Encrypt one message frame. */
export function encrypt(state, msgU8) {
	return sodium.crypto_secretstream_xchacha20poly1305_push(state, msgU8, null, sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE);
}
/** Decrypt one message frame, or null if it fails (tamper / wrong key). */
export function decrypt(state, cipherU8) {
	const r = sodium.crypto_secretstream_xchacha20poly1305_pull(state, cipherU8);
	return r ? r.message : null;
}

export const _b64 = b64;
export const _unb64 = unb64;
