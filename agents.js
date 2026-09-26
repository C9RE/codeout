// Agent detection & connection testing — which chat agents (Claude / Codex / Gemini) are installed on this host,
// and live connection tests for the daemon control deck.
import { execFileSync, spawn } from 'node:child_process';

// `chat:true` = a chat backend is wired in the daemon today (CHAT_BACKENDS in sessions.js).
const KNOWN = [
	{ id: 'claude', cmd: 'claude', chat: true,  install: 'the Claude Code CLI' },
	{ id: 'codex',  cmd: 'codex',  chat: true,  install: 'npm i -g @openai/codex' },
	{ id: 'gemini', cmd: 'agy',    chat: true,  install: 'the Antigravity CLI (agy)' },
	{ id: 'openrouter', cmd: null, chat: true,  install: 'an OpenRouter API key' }
];

let cache = null;

function probe(cmd, env) {
	if (!cmd) {
		return { installed: true, version: 'Direct API v1' };
	}
	try {
		const v = execFileSync(cmd, ['--version'], { timeout: 15000, env, stdio: ['ignore', 'pipe', 'ignore'] })
			.toString().trim().split('\n')[0];
		return { installed: true, version: v };
	} catch {
		return { installed: false, version: null };
	}
}

/** The detection map: { claude:{id,installed,version,chat,comingSoon,install}, codex:{…}, gemini:{…}, openrouter:{…} }. */
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
		else if (agentId === 'openrouter') testEnv.OPENROUTER_API_KEY = authConfig.apiKey;
	}

	if (agentId === 'openrouter') {
		const key = authConfig.apiKey || testEnv.OPENROUTER_API_KEY;
		if (!key) return { ok: false, error: 'OpenRouter API key is missing. Enter an API key in the deck above.', latencyMs: Date.now() - start };
		const baseUrl = authConfig.baseUrl || testEnv.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
		try {
			const res = await fetch(`${baseUrl}/auth/key`, {
				headers: { 'Authorization': `Bearer ${key}` }
			});
			const latencyMs = Date.now() - start;
			if (res.ok) {
				const data = await res.json().catch(() => ({}));
				const label = data?.data?.label || 'Key verified';
				const usage = data?.data?.usage != null ? ` (usage: $${Number(data.data.usage).toFixed(2)})` : '';
				return { ok: true, latencyMs, output: `${label}${usage}` };
			} else {
				const txt = await res.text().catch(() => '');
				return { ok: false, latencyMs, error: `OpenRouter HTTP ${res.status}: ${txt.slice(0, 200)}` };
			}
		} catch (err) {
			return { ok: false, latencyMs: Date.now() - start, error: `Network error: ${err.message}` };
		}
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
			const trimmedOut = stdout.trim();
			const trimmedErr = stderr.trim();

			// Try to parse structured JSON output from Claude / Codex / Gemini
			let parsed = null;
			try {
				parsed = JSON.parse(trimmedOut);
			} catch {
				const lines = trimmedOut.split('\n').map((l) => l.trim()).filter(Boolean);
				for (const line of lines) {
					try {
						const obj = JSON.parse(line);
						if (obj.result || obj.error || obj.is_error) parsed = obj;
					} catch { /* ignore */ }
				}
			}

			if (parsed) {
				if (parsed.is_error || parsed.error) {
					const msg = parsed.result || parsed.error?.message || parsed.error || 'Authentication / API error';
					return resolve({ ok: false, latencyMs, error: String(msg) });
				}
				if (parsed.result) {
					const out = typeof parsed.result === 'string' ? parsed.result : (parsed.result.text || JSON.stringify(parsed.result));
					return resolve({ ok: true, latencyMs, output: out.slice(0, 100) });
				}
			}

			if (code === 0) {
				resolve({ ok: true, latencyMs, output: trimmedOut.slice(0, 100) });
			} else {
				const errMsg = trimmedErr || trimmedOut || `process exited with code ${code}`;
				resolve({ ok: false, latencyMs, error: errMsg.slice(0, 300) });
			}
		});

		child.on('error', (err) => {
			resolve({ ok: false, latencyMs: Date.now() - start, error: err.message });
		});
	});
}
