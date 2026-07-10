# codeout tunnel broker

A Cloudflare Worker that gives every `codeout --public` user a clean `slug.codeout.dev`
URL with zero setup on their side. It provisions a named tunnel + DNS and returns a
connector token; the daemon runs that token. The Worker never sees plaintext (the
device-to-daemon channel stays end-to-end encrypted) - it only hands out an address.

## Deploy

Needs an API token with **Account.Cloudflare Tunnel: Edit + Zone DNS: Edit** (the
runtime token, stored as `CF_TOKEN`) and, to deploy the Worker itself, a token/login
with **Workers Scripts: Edit** (or deploy from the dashboard).

```sh
cd broker
bunx wrangler secret put CF_TOKEN      # paste the Tunnel+DNS token
bunx wrangler deploy                   # needs Workers:Edit auth
# then bind broker.codeout.dev/* -> this worker (dashboard or a [[routes]] entry)
```

`ACCOUNT_ID` and `ZONE_ID` are set in `wrangler.toml`.

## API

`POST https://broker.codeout.dev/register` -> `{ hostname, token, tunnel }`

The daemon then runs `cloudflared tunnel run --protocol http2 --token <token>` and is
reachable at `https://<hostname>`. `codeout --public` does this automatically and falls
back to a quick-tunnel if the broker is unreachable.

## TODO

- Rate-limit `/register` (KV: cap per IP/time) to prevent tunnel-spam abuse.
- A reaper (cron) to delete idle/abandoned tunnels so they do not accumulate.
- Optional `/release` to tear a tunnel down on clean exit.
