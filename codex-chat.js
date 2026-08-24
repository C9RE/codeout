// codeout chat backend — OpenAI Codex, via `codex app-server --listen stdio://` (JSON-RPC 2.0).
//
// Same contract as claude-chat.js `startClaudeChat`: normalize the agent's native stream into the
// codeout ChatEvent union (see daemon/CHAT-EVENTS.md) via `emit`, route approvals through
// `onPermission`, report the resume key via `onSessionId`, expose `send`/`kill`. The host
// (sessions.js) owns the turn queue, the permission gate + session allow-list, the stats bar, the
// persistent log, and `/model /effort /mode /clear` (via kill+recreate with resumeId=threadId →
// thread/resume). Codex mapping verified live against codex-cli 0.133.0.
//
// Follow-up optimizations (not needed for correctness — the host's kill+recreate handles them):
//   - in-band Stop via `turn/interrupt` instead of killing the app-server child;
//   - in-band `/model`/`/effort` via per-turn override (already sent on turn/start below).
import { jsonRpcChild } from './json-rpc.js';
import { CHAT_SYSTEM_PROMPT } from './claude-chat.js';

const BUILTINS = [
	{ name: 'model', description: 'Switch model' },
	{ name: 'effort', description: 'none|minimal|low|medium|high|xhigh' },
	{ name: 'mode', description: 'default|acceptEdits|plan|bypassPermissions' },
	{ name: 'clear', description: 'Start a fresh chat' }
];

// codeout permission posture → Codex approvalPolicy (+ sandbox). Keep the gate LIVE by default;
// only "bypassPermissions" (Auto) turns it off, and even then stay sandboxed (never full-access).
function approvalFor(permissionMode) {
	if (permissionMode === 'bypassPermissions') return { approvalPolicy: 'never', sandbox: 'workspace-write' };
	return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
}

const TOOL_ITEM_TYPES = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'dynamicToolCall']);

export function startCodexChat({ cwd, env, resumeId = null, model = null, effort = null, permissionMode = 'default', extraSystemPrompt = null, emit, onSessionId, onSlashCommands, onMeta, onPermission }) {
	let threadId = resumeId;
	let ready = false;
	const items = new Map();       // itemId -> { type, output }
	let sawError = false;
	// Once kill()ed (the host relaunches for /model, /clear, Stop), SUPPRESS all further emits —
	// a dying child's late 'exit' error + rejected-turn 'turn:end' would otherwise leak into the
	// already-replaced session and can misfire the input queue (the stdin-interleave the design
	// guards against). Mirrors claude-chat.js's `killed` flag.
	let killed = false;
	const _emit = emit; emit = (e) => { if (!killed) _emit(e); };

	const rpc = jsonRpcChild('codex', ['app-server', '--listen', 'stdio://'], {
		env, onNotification, onRequest,
		onExit: (code) => { if (ready && !sawError) emit({ t: 'error', message: `codex backend exited (code ${code}).` }); },
		onError: (e) => { sawError = true; emit({ t: 'error', message: `codex failed to start: ${e?.code === 'ENOENT' ? 'codex not found on PATH' : (e?.message ?? e)}` }); }
	});

	// ---- handshake: initialize → resume-or-start → report the resume key + builtins ----
	(async () => {
		await rpc.request('initialize', { clientInfo: { name: 'codeout', version: '1.3.0' } });
		if (threadId) {
			await rpc.request('thread/resume', { threadId });
		} else {
			const { approvalPolicy, sandbox } = approvalFor(permissionMode);
			const params = { cwd, approvalPolicy, sandbox };
			// Chat persona + the <options> chip nudge (and any archive-reopen summary) as the thread's
			// base instructions — Codex's analogue of Claude's --append-system-prompt.
			params.baseInstructions = extraSystemPrompt ? `${CHAT_SYSTEM_PROMPT}\n\n${extraSystemPrompt}` : CHAT_SYSTEM_PROMPT;
			const r = await rpc.request('thread/start', params);
			threadId = r?.thread?.id;
			if (threadId) onSessionId(threadId);
			if (r?.model) onMeta({ model: r.model });
		}
		ready = true;
		onMeta({ apiKeySource: 'none' }); // Codex reports tokens not $ → keep the cost readout hidden
		onSlashCommands({ commands: [], builtins: BUILTINS });
	})().catch((e) => { sawError = true; emit({ t: 'error', message: `codex init failed: ${e?.message ?? e}` }); });

	// ---- notification stream → ChatEvents ----
	function onNotification(method, p) {
		switch (method) {
			case 'turn/started': return; // turn:start is emitted on send() for immediate feedback
			case 'turn/completed': emit({ t: 'turn', phase: 'end' }); return;
			case 'item/agentMessage/delta': if (p?.delta) { const it = items.get(p.itemId) || { type: 'agentMessage' }; it.streamed = true; items.set(p.itemId, it); emit({ t: 'text', id: p.itemId, text: p.delta }); } return;
			case 'item/reasoning/textDelta':
			case 'item/reasoning/summaryTextDelta': if (p?.delta) emit({ t: 'thinking', id: p.itemId || p.id, text: p.delta }); return;
			case 'item/commandExecution/outputDelta':
			case 'item/fileChange/outputDelta': {
				const it = items.get(p.itemId); if (!it) return;
				it.output = (it.output || '') + (p.delta ?? p.chunk ?? '');
				emit({ t: 'tool', id: p.itemId, name: it.type, status: 'running', output: it.output });
				return;
			}
			case 'item/started': return onItem(p?.item, false);
			case 'item/completed': return onItem(p?.item, true);
			case 'thread/tokenUsage/updated': {
				const tot = p?.tokenUsage?.total;
				if (tot) onMeta({ ctxTokens: (tot.inputTokens || 0) + (tot.cachedInputTokens || 0) });
				return;
			}
			case 'account/rateLimits/updated': {
				const rl = p?.rateLimits;
				// The host's onMeta takes ONE rateLimit (singular, keyed by type) per call — not an array.
				for (const [k, v] of [['primary', rl?.primary], ['secondary', rl?.secondary]]) {
					if (v) onMeta({ rateLimit: { type: k, status: 'allowed', resetsAt: v.resetsAt, usedPercent: v.usedPercent } });
				}
				return;
			}
			case 'error': sawError = true; emit({ t: 'error', message: p?.message || p?.error || 'codex error' }); emit({ t: 'turn', phase: 'end' }); return;
			default: return; // configWarning, remoteControl/*, mcpServer/*, thread/status|started, warning, …
		}
	}

	function onItem(item, done) {
		if (!item || item.type === 'userMessage') return;
		const id = item.id;
		if (item.type === 'agentMessage') {
			if (done) {
				// Only emit the full text if NO deltas streamed (a one-shot final) — otherwise the
				// client, which APPENDS text by id, would render it twice ("PONGPONG").
				if (item.text && !items.get(id)?.streamed) emit({ t: 'text', id, text: item.text });
				emit({ t: 'text', id, final: true });
				items.delete(id);
			} else {
				items.set(id, { type: 'agentMessage', streamed: false });
			}
			return;
		}
		if (item.type === 'reasoning') { if (done) emit({ t: 'thinking', id, final: true }); return; }
		if (TOOL_ITEM_TYPES.has(item.type)) {
			if (!done) {
				items.set(id, { type: item.type, output: '' });
				emit({ t: 'tool', id, name: item.type, title: toolTitle(item), input: toolInput(item), status: 'running' });
			} else {
				const bad = item.status === 'failed' || item.status === 'declined' || item.status === 'error';
				emit({ t: 'tool', id, name: item.type, status: bad ? 'error' : 'ok', output: items.get(id)?.output || toolOutput(item) });
				items.delete(id);
			}
			return;
		}
	}

	function toolTitle(it) { return it.command ? (Array.isArray(it.command) ? it.command.join(' ') : String(it.command)) : (it.tool || it.type); }
	function toolInput(it) { return it.command != null ? { command: it.command } : (it.changes ? { changes: it.changes } : (it.arguments ?? it.query ?? it.rawInput ?? null)); }
	function toolOutput(it) { return it.output ?? it.aggregatedOutput ?? (it.changes ? `${it.changes.length ?? ''} file change(s)` : '') ?? ''; }

	// ---- approvals: server-initiated requests → onPermission → decision ----
	async function onRequest(method, p) {
		if (/requestApproval|ApplyPatchApproval|applyPatchApproval|execCommandApproval/i.test(method)) {
			const toolName = /command|exec/i.test(method) ? 'shell' : (/file|patch/i.test(method) ? 'edit' : (p?.toolName || 'tool'));
			const input = p?.command != null ? { command: p.command } : (p?.changes || p?.fileChanges ? { changes: p.changes || p.fileChanges } : (p?.input ?? null));
			const decision = await onPermission({ id: p?.itemId || p?.callId || p?.approvalId || String(Date.now()), toolName, input });
			return { decision: decision?.behavior === 'allow' ? 'accept' : 'decline' };
		}
		// requestUserInput / mcpServer elicitation — no codeout UI yet; decline safely.
		return { decision: 'decline' };
	}

	return {
		send(text) {
			if (killed || !rpc.child.stdin?.writable) return false; // dead child → let the host surface it, don't strand "working"
			emit({ t: 'turn', phase: 'start' });
			const input = [{ type: 'text', text }];
			const params = { threadId, input };
			if (model) params.model = model;          // per-turn override — applies even after thread/resume
			if (effort) params.effort = effort;
			rpc.request('turn/start', params).catch((e) => { emit({ t: 'error', message: `codex turn failed: ${e?.message ?? e}` }); emit({ t: 'turn', phase: 'end' }); });
			return true;
		},
		kill() { killed = true; rpc.kill(); },
		child: rpc.child
	};
}
