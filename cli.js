#!/usr/bin/env node
// codeout - the command users run. Prints the banner, starts the daemon, and shows
// how to pair a device (QR + a typeable code + the daemon fingerprint).
//
//   codeout            local + LAN + Tailscale (default; nothing is exposed publicly)
//   codeout --public   also open a Cloudflare tunnel so you can reach it from anywhere
//   codeout --local    explicit local-only (this is the default)
//   codeout --port N   listen on port N (default 8400)
//   codeout --help
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-terminal';
import { startDaemon } from './server.js';
import { TOKEN } from './auth.js';
import { initCrypto, loadIdentity, daemonPublicKeyB64, daemonFingerprint, mintPairCode, formatPairCode } from './crypto.js';
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const CODEOUT_HOME = process.env.CODEOUT_HOME || join(os.homedir(), '.codeout');
const TUNNEL_FILE = join(CODEOUT_HOME, 'tunnel.json'); // last broker tunnel, for `--destroy`

const pink = (s) => `\x1b[38;2;255;106;193m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

// pixel CODEOUT
const BANNER = [
	'█████ █████ ████  █████ █████ █   █ █████',
	'█     █   █ █   █ █     █   █ █   █   █  ',
	'█     █   █ █   █ ███   █   █ █   █   █  ',
	'█     █   █ █   █ █     █   █ █   █   █  ',
	'█████ █████ ████  █████ █████ █████   █  '
];

const HELP = `
${pink('codeout')} - your AI coding agents, self-hosted, in your pocket

  codeout            run + open a public tunnel: a stable <name>.codeout.dev, reachable anywhere
  codeout --local    local only (LAN + Tailscale); nothing is exposed to the internet
  codeout --port N   listen on port N (default 8400)
  codeout --pair     print a fresh pairing code to add another device
  codeout --install  start on boot (opens the tunnel; add --local for local-only)
  codeout --uninstall remove the boot service
  codeout --destroy  tear down this machine's tunnel + its DNS
  codeout --help     show this

Your code never leaves your machine. Over the public tunnel the daemon accepts only
PAIRED-DEVICE tokens, and the terminal/chat stream is end-to-end encrypted (sealed
ciphertext the tunnel can't read). The owner token and the plaintext stream are
local-only (LAN / Tailscale / this machine); they never work over the tunnel.
`;

function parseArgs() {
	const a = process.argv.slice(2);
	const i = a.indexOf('--port');
	const KNOWN = new Set(['--public', '--local', '--pair', '--install', '--uninstall', '--destroy', '--yes', '-y', '--help', '-h', '--port']);
	return {
		public: a.includes('--public'),
		local: a.includes('--local'),
		pair: a.includes('--pair'),
		destroy: a.includes('--destroy'),
		install: a.includes('--install'),
		uninstall: a.includes('--uninstall'),
		yes: a.includes('--yes') || a.includes('-y'),
		help: a.includes('--help') || a.includes('-h'),
		port: Number(i >= 0 ? a[i + 1] : process.env.PORT) || 8400,
		// flag-looking tokens we don't recognise (catches typos like --destory)
		unknown: a.filter((t, idx) => t.startsWith('-') && !KNOWN.has(t) && a[idx - 1] !== '--port')
	};
}

function lanIPs() {
	const out = [];
	for (const ifs of Object.values(os.networkInterfaces())) {
		for (const i of ifs || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
	}
	return out;
}

// Quick Cloudflare tunnel (no account, ephemeral *.trycloudflare.com). Needs `cloudflared`
// on PATH. Returns the public URL, or null if cloudflared is missing / did not come up.
function openTunnel(port) {
	return new Promise((resolve) => {
		let proc;
		try {
			proc = spawn('cloudflared', ['--no-autoupdate', 'tunnel', '--url', `http://localhost:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
		} catch {
			return resolve(null);
		}
		let url = null;
		const scan = (b) => {
			const m = String(b).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
			if (m && !url) { url = m[0]; resolve(url); }
		};
		proc.stdout.on('data', scan);
		proc.stderr.on('data', scan);
		proc.on('error', () => resolve(null));
		setTimeout(() => resolve(url), 15000);
	});
}

// Managed broker: ask broker.codeout.dev for a clean slug.codeout.dev + connector token,
// then run it over http2. Returns the https URL, or null to fall back to a quick-tunnel.
async function brokerTunnel(port) {
	if (port !== 8400) return null; // the broker provisions for the default port
	let reg;
	try {
		const r = await fetch('https://broker.codeout.dev/register', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ pubkey: daemonPublicKeyB64() })
		});
		if (!r.ok) return null;
		reg = await r.json();
	} catch { return null; }
	if (!reg?.hostname || !reg?.token) return null;
	return new Promise((resolve) => {
		let done = false;
		const finish = (v) => { if (!done) { done = true; resolve(v); } };
		let proc;
		try {
			// global flags (--no-autoupdate) MUST precede the `tunnel` subcommand, else
			// cloudflared rejects the flag, prints usage, and exits 0 without connecting.
			proc = spawn('cloudflared', ['--no-autoupdate', 'tunnel', 'run', '--protocol', 'http2', '--token', reg.token], { stdio: ['ignore', 'pipe', 'pipe'] });
		} catch { return finish(null); }
		const scan = (b) => { if (/Registered tunnel connection/.test(String(b))) { saveTunnel({ tunnel: reg.tunnel, hostname: reg.hostname, token: reg.token }); finish(`https://${reg.hostname}`); } };
		proc.stdout.on('data', scan);
		proc.stderr.on('data', scan);
		proc.on('error', () => finish(null));
		proc.on('exit', () => finish(null)); // exited before a live connection -> fall back, don't claim success
		setTimeout(() => finish(null), 25000); // never connected in time -> fall back instead of lying "ready"
	});
}

// Remember the broker tunnel we just opened so `--destroy` can tear it down later.
function saveTunnel(rec) {
	try { mkdirSync(CODEOUT_HOME, { recursive: true, mode: 0o700 }); writeFileSync(TUNNEL_FILE, JSON.stringify(rec, null, 2), { mode: 0o600 }); }
	catch { /* non-fatal: --destroy just won't have a record */ }
}

function confirm(q) {
	return new Promise((resolve) => {
		if (!process.stdin.isTTY) return resolve(true); // headless: assume intent
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		rl.question(q + ' [y/N] ', (ans) => { rl.close(); resolve(/^y(es)?$/i.test(ans.trim())); });
	});
}

// Ask a daemon that's ALREADY running for a fresh pairing code (so `--pair` doesn't
// start a second one). Returns the code payload, or null if nothing is listening.
async function mintAgainstRunning(port) {
	try {
		const r = await fetch(`http://127.0.0.1:${port}/api/pair/code`, { headers: { authorization: `Bearer ${TOKEN}` } });
		return r.ok ? await r.json() : null;
	} catch { return null; }
}

function printNewDevice(got, port) {
	const ips = lanIPs();
	const lan = `${ips.find((x) => x.startsWith('100.')) || ips.find((x) => x.startsWith('192.168.') || x.startsWith('10.')) || 'localhost'}:${port}`;
	// If this host has a public tunnel (saved on --public), pair against that stable
	// hostname so the new device works from anywhere, not just the LAN.
	let publicHost = null;
	try { publicHost = JSON.parse(readFileSync(TUNNEL_FILE, 'utf8'))?.hostname || null; } catch { /* no tunnel on record */ }
	const address = publicHost || lan;
	const uri = `codeout://pair?host=${encodeURIComponent(address)}&spk=${daemonPublicKeyB64()}&c=${got.code}&v=2`;
	let qr = '';
	qrcode.generate(uri, { small: true }, (o) => { qr = o; });
	console.log();
	console.log('  ' + bold('Pair a new device') + dim('  scan the QR, or type the code'));
	console.log(qr.replace(/\n/g, '\n    ').replace(/^/, '    '));
	console.log('    address      ' + address + (publicHost ? dim('   public') : dim('   (or your --public host)')));
	if (publicHost) console.log('    local        ' + dim(lan));
	console.log('    code         ' + pink(got.display || formatPairCode(got.code)) + dim('   valid 5 min'));
	console.log('    fingerprint  ' + bold(got.fingerprint || daemonFingerprint()));
	console.log();
}

// Tear down this machine's broker tunnel + its DNS (the broker checks the token belongs
// to the tunnel, so only its owner can remove it).
async function destroy(skipConfirm) {
	if (!existsSync(TUNNEL_FILE)) { console.log(dim('  No public tunnel on record for this machine. Nothing to destroy.')); return; }
	let t;
	try { t = JSON.parse(readFileSync(TUNNEL_FILE, 'utf8')); }
	catch { try { unlinkSync(TUNNEL_FILE); } catch { /* ignore */ } console.log(dim('  tunnel record was unreadable; removed it.')); return; }
	console.log('  This removes the tunnel ' + bold(t.hostname || t.tunnel) + ' and its DNS.');
	if (!skipConfirm && !(await confirm('  Destroy it?'))) { console.log(dim('  cancelled.')); return; }
	try {
		const r = await fetch('https://broker.codeout.dev/deregister', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ tunnel: t.tunnel, token: t.token, hostname: t.hostname })
		});
		const j = await r.json().catch(() => ({}));
		if (r.ok && j.ok) console.log(pink('  destroyed') + dim('  ' + (t.hostname || '')));
		else console.log(dim('  broker could not remove it: ' + (j.error || r.status)));
	} catch (e) { console.log(dim('  could not reach the broker: ' + (e?.message ?? e))); }
	try { unlinkSync(TUNNEL_FILE); } catch { /* ignore */ }
}

// systemd user unit that runs codeout on boot (Restart=always). The public tunnel is on
// by default, so the daemon returns on its stable address after a reboot; --local is baked
// in only if the user chose local-only.
function serviceUnit(opts) {
	const run = [process.execPath, fileURLToPath(import.meta.url)];
	if (opts.local) run.push('--local');
	if (opts.port && opts.port !== 8400) run.push('--port', String(opts.port));
	return `[Unit]
Description=codeout - self-hosted AI coding agents, in your pocket
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${run.join(' ')}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;
}

function install(opts) {
	if (process.platform === 'win32') {
		// dtach is Unix-only, so on Windows sessions survive client disconnects but not a daemon restart.
		const run = [process.execPath, fileURLToPath(import.meta.url)];
		if (opts.local) run.push('--local');
		if (opts.port && opts.port !== 8400) run.push('--port', String(opts.port));
		const cmdStr = run.map((s) => (s.includes(' ') ? `"${s}"` : s)).join(' ');
		try { execFileSync('schtasks', ['/create', '/tn', 'codeout', '/tr', cmdStr, '/sc', 'onlogon', '/f'], { stdio: 'ignore' }); }
		catch (e) {
			console.log(dim('  failed to create Scheduled Task: ' + (e?.message ?? e)));
			return;
		}
		console.log();
		console.log('  ' + pink('installed') + ' - codeout starts on logon' + (opts.local ? ' (local only - LAN + Tailscale).' : ' with a public tunnel.'));
		console.log('    status   ' + dim('schtasks /query /tn codeout'));
		console.log('    pair     ' + dim('codeout --pair'));
		console.log('    remove   ' + dim('codeout --uninstall'));
		console.log();
		return;
	}

	const dir = join(os.homedir(), '.config', 'systemd', 'user');
	const unit = join(dir, 'codeout.service');
	mkdirSync(dir, { recursive: true });
	writeFileSync(unit, serviceUnit(opts));
	const user = os.userInfo().username;
	// linger lets the service start at boot without an active login (headless servers).
	try { execFileSync('loginctl', ['enable-linger', user], { stdio: 'ignore' }); }
	catch { console.log(dim('  note: could not enable linger; run `sudo loginctl enable-linger ' + user + '` so it starts at boot.')); }
	try {
		execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
		execFileSync('systemctl', ['--user', 'enable', '--now', 'codeout'], { stdio: 'inherit' });
	} catch (e) {
		console.log(dim('  wrote ' + unit + ', but `systemctl --user` failed: ' + (e?.message ?? e)));
		console.log(dim('  start it manually with: systemctl --user enable --now codeout'));
		return;
	}
	console.log();
	console.log('  ' + pink('installed') + ' - codeout starts on boot' + (opts.local ? ' (local only - LAN + Tailscale).' : ' with a public tunnel.'));
	console.log('    logs     ' + dim('journalctl --user -u codeout -f'));
	console.log('    status   ' + dim('systemctl --user status codeout'));
	console.log('    pair     ' + dim('codeout --pair'));
	console.log('    remove   ' + dim('codeout --uninstall'));
	console.log();
}

function uninstall() {
	if (process.platform === 'win32') {
		try { execFileSync('schtasks', ['/delete', '/tn', 'codeout', '/f'], { stdio: 'ignore' }); } catch { /* already gone */ }
		console.log(dim('  removed the codeout logon task.'));
		return;
	}
	try { execFileSync('systemctl', ['--user', 'disable', '--now', 'codeout'], { stdio: 'ignore' }); } catch { /* not enabled */ }
	try { unlinkSync(join(os.homedir(), '.config', 'systemd', 'user', 'codeout.service')); } catch { /* already gone */ }
	try { execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' }); } catch { /* ignore */ }
	console.log(dim('  removed the codeout boot service.'));
}

const args = parseArgs();
if (args.help) { console.log(HELP); process.exit(0); }
if (args.unknown.length) {
	console.error('  unknown option: ' + args.unknown.join(' '));
	console.log(HELP);
	process.exit(1);
}
if (args.uninstall) { uninstall(); process.exit(0); }
if (args.install) { install(args); process.exit(0); }

await initCrypto();
loadIdentity();

if (args.destroy) { await destroy(args.yes); process.exit(0); }
if (args.pair) {
	// A freshly-installed service may still be binding the port, so retry briefly.
	// Never fall through to starting a daemon here - that races the service for the port.
	let got = null;
	for (let i = 0; i < 6 && !got; i++) {
		got = await mintAgainstRunning(args.port);
		if (!got && i < 5) await new Promise((r) => setTimeout(r, 500));
	}
	if (got) { printNewDevice(got, args.port); process.exit(0); }
	console.log(dim(`  codeout is not running on port ${args.port}. Start it (codeout, or codeout --install), then run codeout --pair.`));
	process.exit(1);
}

const { port } = await startDaemon({ port: args.port, host: '0.0.0.0' });

const ips = lanIPs();
const ts = ips.find((i) => i.startsWith('100.'));
const lan = ips.find((i) => i.startsWith('192.168.') || i.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(i));
let address = `${ts || lan || 'localhost'}:${port}`;
let publicUrl = null;

console.log();
for (const row of BANNER) console.log('  ' + pink(row));
console.log();
console.log('  ' + dim('self-hosted AI coding agents, in your pocket'));
console.log();

if (!args.local) {
	process.stdout.write('  opening tunnel ' + dim('(codeout.dev)') + ' ... ');
	publicUrl = await brokerTunnel(port);
	if (!publicUrl) { process.stdout.write(dim('broker unavailable, quick-tunnel ... ')); publicUrl = await openTunnel(port); }
	if (publicUrl) { console.log(pink('ready')); address = publicUrl.replace(/^https?:\/\//, ''); }
	else { console.log(dim('no tunnel (install cloudflared) - staying local.')); }
}

const code = mintPairCode();
const uri = `codeout://pair?host=${encodeURIComponent(address)}&spk=${daemonPublicKeyB64()}&c=${code}&v=2`;
let qr = '';
qrcode.generate(uri, { small: true }, (out) => { qr = out; });

console.log('  ' + bold('Console') + dim('  (this machine)'));
console.log('    http://localhost:' + port + '/?token=' + TOKEN);
console.log();
console.log('  ' + bold('Pair a device') + dim('  scan the QR, or type the code'));
console.log(qr.replace(/\n/g, '\n    ').replace(/^/, '    '));
console.log('    address      ' + (publicUrl || address));
console.log('    code         ' + pink(formatPairCode(code)) + dim('   valid 5 min'));
console.log('    fingerprint  ' + bold(daemonFingerprint()) + dim('   confirm this matches in the app'));
console.log();
console.log('  ' + (publicUrl
	? dim('Reachable from anywhere via the tunnel above. The link stays end-to-end encrypted.')
	: dim('Local only (LAN + Tailscale). Run `codeout` with no flag to open a public tunnel.')));
console.log('  ' + dim('Ctrl-C to stop. Your sessions keep running and reattach next launch.'));
console.log();
