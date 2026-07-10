<div align="center">

<img src="codeoutlogo.png" alt="codeout logo" width="200" />

# codeout

<sub>est. 2026</sub>

**Your AI coding agents, self-hosted, in your pocket.**

```sh
bun install -g codeoutcli && codeout
```

Run Claude, Codex, Gemini, or a plain shell on your own machine, and drive them from your phone, tablet, or browser. Your code never leaves home. Neither do you have to.

</div>

---

## Why

You kicked off a long agent run, closed the laptop, and went outside like a functioning adult. Now you want to check on it without SSH gymnastics and a tmux cheat sheet taped to your wrist. That is codeout.

No cloud. No relay. No account. The agent runs on your hardware; codeout is just the window you reach it through.

## What you get

- **Runs on your machine.** The daemon lives on your box, with your files, your git, your tools. Your code never leaves home.
- **Claude, Codex, Gemini, or bash.** Pick an agent per session, or drop to a plain shell, and run several at once (mix agents if the mood takes you). codeout drives whichever agent CLIs are on your machine and quietly hides the ones that aren't, so nobody has to feel left out.
- **Every device, same sessions.** Pair your phone, tablet, and laptop. They all drive the same live sessions on the same machine.
- **Public by default.** Running it opens an end-to-end-encrypted tunnel and gives this machine a stable address that does not change. Prefer your own network only? `--local`.
- **Reboot-proof.** Install it as a service and it comes back on boot, same address, sessions reattached. Devices reconnect on their own.
- **End-to-end encrypted.** The device-to-daemon channel is sealed with libsodium, even over an untrusted tunnel. No middleman reads your `// TODO: fix later` collection.

## Install

```sh
bun install -g codeoutcli
```

Also installs with `npm i -g codeoutcli`. Needs Node 20+ and [`cloudflared`](https://github.com/cloudflare/cloudflared) for the public tunnel (skip it and run `--local` if you only want your own network). The native pty ships prebuilt, so there is no compile step.

**Runs natively on macOS, Linux, and Windows.** On macOS/Linux, [`dtach`](https://github.com/crigler/dtach) keeps terminal sessions alive across a daemon restart. Windows runs the agent directly under ConPTY (no `dtach`): terminal sessions survive a client disconnect but not a daemon restart, and chat sessions resume either way. On Windows, install the CLI (it asks which agents you want) with `irm https://codeout.dev/install.ps1 | iex`.

## Agents

codeout doesn't ship an AI of its own; it drives the ones you already pay for. Install any mix of:

- **Claude** - the Claude Code CLI (`claude`)
- **Codex** - `npm i -g @openai/codex`
- **Gemini** - `bun i -g @google/gemini-cli`

Or let the one-line installers at [codeout.dev](https://codeout.dev) do it — they ask which agents you want and skip any you already have. Whatever is on your PATH shows up in the picker; the rest stay politely off-screen. Each agent signs in with its own login (an existing subscription, OAuth, or an API key), so codeout never touches your keys and you never pay for the privilege twice. Add another agent's CLI later and it just appears, no reinstall, no ceremony.

## Quick start

```sh
# on your machine
codeout
# -> opens a public tunnel (your stable name.codeout.dev) + a QR + a typeable code
#    (use `codeout --local` to stay on your LAN / Tailscale instead)

# on your phone or browser
# open the app, enter the address + code (or scan the QR), start a session
```

Public by default, so it works from anywhere. Pass `--local` to keep it on your own network (LAN + Tailscale) with nothing exposed to the internet.

## Commands

```sh
codeout              run + open a public tunnel: a stable <name>.codeout.dev, reachable anywhere
codeout --local      local only (LAN + Tailscale); nothing is exposed to the internet
codeout --pair       print a fresh pairing code (QR + code) to add another device
codeout --install    run on boot, tunnel and all (add --local for local-only)
codeout --uninstall  remove the boot service
codeout --destroy    tear down this machine's tunnel and its DNS
codeout --port N     listen on a different port (default 8400)
codeout --help       show all of this
```

## Reach it from anywhere

Running `codeout` opens a Cloudflare tunnel **by default** and gives your machine a **stable** address, `something.codeout.dev`, derived from its own key. Same machine, same address, every time, so a device you paired last week still connects today.

Over the tunnel the daemon accepts only **paired-device tokens**, and the **terminal/chat stream is end-to-end encrypted** (sealed ciphertext the tunnel can't read). The owner token and the older plaintext stream are **local-only** (LAN / Tailscale / this machine); they're never accepted over the tunnel, so a leaked tunnel URL or token reaches a locked door. The device-token REST API rides the tunnel's TLS rather than the E2E channel, so it carries a device token, never the master secret. File attachments you send ride that same TLS path: encrypted in transit, but (unlike the chat stream) not end-to-end, so the tunnel provider terminates that TLS. Your code on the daemon host never moves; only what you explicitly upload crosses the wire.

Prefer your own setup?

```sh
codeout --local
```

Local-only: reach the daemon over your LAN, Tailscale, or any VPN you already run, with nothing exposed to the internet. Done with a public address? `codeout --destroy` tears the tunnel and its DNS back down.

## Run on boot

```sh
codeout --install
```

Installs a systemd user service (`Restart=always`, lingering enabled) so codeout starts on boot, opens its public tunnel, and keeps running after you close the terminal (add `--local` for local-only). The daemon runs in the background, so you ask for the pairing details on demand:

```sh
codeout --pair                     # show the QR + code to pair a device
systemctl --user status codeout    # check it
journalctl --user -u codeout -f    # follow the logs
codeout --uninstall                # remove the service
```

After a reboot the daemon comes back on the same address and reattaches your sessions; paired devices reconnect on their own.

## Add your other devices

From a device that is already paired, open **Settings -> Add a device** for a code, or run `codeout --pair` on the machine. Enter that code on the new device and it joins. Every paired device drives the same sessions. Revoke any device from Settings; revoke is instant and drops it mid-connection.

## How it works

Three parts, no surprises:

- **The daemon** runs on your computer. It starts your agent, keeps the session alive with `dtach`, and serves an encrypted channel.
- **Your devices** (phone, tablet, browser) pair once and give you a real terminal wherever you are. All the UI lives here.
- **A direct encrypted link** connects them. Device to daemon, end to end. Nothing in the middle, nothing to read your data, nothing to fall over at 3am and take your workflow down with it.

Most "code from your phone" tools route everything through their servers. codeout does not have servers. That is the whole point.

## Security

- Long-term `crypto_kx` keypairs per side: the device is the client, the daemon is the server.
- Each connection runs two `crypto_secretstream_xchacha20poly1305` streams, one per direction.
- Pairing is one-time, by QR or typeable code; private keys never leave your devices.
- Per-device tokens you can revoke, plus a daemon challenge on every connection that defeats whole-stream replay.

Wire details are in [PROTOCOL.md](./PROTOCOL.md). Found a hole? Open an issue. We would genuinely love to hear about it before someone else does.

## Status

Early. It works, it is tested, and it is moving fast, occasionally without asking permission first. Star it if you want to watch it grow up; open a PR if you want to help raise it.

## Built with

Bun, a small static file server for the prebuilt web UI (built from the sibling `webapp` repo into `webui/`), prebuilt node-pty, libsodium, and dtach for session persistence. JavaScript with JSDoc, because life is short.

## Contributing

Issues and pull requests welcome. Keep it simple, keep it self-hosted.

## License

[MIT](./LICENSE). Do what you like, just do not blame us.
