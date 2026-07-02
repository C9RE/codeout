// Claude chat-mode backend. Drives `claude` as ONE long-lived managed child process
// per chat session (NOT a PTY, NOT dtach). We write user turns to its stdin as
// stream-json user-message lines and read normalized events off its stdout ndJSON.
//
// Launch:
//   claude -p --output-format stream-json --verbose \
//     --include-partial-messages --input-format stream-json \
//     --permission-prompt-tool stdio [--resume <session_id>]
//
// `--input-format stream-json` keeps the process alive across turns: each user turn
// is one `{type:'user',message:{role:'user',content:[{type:'text',text}]}}` line to
// stdin. stdin MUST stay open or claude exits before producing a turn.
//
// TOOL PERMISSIONS (`--permission-prompt-tool stdio`):
//   This flag makes claude route every tool-permission decision it would otherwise make
//   interactively to a `can_use_tool` control_request on stdout, and wait for our
//   `control_response` on stdin before running the tool. Same mechanism as the SDK's
//   `canUseTool`, over the SAME stream-json pipe, so no MCP server and no SDK dependency.
//   No `initialize` handshake is needed; the flag alone arms the gate.
//   NOTE: claude's own safe-command classifier still auto-allows obviously read-only
//   calls WITHOUT asking us (no can_use_tool is sent for those); anything it would have
//   prompted for in a TTY reaches us. So the daemon prompts for everything the CLI escalates.
//
// Control-protocol shapes:
//   stdout: {type:'control_request', request_id, request:{subtype:'can_use_tool',
//            tool_name, display_name?, input, tool_use_id, permission_suggestions?}}
//   stdin (our reply, allow): {type:'control_response', response:{subtype:'success',
//            request_id, response:{behavior:'allow', updatedInput:<input>}}}
//   stdin (our reply, deny):  {type:'control_response', response:{subtype:'success',
//            request_id, response:{behavior:'deny', message:'<reason>'}}}
//   The `tool_use_id` equals the assistant tool_use block id AND the later tool_result
//   tool_use_id, so it is the stable pairing id used for the `permission`/`tool` events.
//
// stdout line shapes:
//   {type:'system',subtype:'init',session_id,model,tools,...}      -> capture session_id
//   {type:'stream_event',event:{...}}                              -> token deltas
//   {type:'assistant',message:{content:[{type:'text'|'thinking'|'tool_use',...}]}}
//   {type:'user',message:{content:[{type:'tool_result',tool_use_id,content,is_error}]}}
//   {type:'control_request',request:{subtype:'can_use_tool',...}}  -> permission gate
//   {type:'result',subtype,result,is_error}                        -> turn end
// The noisy system/hook_started|hook_response lines are filtered.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { evId, flattenToolResult, clip } from './chat-events.js';

// Chat-oriented system nudge appended (NOT replacing) the default. Two jobs:
//   1) frame the surface as a phone chat, not a terminal (so the agent writes
//      conversationally, not like it's pasting into a TTY);
//   2) teach it the <options> block codeout's markdown renderer already turns into
//      tappable chips, so a discrete multiple-choice question renders as buttons.
// Kept short on purpose: a long prompt fights the default Claude Code behaviour we
// still want (tools, permissions, titles, text streaming all keep working).
const CHAT_SYSTEM_PROMPT = [
	'You are in a clean mobile chat app, not a terminal. Be conversational and concise; write for a phone screen.',
	'When you ask the user to choose between a small set of discrete options, present the choices as an <options><option>…</option></options> block (one <option> per choice, short labels). The user can tap an option or type their own answer.'
].join(' ');

// DEMO mode (CODEOUT_DEMO=1): a public, chat-only demo. Launch claude with NO tools (the permission
// gate in sessions.js also auto-denies, this just stops it attempting them) and a system addendum that
// frames it as the demo + tells it to chat only. Tools listed broadly; the gate is the real backstop.
const DEMO_MODE = process.env.CODEOUT_DEMO === '1';
const DEMO_DISALLOWED_TOOLS = 'Bash Edit Write MultiEdit NotebookEdit Read Glob Grep LS WebFetch WebSearch Task Agent TodoWrite ExitPlanMode AskUserQuestion KillShell BashOutput';
const DEMO_SYSTEM_ADDENDUM = [
	'This is the PUBLIC codeout DEMO. You are chat-only: you have NO tools and cannot run commands, edit',
	'or read files, or access the machine. Just have a helpful, friendly conversation. If asked to run or',
	'change something, explain warmly that in the real codeout app you would do it on the user\'s own',
	'machine, but this demo is conversation-only. Keep replies concise and showcase what codeout feels like.'
].join(' ');

/**
 * Start (or resume) a Claude chat backend.
 * @param {object} o
 * @param {string} o.cwd                working directory for the agent
 * @param {object} o.env               child env (already sanitized by sessions.js)
 * @param {string|null} o.resumeId     prior session_id to `--resume`, or null for fresh
 * @param {string|null} [o.model]      model id for `--model` (null = the user's default)
 * @param {string|null} [o.effort]     effort level for `--effort` (low|medium|high|xhigh|max; null = default)
 * @param {string|null} [o.extraSystemPrompt]  extra text appended AFTER the chat nudge
 *        (archive-reopen summary injection) — rides the same --append-system-prompt flag
 * @param {string} [o.permissionMode]  permission posture for `--permission-mode`
 *        (default|acceptEdits|plan|bypassPermissions; defaults to 'default'). The /mode switch
 *        relaunches with this set. `bypassPermissions` runs every tool without asking (the
 *        can_use_tool gate goes silent because claude never escalates); the other three keep the
 *        gate live for whatever they'd prompt for.
 * @param {(ev:object)=>void} o.emit   sink for normalized ChatEvents
 * @param {(sid:string)=>void} o.onSessionId  called once with the captured session_id
 * @param {(commands:string[])=>void} [o.onSlashCommands]  called once with the init slash_commands list
 * @param {(meta:object)=>void} [o.onMeta]  raw stats inputs parsed from the stream (model, contextWindow, ctxTokens, costUsd, rateLimit). The host accumulates/throttles these into the `stats` ChatEvent.
 * @param {(req:{id:string,toolName:string,input:object})=>Promise<{behavior:'allow'|'deny',updatedInput?:object,message?:string}>} [o.onPermission]
 *        Asked to approve/deny a tool call before it runs. Resolves with the decision.
 *        If omitted, every tool is allowed (back-compat with the old auto-run behaviour).
 * @returns {{ send:(text:string)=>boolean, kill:()=>void, child:import('node:child_process').ChildProcess }}
 */
export function startClaudeChat({ cwd, env, resumeId, model, effort, permissionMode, extraSystemPrompt, emit: rawEmit, onSessionId, onSlashCommands, onMeta, onPermission }) {
	// Permission posture for this launch. `default` keeps the interactive gate; `acceptEdits`
	// auto-applies edits but still escalates commands; `plan` is read-only; `bypassPermissions`
	// runs everything without asking. Defaults to `default` (back-compat with the old hardcode).
	const permMode = permissionMode || 'default';
	// Set once kill() is called. A dying child's late exit/result/stdout lines must NOT
	// fire emit/endTurn into the session after a replacement child has started - otherwise
	// a late turn:end flips the host's turnLive and drains a queued message into the busy
	// NEW child, garbling its stdin (the exact interleave the queue exists to prevent).
	let killed = false;
	// All ChatEvents from this backend funnel through a guard so that once kill() has run,
	// a late line from the dying child can't emit into the (now-replaced) session.
	const emit = (ev) => { if (killed) return; rawEmit(ev); };
	const args = [
		'-p',
		'--output-format', 'stream-json',
		'--verbose',
		'--include-partial-messages',
		'--input-format', 'stream-json',
		// Frame the surface as a mobile chat + teach the <options> chip block. APPENDED
		// to the default system prompt (not --system-prompt), so all the default Claude
		// Code chat behaviour - tools, permissions, titles, streaming - is preserved.
		'--append-system-prompt', [
			DEMO_MODE ? `${CHAT_SYSTEM_PROMPT} ${DEMO_SYSTEM_ADDENDUM}` : CHAT_SYSTEM_PROMPT,
			extraSystemPrompt || null   // archive-reopen summary, when present
		].filter(Boolean).join('\n\n'),
		// Route tool-permission decisions to us over the stdio control channel (the
		// can_use_tool control_request handled below). Without a host answer, claude
		// blocks the tool - which is exactly the approval gate we want.
		'--permission-prompt-tool', 'stdio',
		// Session-controlled permission posture (overrides the user's own settings, which may set
		// `defaultMode:"auto"` and silently auto-run tools). `default`/`acceptEdits`/`plan` keep the
		// can_use_tool gate live for anything claude would prompt for in a TTY (its safe-command
		// classifier still auto-allows obviously read-only calls). `bypassPermissions` deliberately
		// runs every tool without asking - claude never escalates, so the gate simply stays silent
		// (no conflict with --permission-prompt-tool: there are just no prompts to route).
		// In demo, force `default` so the gate stays live and auto-denies (never bypassPermissions,
		// which would skip the gate and run tools). Otherwise the session's chosen posture.
		'--permission-mode', DEMO_MODE ? 'default' : permMode,
		// AskUserQuestion is Claude Code's INTERACTIVE multiple-choice picker - a terminal
		// harness tool with no headless UI, so in chat it leaks as a raw tool-call dump.
		// Disallow it: the agent asks its question as plain text and the user replies in
		// the chat (the natural chat pattern, like ChatGPT / claude.ai).
		'--disallowedTools', DEMO_MODE ? DEMO_DISALLOWED_TOOLS : 'AskUserQuestion'
	];
	if (resumeId) args.push('--resume', resumeId);
	// Optional explicit model (the /model switch relaunches with this set). When null
	// the user's own default model is used (no flag).
	if (model) args.push('--model', model);
	// Optional effort level (the /effort switch relaunches with this set). Real claude flag
	// (low|medium|high|xhigh|max). When null the model's default effort is used (no flag).
	if (effort) args.push('--effort', effort);

	const child = spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });

	// Streaming text/thinking blocks are keyed by `${message.id}:${block index}` so
	// token deltas append under one stable ChatEvent id and `final` closes it.
	/** @type {Map<string,{evid:string, kind:'text'|'thinking', parent?:string}>} */
	const open = new Map();
	let curMsgId = null;
	// Subagent nesting: when Claude spawns a Task subagent, its assistant/user/stream_event
	// events carry `parent_tool_use_id` = the Task tool_use id (null = top-level). We stamp
	// that onto the ChatEvents so the client can nest the subagent's activity inside the Task
	// card. `curParent` tracks it for the streamed text/thinking deltas (whose stream_event
	// delta lines don't repeat parent_tool_use_id - message_start does).
	let curParent = null;
	let turnLive = false;

	// Tool name (+ title + parent) by tool_use_id, so the later `ok`/`error` event - built
	// from a tool_result that ONLY carries tool_use_id - can re-attach the name (and
	// subagent parent) the `running` event set. Without this the result event's `name` is
	// undefined. Pruned on turn end to bound the map (ids are turn-local).
	/** @type {Map<string,{name:string, title?:string, parent?:string}>} */
	const toolNames = new Map();

	// Shallow-merge a `parent` field onto a ChatEvent only when set (null/undefined → no
	// key added, so top-level events stay byte-identical to before this feature).
	const withParent = (ev, parent) => (parent ? { ...ev, parent } : ev);

	const startTurnIfNeeded = () => {
		if (!turnLive) { turnLive = true; emit({ t: 'turn', phase: 'start' }); }
	};
	const endTurn = (status) => {
		// close any dangling streamed blocks first (preserve their subagent parent tag)
		for (const [, v] of open) emit(withParent({ t: v.kind, id: v.evid, final: true }, v.parent));
		open.clear();
		toolNames.clear(); // tool_use_ids are turn-local; drop them so the map can't grow.
		curParent = null;  // subagent nesting is turn-local; reset for the next turn.
		if (turnLive) { turnLive = false; emit({ t: 'turn', phase: 'end', status }); }
	};

	// Write a control_response answering a can_use_tool request. `decision` is the
	// resolved permission ({behavior:'allow',updatedInput} | {behavior:'deny',message}).
	function writeControlResponse(requestId, decision) {
		if (!child.stdin.writable) return;
		const msg = { type: 'control_response', response: { subtype: 'success', request_id: requestId, response: decision } };
		try { child.stdin.write(JSON.stringify(msg) + '\n'); } catch { /* process gone */ }
	}

	// Handle an inbound can_use_tool control_request: ask the host (onPermission) and
	// reply allow/deny. If no host callback is wired, allow (legacy auto-run). The gate
	// is the agent's: claude will not run the tool until this control_response lands.
	function handlePermissionRequest(o) {
		const req = o.request || {};
		const requestId = o.request_id;
		const toolUseId = req.tool_use_id || requestId; // stable pairing id (= tool_use.id)
		if (!onPermission) {
			writeControlResponse(requestId, { behavior: 'allow', updatedInput: req.input || {} });
			return;
		}
		Promise.resolve(
			onPermission({ id: toolUseId, toolName: req.tool_name, input: req.input || {} })
		).then((decision) => {
			if (decision && decision.behavior === 'allow') {
				writeControlResponse(requestId, { behavior: 'allow', updatedInput: decision.updatedInput ?? req.input ?? {} });
			} else {
				writeControlResponse(requestId, { behavior: 'deny', message: (decision && decision.message) || 'denied by user' });
			}
		}).catch((e) => {
			// Never leave the agent hung waiting on us: a callback failure denies safely.
			writeControlResponse(requestId, { behavior: 'deny', message: 'permission error: ' + (e?.message ?? e) });
		});
	}

	function handle(line) {
		let o;
		try { o = JSON.parse(line); } catch { return; }
		const t = o?.type;
		if (t === 'control_request') {
			if (o.request?.subtype === 'can_use_tool') handlePermissionRequest(o);
			// other control_request subtypes (none expected on this path) are ignored.
			return;
		}
		if (t === 'control_response') return; // acks for anything we sent; nothing to do.
		if (t === 'system') {
			if (o.subtype === 'init') {
				if (o.session_id && onSessionId) onSessionId(o.session_id);
				// The init line carries the available slash commands; hand them to the host
				// so clients can offer a `/` autocomplete. Best-effort: only when present.
				if (Array.isArray(o.slash_commands) && onSlashCommands) onSlashCommands(o.slash_commands);
				// init carries the live model id + the auth source; the host folds them into the
				// `stats` bar. apiKeySource "none" = subscription/OAuth (cost is notional, the
				// client hides it); a real key source = API key (show cost).
				if (onMeta) onMeta({ model: o.model, apiKeySource: o.apiKeySource });
				// init model/cwd line removed: redundant with the stats bar (onMeta feeds it).
			}
			// hook_started / hook_response and other system noise: ignore.
			return;
		}
		if (t === 'stream_event') {
			const ev = o.event;
			const et = ev?.type;
			// parent_tool_use_id rides on the top-level stream_event line. message_start sets
			// it for the whole message's deltas; later delta lines also carry it, so keep it
			// fresh whenever present (null is a valid top-level value we must honour).
			if (o.parent_tool_use_id !== undefined) curParent = o.parent_tool_use_id || null;
			if (et === 'message_start') { curMsgId = ev?.message?.id || curMsgId; return; }
			if (et === 'content_block_start') {
				const cb = ev.content_block || {};
				const key = `${curMsgId}:${ev.index}`;
				if (cb.type === 'text') open.set(key, { evid: evId(), kind: 'text', parent: curParent || undefined });
				else if (cb.type === 'thinking') open.set(key, { evid: evId(), kind: 'thinking', parent: curParent || undefined });
				// tool_use streams as input_json_delta; we emit the tool from the
				// complete `assistant` block (whole input), so skip its deltas here.
				return;
			}
			if (et === 'content_block_delta') {
				const key = `${curMsgId}:${ev.index}`;
				const rec = open.get(key);
				if (!rec) return;
				const d = ev.delta || {};
				if (d.type === 'text_delta' && rec.kind === 'text') emit(withParent({ t: 'text', id: rec.evid, text: d.text || '' }, rec.parent));
				else if (d.type === 'thinking_delta' && rec.kind === 'thinking') emit(withParent({ t: 'thinking', id: rec.evid, text: d.thinking || '' }, rec.parent));
				return;
			}
			if (et === 'content_block_stop') {
				const key = `${curMsgId}:${ev.index}`;
				const rec = open.get(key);
				if (rec) { emit(withParent({ t: rec.kind, id: rec.evid, final: true }, rec.parent)); open.delete(key); }
				return;
			}
			return;
		}
		if (t === 'assistant') {
			startTurnIfNeeded();
			// A subagent's assistant message carries the Task tool's id as parent_tool_use_id
			// (null = top-level). Stamp the nested tools so the client can place them in the
			// Task card. The Task tool_use itself is top-level (its own message has no parent).
			const parent = o.parent_tool_use_id || null;
			for (const c of o.message?.content || []) {
				if (c.type === 'tool_use') {
					// Remember the name (+ parent) by id so the later tool_result (which has only
					// tool_use_id) can stamp the same name/parent on its ok/error event.
					toolNames.set(c.id, { name: c.name, title: c.name, parent: parent || undefined });
					emit(withParent({
						t: 'tool',
						id: c.id,
						name: c.name,
						title: c.name,
						input: c.input,
						status: 'running'
					}, parent));
				}
				// text / thinking blocks already streamed via stream_event deltas; if
				// partial messages were off we'd emit them here, but they're on.
			}
			return;
		}
		if (t === 'user') {
			// tool_result blocks pair to a prior tool_use by tool_use_id.
			for (const c of o.message?.content || []) {
				if (c && c.type === 'tool_result') {
					// Re-attach name/title/parent by tool_use_id so every `tool` event for one id
					// carries the same name + nesting (the tool_result itself has no tool_name).
					// Fall back to the message-level parent_tool_use_id if the map missed it.
					const meta = toolNames.get(c.tool_use_id);
					emit(withParent({
						t: 'tool',
						id: c.tool_use_id,
						...(meta?.name != null ? { name: meta.name } : {}),
						...(meta?.title != null ? { title: meta.title } : {}),
						status: c.is_error ? 'error' : 'ok',
						output: clip(flattenToolResult(c.content))
					}, meta?.parent || o.parent_tool_use_id || null));
				}
			}
			return;
		}
		if (t === 'result') {
			// Stats inputs ride on the result line. Pull the context window for the live model,
			// the live token fill (input + cache tokens), and the cumulative session cost.
			if (onMeta) {
				const meta = {};
				const usage = o.usage || {};
				// How full the context is right now = the non-output tokens of this turn:
				// fresh input + both cache flavours (output tokens don't occupy the window).
				const ctx = (usage.input_tokens || 0)
					+ (usage.cache_read_input_tokens || 0)
					+ (usage.cache_creation_input_tokens || 0);
				if (ctx > 0) meta.ctxTokens = ctx;
				if (typeof o.total_cost_usd === 'number') meta.costUsd = o.total_cost_usd;
				// modelUsage maps model id -> { contextWindow, ... }. Take the window from
				// whichever model entry carries one (there's normally one live model).
				const mu = o.modelUsage || {};
				for (const k of Object.keys(mu)) {
					if (mu[k] && typeof mu[k].contextWindow === 'number') { meta.contextWindow = mu[k].contextWindow; break; }
				}
				if (Object.keys(meta).length) onMeta(meta);
			}
			endTurn(o.is_error ? 'error' : 'ok');
			return;
		}
		// Rate-limit telemetry: a standalone stream line carrying the account's rate-limit
		// status (no percentage in the stream - only status + resetsAt + type). Forward the
		// latest per type so the host keeps one entry per window (five_hour, seven_day, ...).
		if (t === 'rate_limit_event' || o?.rate_limit_info) {
			const info = o.rate_limit_info || {};
			if (onMeta && (info.status || info.rateLimitType)) {
				onMeta({ rateLimit: { type: info.rateLimitType, status: info.status, resetsAt: info.resetsAt } });
			}
			return;
		}
	}

	const rl = createInterface({ input: child.stdout });
	const onLine = (line) => { if (!killed && line.trim()) handle(line); };
	rl.on('line', onLine);

	let stderrBuf = '';
	const onStderr = (d) => { stderrBuf = (stderrBuf + d).slice(-4096); };
	child.stderr.on('data', onStderr);

	const onExit = (code) => {
		if (killed) return; // a deliberate teardown: don't emit into the replaced session.
		endTurn(code === 0 ? 'ok' : 'error');
		if (code && code !== 0) emit({ t: 'error', message: `claude exited (${code})${stderrBuf ? ': ' + stderrBuf.trim().split('\n').pop() : ''}` });
	};
	child.on('exit', onExit);
	child.on('error', (e) => emit({ t: 'error', message: `claude spawn failed: ${e.message}` }));

	function send(text) {
		if (killed || !child.stdin.writable) return false;
		startTurnIfNeeded();
		const msg = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: String(text) }] } };
		try { child.stdin.write(JSON.stringify(msg) + '\n'); return true; } catch { return false; }
	}

	function kill() {
		// Arm the guard FIRST so any line/exit that lands during teardown is a no-op (emit
		// already short-circuits on `killed`; endTurn can't fire because onExit bails too).
		killed = true;
		// Detach our listeners so a late stdout line / exit from the dying child can never
		// reach the (now-replaced) session even by a path that doesn't check `killed`.
		try { rl.off('line', onLine); } catch { /* ignore */ }
		try { rl.close(); } catch { /* ignore */ }
		try { child.stdout?.removeAllListeners(); } catch { /* ignore */ }
		try { child.stderr?.off('data', onStderr); } catch { /* ignore */ }
		try { child.off('exit', onExit); } catch { /* ignore */ }
		try { child.stdin.end(); } catch { /* ignore */ }
		try { child.kill('SIGTERM'); } catch { /* ignore */ }
		// SIGTERM can be ignored by a wedged or mid-generation `claude`, which would keep it
		// running - and billing - after a Stop while the UI says stopped. Escalate to SIGKILL if
		// it hasn't exited shortly. The timer is unref'd so it never holds the daemon open, and is
		// cleared on a clean exit.
		try {
			const hard = setTimeout(() => {
				try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } catch { /* ignore */ }
			}, 2000);
			hard.unref?.();
			child.once('exit', () => { try { clearTimeout(hard); } catch { /* ignore */ } });
		} catch { /* ignore */ }
	}

	return { send, kill, child };
}
