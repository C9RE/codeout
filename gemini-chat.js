// codeout chat backend — Google Gemini / Antigravity via `agy` (stream-json).
//
// Same contract as claude-chat.js / codex-chat.js: normalize the agent's stream-json stream into
// the codeout ChatEvent union (daemon/CHAT-EVENTS.md) via `emit`, route approvals through
// `onPermission`, report the resume key via `onSessionId`, expose `send`/`kill`.
//
// Powered by Law's Google AI Pro subscription ($0 API token cost). Supports multi-account auto-
// failover via `anti` (Account 1 ~/.gemini + Account 2 ~/.anti2).
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { CHAT_SYSTEM_PROMPT } from './claude-chat.js';

export const BUILTINS = [
	{ name: 'model', description: 'Switch model (gemini-3.7-flash, gemini-3-pro)' },
	{ name: 'effort', description: 'Reasoning effort (low|medium|high)' },
	{ name: 'mode', description: 'accept-edits|plan' },
	{ name: 'clear', description: 'Start a fresh chat' }
];

/** Map ONE agy `stream-json` NDJSON event → ChatEvents (pure; exported for unit testing). */
export function mapGeminiUpdate(evt, { emit, onSessionId, onSlashCommands, onMeta, items = new Map() }) {
	if (!evt) return;
	if (evt.event === 'init') {
		const cid = evt.conversation_id || evt.init?.conversation_id;
		if (cid) onSessionId?.(cid);
		onSlashCommands?.({ commands: [], builtins: BUILTINS });
		return;
	}
	if (evt.event === 'step_update') {
		const su = evt.step_update;
		if (!su) return;
		const idx = su.step_index ?? 0;
		const st = su.step_type;
		const state = su.state;
		const msgId = `g-msg-${idx}`;
		const toolId = `g-tool-${idx}`;

		if (st === 'agent_response') {
			if (su.text_delta) {
				items.set(msgId, true);
				emit({ t: 'text', id: msgId, text: su.text_delta });
			}
			if (state === 'DONE') {
				if (items.has(msgId)) {
					emit({ t: 'text', id: msgId, final: true });
					items.delete(msgId);
				}
				if (su.usage?.total_tokens != null) {
					onMeta?.({ ctxTokens: su.usage.total_tokens });
				}
			}
			return;
		}
		if (st === 'thinking') {
			if (su.text_delta) {
				emit({ t: 'thinking', id: `g-thk-${idx}`, text: su.text_delta });
			}
			if (state === 'DONE') {
				emit({ t: 'thinking', id: `g-thk-${idx}`, final: true });
			}
			return;
		}
		if (st === 'tool') {
			const toolName = su.tool_name || su.tool_info?.name || 'tool';
			const input = su.tool_info?.parameters ?? null;
			if (state === 'ACTIVE' || state === 'RUNNING') {
				emit({ t: 'tool', id: toolId, name: toolName, input, status: 'running' });
			} else if (state === 'DONE' || state === 'COMPLETED') {
				const output = su.tool_info?.output ?? '';
				emit({ t: 'tool', id: toolId, name: toolName, input, status: 'ok', output: String(output) });
			} else if (state === 'ERROR' || state === 'FAILED') {
				emit({ t: 'tool', id: toolId, name: toolName, input, status: 'error', output: String(su.tool_info?.output || 'Tool failed') });
			}
			return;
		}
		if (su.usage?.total_tokens != null) {
			onMeta?.({ ctxTokens: su.usage.total_tokens });
		}
		return;
	}
	if (evt.event === 'result') {
		const res = evt.result;
		if (res?.usage?.total_tokens != null) {
			onMeta?.({ ctxTokens: res.usage.total_tokens });
		}
		return;
	}
}

export function startGeminiChat({ cwd, env, resumeId = null, model = null, effort = null, permissionMode = 'default', extraSystemPrompt = null, emit, onSessionId, onSlashCommands, onMeta, onPermission }) {
	let sessionId = resumeId;
	let firstTurn = !resumeId;
	let killed = false;
	let activeChild = null;
	const items = new Map();

	const _emit = emit;
	emit = (e) => { if (!killed) _emit(e); };

	onMeta?.({ apiKeySource: 'none' }); // Sub-backed: hide token dollar cost in UI
	onSlashCommands?.({ commands: [], builtins: BUILTINS });
	if (sessionId) onSessionId?.(sessionId);

	return {
		send(text) {
			if (killed) return false;
			emit({ t: 'turn', phase: 'start' });

			let toSend = text;
			if (firstTurn) {
				const preamble = extraSystemPrompt ? `${CHAT_SYSTEM_PROMPT}\n\n${extraSystemPrompt}` : CHAT_SYSTEM_PROMPT;
				toSend = `${preamble}\n\n---\n\n${text}`;
				firstTurn = false;
			}

			const bin = env?.AGY_CMD || 'agy';
			const args = ['-p', toSend, '--output-format', 'stream-json', '--dangerously-skip-permissions'];
			if (sessionId) args.push('--conversation', sessionId);
			if (model) args.push('--model', model);
			if (effort) args.push('--effort', effort);

			let child;
			try {
				child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
			} catch (e) {
				emit({ t: 'error', message: `Failed to spawn ${bin}: ${e?.message ?? e}` });
				emit({ t: 'turn', phase: 'end' });
				return false;
			}

			activeChild = child;

			const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
			rl.on('line', (line) => {
				const trimmed = line.trim();
				if (!trimmed || !trimmed.startsWith('{')) return;
				try {
					const evt = JSON.parse(trimmed);
					if (evt.event === 'init') {
						const cid = evt.conversation_id || evt.init?.conversation_id;
						if (cid) {
							sessionId = cid;
							onSessionId?.(cid);
						}
					}
					mapGeminiUpdate(evt, { emit, onSessionId, onSlashCommands, onMeta, items });
				} catch { /* ignore non-json line */ }
			});

			let stderrOutput = '';
			child.stderr?.on('data', (d) => { stderrOutput += d.toString(); });

			child.on('close', (code) => {
				activeChild = null;
				// Close any lingering unclosed bubbles
				for (const [id] of items) {
					emit({ t: 'text', id, final: true });
				}
				items.clear();

				if (code !== 0 && !killed) {
					const errText = stderrOutput.trim() || `process exited with code ${code}`;
					emit({ t: 'error', message: `Gemini turn error: ${errText}` });
				}
				emit({ t: 'turn', phase: 'end' });
			});

			return true;
		},
		kill() {
			killed = true;
			if (activeChild) {
				try { activeChild.kill('SIGTERM'); } catch { /* ignore */ }
			}
		},
		get child() { return activeChild; }
	};
}
