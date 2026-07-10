// codeout chat backend — Google Gemini, via `gemini --acp` (Agent Client Protocol, JSON-RPC 2.0).
//
// Same contract as claude-chat.js / codex-chat.js: normalize the agent's ACP stream into the
// codeout ChatEvent union (daemon/CHAT-EVENTS.md) via `emit`, route approvals through
// `onPermission`, report the resume key via `onSessionId`, expose `send`/`kill`. Shares the
// json-rpc.js transport with Codex. ACP = the open Zed standard (agentclientprotocol.com); the same
// protocol Zed/JetBrains/Happy drive Gemini with. Verified handshake headless on gemini-cli 0.49.
//
// AUTH: gemini needs GEMINI_API_KEY (in the daemon env — add to SAFE_ENV) OR a prior `gemini` OAuth
// login (creds in ~/.gemini). Unauthed → `session/new` returns -32000; we surface a clear error.
//
// GAP handled: ACP `session/new` has NO system-prompt field, so the chat persona + <options> chip
// nudge (and any archive-reopen summary) are PREPENDED to the first user prompt (agent-only; the
// host echoes the user's clean text separately).
import { jsonRpcChild } from './json-rpc.js';
import { CHAT_SYSTEM_PROMPT } from './claude-chat.js';

const BUILTINS = [
	{ name: 'model', description: 'Switch model' },
	{ name: 'mode', description: 'Change approval mode' },
	{ name: 'clear', description: 'Start a fresh chat' }
	// no /effort for Gemini (no effort concept)
];

function chunkText(content) { if (content == null) return ''; if (typeof content === 'string') return content; return content.text || ''; }
function toolText(content) { if (!content) return ''; if (typeof content === 'string') return content; if (Array.isArray(content)) return content.map(chunkText).join(''); return chunkText(content); }

/** Map ONE ACP `session/update` payload → ChatEvents (pure; exported for unit testing). `textId`/
 *  `thinkId` are the CURRENT turn's ids — ACP `agent_message_chunk` has no stable per-message id, so
 *  the adapter supplies a per-turn id (else every turn's text would append into one bubble). */
export function mapGeminiUpdate(u, { emit, onSlashCommands, onMeta, textId = 'msg', thinkId = 'thk' }) {
	switch (u?.sessionUpdate) {
		case 'agent_message_chunk': { const t = chunkText(u.content); if (t) emit({ t: 'text', id: u.messageId || textId, text: t }); return; }
		case 'agent_thought_chunk': { const t = chunkText(u.content); if (t) emit({ t: 'thinking', id: u.messageId || thinkId, text: t }); return; }
		case 'tool_call': emit({ t: 'tool', id: u.toolCallId, name: u.kind || 'tool', title: u.title, input: u.rawInput ?? u.content ?? null, status: 'running' }); return;
		case 'tool_call_update': {
			const st = u.status === 'failed' || u.status === 'error' ? 'error' : (u.status === 'completed' ? 'ok' : 'running');
			emit({ t: 'tool', id: u.toolCallId, name: u.kind || 'tool', status: st, output: toolText(u.content) });
			return;
		}
		case 'available_commands_update': onSlashCommands?.({ commands: (u.availableCommands || []).map((c) => (typeof c === 'string' ? c : c.name)), builtins: BUILTINS }); return;
		case 'usage_update': { const tok = u.usage?.totalTokens ?? u.tokens; if (tok != null) onMeta?.({ ctxTokens: tok }); return; }
		default: return; // plan, user_message_chunk, current_mode_update, config_option_update, …
	}
}

export function startGeminiChat({ cwd, env, resumeId = null, model = null, effort = null, permissionMode = 'default', extraSystemPrompt = null, emit, onSessionId, onSlashCommands, onMeta, onPermission }) {
	let sessionId = resumeId;
	let ready = false;
	let firstTurn = true;
	let sawError = false;
	// Per-turn ids for the streaming text/thinking bubbles (ACP chunks carry no stable message id).
	let textId = null, thinkId = null, textStreamed = false, thinkStreamed = false;
	// Suppress emits after kill() (host relaunch/Stop) — see codex-chat.js for the why.
	let killed = false;
	const _emit = emit; emit = (e) => { if (!killed) _emit(e); };
	// Random per-turn bubble id (NOT a per-instance counter — that resets to 0 on every relaunch/
	// restart and would collide with an earlier bubble of the same id already on screen).
	const rid = () => Math.random().toString(36).slice(2, 10);

	const rpc = jsonRpcChild('gemini', ['--acp'], {
		env, onNotification, onRequest,
		onExit: (code) => { if (ready && !sawError) emit({ t: 'error', message: `gemini backend exited (code ${code}).` }); },
		onError: (e) => { sawError = true; emit({ t: 'error', message: `gemini failed to start: ${e?.code === 'ENOENT' ? 'gemini not found on PATH (bun i -g @google/gemini-cli)' : (e?.message ?? e)}` }); }
	});

	(async () => {
		await rpc.request('initialize', {
			protocolVersion: 1,
			// Advertise reduced client caps: we do NOT implement fs/*, terminal/* in v1, so Gemini does
			// its own IO. (Advertising true would OBLIGE us to answer those calls or the turn hangs.)
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
		});
		// Best-effort: if an API key is in the env, select that auth method (harmless if OAuth is used).
		if (env?.GEMINI_API_KEY || env?.GOOGLE_API_KEY) {
			try { await rpc.request('authenticate', { methodId: 'gemini-api-key' }); } catch { /* fall through */ }
		}
		if (sessionId) {
			await rpc.request('session/load', { sessionId, cwd });
		} else {
			const r = await rpc.request('session/new', { cwd, mcpServers: [] });
			sessionId = r?.sessionId;
			if (sessionId) onSessionId(sessionId);
		}
		ready = true;
		onSlashCommands({ commands: [], builtins: BUILTINS });
	})().catch((e) => {
		sawError = true;
		const msg = /api key/i.test(String(e?.message)) ? 'Gemini isn’t authenticated. Set GEMINI_API_KEY (daemon env) or run `gemini` once to log in.' : `gemini init failed: ${e?.message ?? e}`;
		emit({ t: 'error', message: msg });
	});

	// ---- session/update notifications → ChatEvents ----
	function onNotification(method, p) {
		if (method !== 'session/update') return; // (only session/update carries the event stream)
		const u = p?.update; if (!u) return;
		if (u.sessionUpdate === 'agent_message_chunk' && chunkText(u.content)) textStreamed = true;
		if (u.sessionUpdate === 'agent_thought_chunk' && chunkText(u.content)) thinkStreamed = true;
		mapGeminiUpdate(u, { emit, onSlashCommands, onMeta, textId, thinkId });
	}

	// ---- approvals: agent REQUEST session/request_permission → onPermission → selected option ----
	async function onRequest(method, p) {
		if (method === 'session/request_permission') {
			const options = (p?.options || []).map((o) => ({ id: o.optionId, label: o.name, kind: o.kind }));
			const tc = p?.toolCall || {};
			const decision = await onPermission({ id: tc.toolCallId || String(Date.now()), toolName: tc.kind || tc.title || 'tool', input: tc.rawInput ?? null, options });
			// Gemini supplies its OWN options; map the host's allow/deny onto the matching kind.
			// PREFER allow_once for a plain allow — the host collapses allow_once/allow_session to
			// {behavior:'allow'}, so choosing allow_always here would silently make a one-time approval
			// permanent (Gemini stops asking, the daemon gate never fires again for that tool).
			const want = decision?.behavior === 'allow' ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
			const chosen = (p?.options || []).find((o) => o.kind === want[0]) || (p?.options || []).find((o) => o.kind === want[1]);
			return chosen ? { outcome: { outcome: 'selected', optionId: chosen.optionId } } : { outcome: { outcome: 'cancelled' } };
		}
		// fs/*, terminal/* — we advertised reduced caps, so these shouldn't arrive; be safe.
		return {};
	}

	return {
		send(text) {
			if (killed || !rpc.child.stdin?.writable) return false; // dead child → don't strand "working"
			// Fresh, globally-unique per-turn bubble ids (ACP chunks have no stable id → without this,
			// all turns' text would append into one bubble and never close).
			const seq = rid(); textId = `g-text-${seq}`; thinkId = `g-think-${seq}`; textStreamed = false; thinkStreamed = false;
			emit({ t: 'turn', phase: 'start' });
			// Prepend the chat persona + chip nudge (+ archive summary) on the FIRST turn only — ACP
			// has no system-prompt field. Agent-only; the user's clean bubble is echoed by the host.
			let toSend = text;
			if (firstTurn) {
				const preamble = extraSystemPrompt ? `${CHAT_SYSTEM_PROMPT}\n\n${extraSystemPrompt}` : CHAT_SYSTEM_PROMPT;
				toSend = `${preamble}\n\n---\n\n${text}`;
				firstTurn = false;
			}
			const closeTurn = () => {
				if (textStreamed) emit({ t: 'text', id: textId, final: true });   // close the streamed bubbles
				if (thinkStreamed) emit({ t: 'thinking', id: thinkId, final: true });
				emit({ t: 'turn', phase: 'end' });
			};
			rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: toSend }] })
				.then(closeTurn)
				.catch((e) => { emit({ t: 'error', message: `gemini turn failed: ${e?.message ?? e}` }); closeTurn(); });
			return true;
		},
		kill() { killed = true; rpc.kill(); },
		child: rpc.child
	};
}
