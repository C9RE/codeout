// Platform layer — Windows.
//
// Mirror of posix.js for Windows. Kept as a SEPARATE file on purpose: changing Windows
// behaviour here can never regress the macOS/Linux path in posix.js. sessions.js and cli.js
// import only ./platform/index.js and call this same interface.
//
// Terminal persistence model: there is no `dtach` on Windows, so the agent/shell runs directly
// under a ConPTY (node-pty). It survives a CLIENT disconnect (the daemon holds the child) but
// NOT a daemon restart — restoreSessions() skips it (there is no dtach socket to reattach).
import { spawn as ptySpawn } from '@homebridge/node-pty-prebuilt-multiarch';
import { execFileSync } from 'node:child_process';

export const name = 'windows';

// No detached master ⇒ terminal sessions do not outlive a daemon restart.
export const terminalSurvivesRestart = false;

// Windows needs a very different base env: SystemRoot/PATHEXT are load-bearing for nearly every
// Windows process, and USERPROFILE/APPDATA/LOCALAPPDATA are where the agent (claude) finds its
// config + auth. (These keys are simply absent on Unix — this file only runs on Windows.)
const SAFE_ENV = [
	'Path', 'PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'WINDIR', 'ComSpec',
	'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN',
	'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TZ',
	'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
	'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
	// BYO-key agent auth (harmless when unset): Gemini / Codex / Claude.
	'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_CLOUD_PROJECT', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'
];

/** Build the sanitized environment a spawned agent/shell inherits. No PATH surgery: Windows
 *  PATH is ';'-separated (splitting on ':' would corrupt drive letters like C:\...), and the
 *  agent (claude) is already resolvable on PATH via a normal install. */
export function buildChildEnv() {
	const env = {};
	for (const k of SAFE_ENV) if (process.env[k] != null) env[k] = process.env[k];
	return env;
}

// The executable a terminal session runs. The 'bash' slot maps to PowerShell (the native
// Windows shell); the 'claude' slot runs the agent's own TUI directly under ConPTY.
function terminalCommand(agent) {
	if (agent === 'claude') return 'claude';
	return 'powershell.exe'; // the native Windows shell for the generic terminal slot
}

/** Spawn a terminal session's PTY directly (no dtach). `socket`/`fresh` are unused on Windows. */
export function spawnTerminal({ agent, ptyOpts }) {
	return ptySpawn(terminalCommand(agent), [], ptyOpts);
}

/** Kill a terminal session's agent — the node-pty child IS the process (no detached master),
 *  so terminating it tears down the ConPTY process tree. No pkill, no socket file. */
export function killTerminal(session) {
	try { session.pty?.kill(); } catch { /* gone */ }
}

// ---- boot service (Task Scheduler, runs on logon) ----
/** Install the boot task. `execArgs` is the argv that launches the daemon; `ui` = { dim, pink }. */
export function installService(execArgs, opts, ui) {
	const cmdStr = execArgs.map((s) => (s.includes(' ') ? `"${s}"` : s)).join(' ');
	try {
		execFileSync('schtasks', ['/create', '/tn', 'codeout', '/tr', cmdStr, '/sc', 'onlogon', '/f'], { stdio: 'ignore' });
	} catch (e) {
		console.log(ui.dim('  failed to create Scheduled Task: ' + (e?.message ?? e)));
		return;
	}
	console.log();
	console.log('  ' + ui.pink('installed') + ' - codeout starts on logon' + (opts.local ? ' (local only - LAN + Tailscale).' : ' with a public tunnel.'));
	console.log('    status   ' + ui.dim('schtasks /query /tn codeout'));
	console.log('    pair     ' + ui.dim('codeout --pair'));
	console.log('    remove   ' + ui.dim('codeout --uninstall'));
	console.log();
}

export function uninstallService(ui) {
	try { execFileSync('schtasks', ['/delete', '/tn', 'codeout', '/f'], { stdio: 'ignore' }); } catch { /* already gone */ }
	console.log(ui.dim('  removed the codeout logon task.'));
}

// cloudflared auto-download: the Windows release asset (a bare .exe) + the local binary name.
// cli.js fetches this into %USERPROFILE%\.codeout\bin when cloudflared isn't on PATH.
export const cloudflaredBin = 'cloudflared.exe';
export function cloudflaredAsset() {
	const arch = { x64: 'amd64', ia32: '386', arm64: 'amd64' }[process.arch]; // no arm64 win build; amd64 runs under emulation
	if (!arch) return null;
	return { name: `cloudflared-windows-${arch}.exe`, tgz: false };
}
