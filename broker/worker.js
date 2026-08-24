// codeout tunnel broker - a Cloudflare Worker (serverless, no home-server dependency).
//
// POST /register  ->  provisions a named Cloudflare tunnel + a `<slug>.codeout.dev`
// hostname routed to the daemon, and returns { hostname, token }. The daemon then runs
//   cloudflared tunnel run --protocol http2 --token <token>
// and is reachable at https://<slug>.codeout.dev.
//
// The broker only PROVISIONS connectivity. The device<->daemon channel is end-to-end
// encrypted (crypto_kx + secretstream), so neither this Worker nor Cloudflare ever sees
// plaintext - it only hands out an address.
//
// Env (wrangler.toml [vars] + a secret):
//   ACCOUNT_ID  - Cloudflare account id (var)
//   ZONE_ID     - codeout.dev zone id (var)
//   CF_TOKEN    - API token with Account.Cloudflare Tunnel:Edit + Zone DNS:Edit (secret)
//   PORT        - local daemon port the tunnel routes to (var, default "8400")

const WORDS = [
	'amber', 'basil', 'cedar', 'delta', 'ember', 'fjord', 'glade', 'harbor', 'indigo',
	'juno', 'kelp', 'larch', 'mossy', 'nimbus', 'onyx', 'pebble', 'quartz', 'reef',
	'sage', 'tundra', 'umbra', 'vale', 'willow', 'xenon', 'yarrow', 'zephyr'
];
const pick = () => WORDS[Math.floor(Math.random() * WORDS.length)];
const makeSlug = () => `${pick()}-${pick()}-${Math.floor(Math.random() * 900 + 100)}`;
// Deterministic slug from a daemon's long-term public key, so the SAME machine always
// gets the SAME hostname (survives reboots; paired devices keep working).
async function slugFromPubkey(pubkey) {
	const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(pubkey))));
	return `${WORDS[h[0] % WORDS.length]}-${WORDS[h[1] % WORDS.length]}-${100 + (h[2] % 900)}`;
}

async function cf(env, path, method = 'GET', body) {
	const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
		method,
		headers: { Authorization: `Bearer ${env.CF_TOKEN}`, 'Content-Type': 'application/json' },
		body: body ? JSON.stringify(body) : undefined
	});
	const j = await res.json();
	if (!j.success) throw new Error(`CF ${method} ${path}: ${JSON.stringify(j.errors)}`);
	return j.result;
}

const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type'
};

export default {
	async fetch(req, env) {
		const url = new URL(req.url);
		if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

		// Tear down a tunnel + its DNS (`codeout --destroy`). Auth: the connector token is
		// base64(JSON) carrying t = tunnel id, so only the holder of this tunnel's token can
		// remove it. No global secret needed.
		if (req.method === 'POST' && url.pathname === '/deregister') {
			let body;
			try { body = await req.json(); } catch { body = {}; }
			const { tunnel, token, hostname } = body || {};
			if (!tunnel || !token) return Response.json({ error: 'tunnel + token required' }, { status: 400, headers: CORS });
			let tid = null;
			try { tid = JSON.parse(atob(token)).t; } catch { /* malformed token */ }
			if (tid !== tunnel) return Response.json({ error: 'token does not match tunnel' }, { status: 403, headers: CORS });
			try {
				if (hostname) {
					const recs = await cf(env, `/zones/${env.ZONE_ID}/dns_records?name=${hostname}`);
					for (const r of recs) await cf(env, `/zones/${env.ZONE_ID}/dns_records/${r.id}`, 'DELETE').catch(() => {});
				}
				await cf(env, `/accounts/${env.ACCOUNT_ID}/cfd_tunnel/${tunnel}?cascade=true`, 'DELETE');
				return Response.json({ ok: true }, { headers: CORS });
			} catch (e) {
				return Response.json({ error: String(e?.message ?? e) }, { status: 502, headers: CORS });
			}
		}

		if (req.method !== 'POST' || url.pathname !== '/register') {
			return new Response('codeout tunnel broker', { status: 200, headers: CORS });
		}
		const port = env.PORT || '8400';
		let body = {};
		try { body = await req.json(); } catch { /* no body -> anonymous random slug */ }
		// Deterministic hostname when the daemon sends its pubkey: same machine -> same
		// subdomain on every boot, so paired devices reconnect after a reboot. Anonymous
		// callers still get a random slug.
		const slug = body && body.pubkey ? await slugFromPubkey(body.pubkey) : makeSlug();
		const name = `codeout-${slug}`;
		const host = `${slug}.codeout.dev`;
		try {
			// Reuse this identity's tunnel if it already exists, else create one. Idempotent:
			// re-registering the same machine returns the same hostname + tunnel.
			const existing = await cf(env, `/accounts/${env.ACCOUNT_ID}/cfd_tunnel?is_deleted=false&per_page=200`);
			let tun = existing.find((t) => t.name === name);
			const created = !tun;
			if (!tun) tun = await cf(env, `/accounts/${env.ACCOUNT_ID}/cfd_tunnel`, 'POST', { name, config_src: 'cloudflare' });
			try {
				const token = await cf(env, `/accounts/${env.ACCOUNT_ID}/cfd_tunnel/${tun.id}/token`, 'GET');
				await cf(env, `/accounts/${env.ACCOUNT_ID}/cfd_tunnel/${tun.id}/configurations`, 'PUT', {
					config: { ingress: [{ hostname: host, service: `http://localhost:${port}` }, { service: 'http_status:404' }] }
				});
				// Upsert the hostname's CNAME -> this tunnel (create, or update if the id changed).
				const recs = await cf(env, `/zones/${env.ZONE_ID}/dns_records?name=${host}`);
				const content = `${tun.id}.cfargotunnel.com`;
				if (recs.length) {
					if (recs[0].content !== content) await cf(env, `/zones/${env.ZONE_ID}/dns_records/${recs[0].id}`, 'PUT', { type: 'CNAME', name: host, content, proxied: true });
				} else {
					await cf(env, `/zones/${env.ZONE_ID}/dns_records`, 'POST', { type: 'CNAME', name: host, content, proxied: true });
				}
				return Response.json({ hostname: host, token, tunnel: tun.id }, { headers: CORS });
			} catch (inner) {
				if (created) await cf(env, `/accounts/${env.ACCOUNT_ID}/cfd_tunnel/${tun.id}?cascade=true`, 'DELETE').catch(() => {});
				throw inner;
			}
		} catch (e) {
			return Response.json({ error: String(e?.message ?? e) }, { status: 502, headers: CORS });
		}
	},

	// Cron: reap idle/orphan broker tunnels (no live connector, past grace) + their DNS.
	async scheduled(event, env) {
		const GRACE_MS = 7 * 24 * 60 * 60 * 1000; // keep stable hostnames across reboots/downtime; only reap week-dead tunnels
		const now = Date.now();
		let tuns;
		try { tuns = await cf(env, `/accounts/${env.ACCOUNT_ID}/cfd_tunnel?is_deleted=false&per_page=200`); } catch { return; }
		for (const t of tuns) {
			if (!/^codeout-[a-z]+-[a-z]+-\d+$/.test(t.name)) continue;
			if (t.status !== 'inactive' || now - new Date(t.created_at).getTime() < GRACE_MS) continue;
			const host = `${t.name.replace(/^codeout-/, '')}.codeout.dev`;
			try {
				const recs = await cf(env, `/zones/${env.ZONE_ID}/dns_records?name=${host}`);
				for (const r of recs) await cf(env, `/zones/${env.ZONE_ID}/dns_records/${r.id}`, 'DELETE').catch(() => {});
			} catch (e) {}
			await cf(env, `/accounts/${env.ACCOUNT_ID}/cfd_tunnel/${t.id}?cascade=true`, 'DELETE').catch(() => {});
		}
	}
};
