// codeout daemon: the session API (/api/sessions) + a small static file server for the
// web UI + the PTY/WebSocket bridge, all on one HTTP server sharing one in-memory
// session map. The UI is the prebuilt webapp (sibling repo) copied into ./webui by
// `bun run build`; this daemon no longer carries its own SvelteKit source. Normally
// launched via the `codeout` CLI (cli.js); `node server.js` still works for a bare start.
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
import { attachPty } from './pty-bridge.js';
import { handleApi, restoreSessions } from './sessions.js';
import { isTunnelRequest } from './auth.js';

// The built web UI lives here (webapp build output, copied by `bun run build`).
const WEBUI_DIR = join(dirname(fileURLToPath(import.meta.url)), 'webui');
const INDEX = join(WEBUI_DIR, 'index.html');

// Minimal extension -> content-type map (only what the SPA build actually emits).
const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.ico': 'image/x-icon',
	'.webp': 'image/webp',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.map': 'application/json; charset=utf-8',
	'.txt': 'text/plain; charset=utf-8',
	'.wasm': 'application/wasm'
};
const mimeFor = (p) => MIME[extname(p).toLowerCase()] || 'application/octet-stream';

// Stream a file with the right content-type. `immutable` marks SvelteKit's hashed
// /_app/immutable assets as long-cache. Returns false if the path isn't a real file
// under WEBUI_DIR (caller then falls back to index.html).
function sendFile(res, abs, { immutable = false } = {}) {
	let st;
	try { st = statSync(abs); } catch { return false; }
	if (!st.isFile()) return false;
	res.writeHead(200, {
		'content-type': mimeFor(abs),
		'content-length': st.size,
		'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
		// nosniff: never let the browser MIME-sniff a static asset past its declared type.
		'x-content-type-options': 'nosniff'
	});
	// Explicit stream lifecycle so a client disconnect mid-download doesn't leak the fd:
	// destroy the read stream on res 'close', and fail clean on a read error.
	const rs = createReadStream(abs);
	res.on('close', () => rs.destroy());
	rs.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end(); });
	rs.pipe(res);
	return true;
}

// Serve a static file from ./webui with SPA fallback to index.html. Path-traversal is
// blocked by normalizing the decoded URL path and requiring the resolved absolute path
// to stay inside WEBUI_DIR. Non-file routes (client-side routes like /sessions) fall
// back to index.html so the SPA can boot and route in the browser.
function serveStatic(req, res) {
	const u = new URL(req.url, 'http://x');
	// The `?token=<owner>` URL bootstrap form is LOCAL-ONLY: it carries the static master secret
	// and must never travel over the public tunnel. If a tunnel request arrives with a `token`
	// query param, redirect to the same path with the query stripped (303 → the browser drops the
	// secret from its address bar / history and reloads clean). The hosted web app never uses
	// `?token=` (it pairs for a device token), so this only ever fires on a stray/local URL opened
	// remotely. Locally the form is untouched (the console bootstrap still works).
	if (isTunnelRequest(req) && u.searchParams.has('token')) {
		u.searchParams.delete('token');
		const dest = u.pathname + (u.searchParams.toString() ? `?${u.searchParams}` : '');
		res.writeHead(303, { location: dest, 'cache-control': 'no-store' });
		res.end();
		return;
	}
	let pathname;
	try { pathname = decodeURIComponent(u.pathname); } catch { pathname = '/'; }
	if (pathname === '/') pathname = '/index.html';

	// Normalize and pin under WEBUI_DIR. normalize() collapses ../ ; the prefix check
	// then rejects anything that escaped the root (defence in depth).
	const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
	const abs = join(WEBUI_DIR, rel);
	if (abs !== WEBUI_DIR && !abs.startsWith(WEBUI_DIR + '/')) {
		res.writeHead(403, { 'content-type': 'text/plain' });
		res.end('forbidden');
		return;
	}

	// Hashed build assets are content-addressed → cache hard.
	const immutable = rel.startsWith('_app/immutable/');
	if (sendFile(res, abs, { immutable })) return;

	// Not a real file: SPA fallback to index.html for navigations; 404 for asset-looking
	// requests (a missing /_app/... or a path with an extension) so broken assets are loud.
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		res.writeHead(405, { 'content-type': 'text/plain' }); res.end('method not allowed'); return;
	}
	if (extname(rel) && !sendFile(res, INDEX)) {
		res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return;
	}
	if (!extname(rel) && sendFile(res, INDEX)) return;
	if (!extname(rel)) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); }
}

/** Start the daemon HTTP server. Resolves once it is listening. */
export function startDaemon({ port = Number(process.env.PORT) || 8400, host = process.env.HOST || '127.0.0.1' } = {}) {
	const server = createServer(async (req, res) => {
		if (await handleApi(req, res)) return; // session API (shared map)
		serveStatic(req, res); // everything else -> static web UI (SPA)
	});
	attachPty(server);
	restoreSessions(); // reattach dtach sessions that survived a restart
	return new Promise((resolve) => server.listen(port, host, () => resolve({ server, port, host })));
}

// `node server.js` => classic bare start. Importing this module does NOT auto-listen,
// so cli.js can call startDaemon() after it prints the banner + pairing info.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const { TOKEN } = await import('./auth.js');
	const { port, host } = await startDaemon();
	console.log(`codeout -> http://${host}:${port}`);
	console.log(`pair this browser once by opening:\n  http://${host}:${port}/?token=${TOKEN}`);
}
