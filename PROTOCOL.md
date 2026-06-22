# codeout wire protocol v2: pairing + end-to-end channel

> **v2** adds a daemon **challenge** to the channel handshake to defeat whole-stream replay,
> 32-byte device tokens, raw-byte input framing, and a Buffer-chunk server buffer. The
> crypto_kx + secretstream primitives are unchanged. Forward secrecy is a v3 item.

The single source of truth both the **daemon** (Node/Bun, `libsodium-wrappers`) and the
**iOS app** (Swift, `swift-sodium`) implement. Same libsodium primitives on both ends.
Threat model + rationale below: E2E protects the device/daemon channel across an untrusted
transport, and the daemon is trusted because it runs your shells (daemon-as-root).

## Identities (long-term)
- **Daemon** (trust root): a `crypto_kx` keypair, persisted `~/.codeout/identity.json`
  (private key mode 600). This is the "server" keypair.
- **Device** (phone/browser): a `crypto_kx` keypair generated on the device; private key in the
  iOS Keychain / browser storage. This is the "client" keypair.

## Pairing (device pairs TO the daemon)
1. Daemon shows a QR / link (in its already-authenticated web UI or console):
   `codeout://pair?host=<addr>&spk=<b64url daemon_kx_pubkey>&c=<b64url one_time_code>&v=1`
   - `one_time_code` = 16 random bytes, **single-use, short TTL (5 min)**, only shown in the
     trusted daemon UI. This is the pairing authenticator (not a replayable client-generated
     challenge).
2. Device scans, learning the daemon address, the daemon's kx pubkey, and the one-time code.
3. Device sends `POST /api/pair { devicePk: <b64url>, code: <b64url>, name }`. Daemon verifies the
   code (constant-time, single-use), registers `devicePk` in `~/.codeout/devices.json`, and
   returns a long-lived **32-byte device token** bound to this `devicePk` (daemon maps
   token to devicePk to derive session keys at `/pty` connect).
4. Both sides now hold each other's kx public keys.

## Session keys (`crypto_kx`)
- Daemon: `crypto_kx_server_session_keys(daemonPk, daemonSk, devicePk)` → `{sharedRx, sharedTx}`
- Device: `crypto_kx_client_session_keys(devicePk, deviceSk, daemonPk)` → `{sharedRx, sharedTx}`
- Guarantee: `server.sharedTx === client.sharedRx` and `server.sharedRx === client.sharedTx`.

## Encrypted channel (the `/pty` WebSocket; opt-in via `?e2e=1`)
Two independent `crypto_secretstream_xchacha20poly1305` streams, one per direction, each keyed by
the **sender's** tx key (from the `crypto_kx` session keys above).

Handshake (full-duplex; order between the two sides' headers does not matter):
1. Daemon, on connect, derives `serverSessionKeys(devicePk)` (devicePk from the token), `init_push(tx)`
   → 24-byte `header`, and picks a fresh random **16-byte challenge**. It sends the header as its
   first binary frame, then immediately the encrypted challenge frame `push(0x02 ‖ challenge)`.
   **The plaintext header MUST be sent before any ciphertext.**
2. Device `init_pull(daemonHeader, rx)` + `init_push(tx)` → sends its own 24-byte header, decrypts
   the daemon's challenge, and replies with `push(0x02 ‖ challenge)` as ITS first encrypted frame.
3. Daemon decrypts the device's first frame and checks it equals `0x02 ‖ <the challenge it issued>`
   (constant-time). Mismatch/absent closes `1008`. **This defeats whole-stream replay**: a replayer
   holding only old ciphertext cannot encrypt the daemon's *fresh* challenge.
4. Thereafter every frame is `push(state, type(1) ‖ payload)` / `pull`:
   - daemon → device: `0x00 ‖ <raw PTY bytes>` (binary; never a lossy UTF-8 string).
   - device → daemon: `0x00 ‖ <raw input bytes>` (node-pty writes a Buffer), or
     `0x01 ‖ cols(uint16 LE) ‖ rows(uint16 LE)` (resize).
   - daemon ↔ device: `0x03 ‖ <utf-8 JSON string>` (out-of-band JSON metadata for chat mode).
   - The replay buffer on reattach is sent as encrypted `0x00` frame(s) AFTER the header.

A tunnel sees only ciphertext, cannot replay (challenge), cannot derive keys (needs the device's
private kx key). **No forward secrecy yet** (static keys); v3 adds ephemeral-ephemeral kx with
static-key auth, Noise-style.

## Server-side buffer
Recent PTY output is kept as an **array of `Buffer` chunks**, NOT string concatenation (that
coerces Buffers to `"[object Buffer]"` and slices multibyte chars / surrogate pairs). Evict oldest
chunks past 256KB total; on reattach `Buffer.concat` and encrypt in one frame.

## Auth ordering on the WS
1. WS connects `?session=<id>&token=<token>` (+ `&e2e=1` to request encryption) + Origin check.
2. **Tunnel vs local gate.** A request bearing Cloudflare edge headers (`cf-ray`, `cf-connecting-ip`,
   …) arrived over the public tunnel; a loopback/LAN/Tailscale request straight to the port has none.
   - **Over the tunnel:** `e2e=1` is REQUIRED. The plaintext path (no `e2e`) is closed (`1008`), and
     the owner token is not accepted (only paired-DEVICE tokens). So a remote client must use a
     device token + the secretstream handshake.
   - **Locally:** the plaintext path + owner token still work (the local console bootstrap).
3. If `e2e=1`: token to devicePk lookup (unknown closes `1008`), then the challenge handshake above.
   Else (local only): plaintext JSON with the owner token.
4. Encrypted (or, locally, plaintext) PTY traffic.
A tunnel that can see a device token still cannot derive the session keys (those need the device's
private kx key, which never leaves the device) nor replay (the per-connection challenge); and it can
never use the owner token or the plaintext path at all (local-only).

## Not in scope here
- Vendor API keys: not handled, not stored server-side behind a shared secret. Agents
  authenticate via their own host login (e.g. `~/.claude`).
- Multi-device content re-sync (a DEK-per-session scheme) is unnecessary under daemon-as-root:
  the daemon holds the data, each device just opens an encrypted channel to it.

## Versioning
The QR carries `v=2`. Bump on any breaking change; daemon + app negotiate on `v`.
