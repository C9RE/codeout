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
import platform from './platform/index.js';
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync, chmodSync, renameSync } from 'node:fs';
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

// The cloudflared binary to run: 'cloudflared' on PATH, or an auto-downloaded copy under
// ~/.codeout/bin. Set by ensureCloudflared() before any tunnel starts.
let CLOUDFLARED = 'cloudflared';

/** Make cloudflared available with zero manual install: use it if it's on PATH, else reuse a
 *  previously-downloaded copy, else fetch the right release binary into ~/.codeout/bin. On any
 *  failure it stays 'cloudflared' and the tunnel simply won't come up (the caller falls back). */
async function ensureCloudflared() {
	try { execFileSync('cloudflared', ['--version'], { stdio: 'ignore' }); return; } catch { /* not on PATH */ }
	const dir = join(CODEOUT_HOME, 'bin');
	const dest = join(dir, platform.cloudflaredBin);
	if (existsSync(dest)) { CLOUDFLARED = dest; return; }
	const asset = platform.cloudflaredAsset();
	if (!asset) return; // unknown arch — leave as 'cloudflared'
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		process.stdout.write('  ' + dim('fetching cloudflared (one-time) ... '));
		const r = await fetch(`https://github.com/cloudflare/cloudflared/releases/latest/download/${asset.name}`, { redirect: 'follow' });
		if (!r.ok) throw new Error('http ' + r.status);
		const buf = Buffer.from(await r.arrayBuffer());
		if (asset.tgz) {
			const tmp = join(dir, asset.name);
			writeFileSync(tmp, buf);
			execFileSync('tar', ['-xzf', tmp, '-C', dir], { stdio: 'ignore' }); // extracts a `cloudflared` binary
			try { unlinkSync(tmp); } catch { /* ignore */ }
		} else {
			// Atomic: write to a temp path then rename, so an interrupted write can't leave a
			// truncated binary that existsSync() would then reuse forever.
			const tmp = dest + '.tmp';
			writeFileSync(tmp, buf, { mode: 0o755 });
			renameSync(tmp, dest);
		}
		try { chmodSync(dest, 0o755); } catch { /* windows / already set */ }
		CLOUDFLARED = dest;
		console.log(pink('ok'));
	} catch (e) {
		console.log(dim('skipped (' + (e?.message ?? e) + ') — run with --local, or install cloudflared'));
	}
}

// Quick Cloudflare tunnel (no account, ephemeral *.trycloudflare.com). Uses the cloudflared
// resolved by ensureCloudflared(). Returns the public URL, or null if it did not come up.
function openTunnel(port) {
	return new Promise((resolve) => {
		let proc;
		try {
			proc = spawn(CLOUDFLARED, ['--no-autoupdate', 'tunnel', '--url', `http://localhost:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
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
			proc = spawn(CLOUDFLARED, ['--no-autoupdate', 'tunnel', 'run', '--protocol', 'http2', '--token', reg.token], { stdio: ['ignore', 'pipe', 'pipe'] });
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

// Boot service: install/uninstall are OS-specific (systemd on POSIX, Task Scheduler on
// Windows) and live in the platform layer. Here we only build the argv that launches the
// daemon and hand it over, so this file never branches on the OS.
function install(opts) {
	const execArgs = [process.execPath, fileURLToPath(import.meta.url)];
	if (opts.local) execArgs.push('--local');
	if (opts.port && opts.port !== 8400) execArgs.push('--port', String(opts.port));
	platform.installService(execArgs, opts, { dim, pink });
}

function uninstall() {
	platform.uninstallService({ dim, pink });
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
	await ensureCloudflared(); // fetch cloudflared into ~/.codeout/bin if it isn't already installed
	process.stdout.write('  opening tunnel ' + dim('(codeout.dev)') + ' ... ');
	publicUrl = await brokerTunnel(port);
	if (!publicUrl) { process.stdout.write(dim('broker unavailable, quick-tunnel ... ')); publicUrl = await openTunnel(port); }
	if (publicUrl) { console.log(pink('ready')); address = publicUrl.replace(/^https?:\/\//, ''); }
	else { console.log(dim('no tunnel - run with --local, or check your network.')); }
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
