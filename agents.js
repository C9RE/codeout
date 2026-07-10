// Agent detection — which chat agents (Claude / Codex / Gemini) are installed on this host, for
// the client's new-session picker (installed = selectable; missing = "coming soon" + install hint).
// Probed once (cached; installs are rare) via the daemon's sanitized child env so it resolves the
// same PATH a spawned agent would. Verified against claude 2.1.x / codex 0.133 / gemini 0.49.
import { execFileSync } from 'node:child_process';

// `chat:true` = a chat backend is wired in the daemon today (CHAT_BACKENDS in sessions.js).
const KNOWN = [
	{ id: 'claude', cmd: 'claude', chat: true,  install: 'the Claude Code CLI' },
	{ id: 'codex',  cmd: 'codex',  chat: true,  install: 'npm i -g @openai/codex' },
	{ id: 'gemini', cmd: 'gemini', chat: true,  install: 'bun i -g @google/gemini-cli' }
];

let cache = null;

function probe(cmd, env) {
	try {
		const v = execFileSync(cmd, ['--version'], { timeout: 5000, env, stdio: ['ignore', 'pipe', 'ignore'] })
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
