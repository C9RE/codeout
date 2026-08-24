// Agent detection & connection testing — which chat agents (Claude / Codex / Gemini) are installed on this host,
// and live connection tests for the daemon control deck.
import { execFileSync, spawn } from 'node:child_process';

// `chat:true` = a chat backend is wired in the daemon today (CHAT_BACKENDS in sessions.js).
const KNOWN = [
	{ id: 'claude', cmd: 'claude', chat: true,  install: 'the Claude Code CLI' },
	{ id: 'codex',  cmd: 'codex',  chat: true,  install: 'npm i -g @openai/codex' },
	{ id: 'gemini', cmd: 'agy',    chat: true,  install: 'the Antigravity CLI (agy)' }
];

let cache = null;

function probe(cmd, env) {
	try {
		const v = execFileSync(cmd, ['--version'], { timeout: 15000, env, stdio: ['ignore', 'pipe', 'ignore'] })
			.toString().trim().split('\n')[0];
		return { installed: true, version: v };
	} catch {
		return { installed: false, version: null };
	}
}

/** The detection map: { claude:{id,installed,version,chat,comingSoon,install}, codex:{…}, gemini:{…} }. */
export function detectAgents(env) {
	if (cache) return cache;
	const map = {};
	for (const a of KNOWN) {
		const r = probe(a.cmd, env);
		map[a.id] = { id: a.id, installed: r.installed, version: r.version, chat: a.chat, comingSoon: !a.chat, install: a.install };
	}
	cache = map;
	return map;
}

/** Re-probe on the next call (e.g. after the user installs an agent). */
export function refreshAgents() { cache = null; }

/** Run a fast, single-turn connection test against an agent to verify credentials & responsiveness. */
export async function testAgentConnection(agentId, env, authConfig = {}) {
	const start = Date.now();
	const testEnv = { ...env };
	if (authConfig.authMode === 'apiKey' && authConfig.apiKey) {
		if (agentId === 'claude') testEnv.ANTHROPIC_API_KEY = authConfig.apiKey;
		else if (agentId === 'codex') testEnv.OPENAI_API_KEY = authConfig.apiKey;
		else if (agentId === 'gemini') testEnv.GEMINI_API_KEY = authConfig.apiKey;
	}

	return new Promise((resolve) => {
		let bin = 'claude';
		let args = ['-p', 'Respond with PONG', '--output-format', 'json'];
		if (agentId === 'codex') {
			bin = 'codex';
			args = ['exec', '--json', 'Respond with PONG'];
		} else if (agentId === 'gemini') {
			bin = testEnv?.AGY_CMD || 'agy';
			args = ['-p', 'Respond with PONG', '--output-format', 'stream-json'];
		}

		let child;
		try {
			child = spawn(bin, args, { env: testEnv, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
		} catch (e) {
			return resolve({ ok: false, error: `Failed to spawn ${bin}: ${e?.message ?? e}`, latencyMs: Date.now() - start });
		}

		let stdout = '';
		let stderr = '';
		child.stdout?.on('data', (d) => { stdout += d.toString(); });
		child.stderr?.on('data', (d) => { stderr += d.toString(); });

		child.on('close', (code) => {
			const latencyMs = Date.now() - start;
			if (code === 0) {
				resolve({ ok: true, latencyMs, output: stdout.slice(0, 200).trim() });
			} else {
				const errMsg = stderr.trim() || stdout.trim() || `process exited with code ${code}`;
				resolve({ ok: false, latencyMs, error: errMsg });
			}
		});

		child.on('error', (err) => {
			resolve({ ok: false, latencyMs: Date.now() - start, error: err.message });
		});
	});
}
