# codeout chat events (daemon -> client)

Chat-mode sessions stream NORMALIZED events. The daemon does all agent-specific parsing
(today: Claude's `stream-json`) and emits these clean events. Clients (webapp, iOS) render
them directly and never parse raw agent output. This is the contract both sides build to.

## Wire

Each event is JSON inside a `0x03` frame (see PROTOCOL.md):

```
{ "type": "chat", "ev": <ChatEvent> }
```

Device-originated chat events (a user typing from a paired device) get `senderId` +
`senderName` stamped server-side by the bridge, so multiple devices on one session are
attributed. The daemon keeps a BOUNDED per-session log of ChatEvents and replays it to a
client on attach (covers refresh / reconnect). User events are persisted too, not just
agent events.

**Persistence across daemon restart.** The per-session log is DISK-BACKED (append-only
ndJSON at `~/.codeout/chat/<sessionId>.jsonl`, bounded by size with rotation), not just
RAM. After a daemon restart/crash, reconnecting clients get the full prior scrollback
replayed (and the agent is resumed via `--resume`), so the UI is never blank when the
agent still remembers. The on-disk log is dropped when the session is killed.

**`seq`, every event carries one.** The daemon stamps a monotonic per-session `seq`
(starting at 0, persisted across restart) on EVERY ChatEvent it emits. Clients should
order by `seq` and gap-detect on it rather than trusting raw arrival/broadcast order.
`seq` is present on all events below (omitted from the shapes for brevity).

**`ts`, every event carries one too.** The daemon stamps epoch-milliseconds `ts` on every
event at emit time. Clients use it for day/time separators and "how long did this take"
displays. Like `seq`, omitted from the shapes below. (Caveat: a clientId retry
re-broadcast and a queued-clear re-emit carry a FRESH `ts` — clients that already show
the message should keep their original timestamp, not adopt the new one.)

**Incremental replay: `?sinceSeq=N`.** The attach replay normally sends the whole
retained log. A client that kept a local transcript cache can pass `sinceSeq` in the
WebSocket query string to get only events with `seq > N`. If the requested seq has been
evicted from the bounded ring, the replay silently starts at the ring head — clients must
gap-detect (their cache's max seq + 1 vs the first replayed seq) and fall back to a full
refetch when the delta doesn't join.

## ChatEvent (discriminated by `t`)

Every event also carries `seq` (monotonic per session), omitted here for brevity.

```
{ t:"user",     id, text, senderName?, senderId?, queued?:bool, clientId?:string, attachments?:[{name,path,size,type}] }  // a user message, echoed to all clients
{ t:"text",     id, text, final?:bool, parent?:string }   // assistant prose; stream deltas share an id, final closes it
{ t:"thinking", id, text, final?:bool, parent?:string }   // assistant reasoning (client renders collapsed)
{ t:"tool",     id, name, title?, input?, status:"running"|"ok"|"error", output?, parent?:string }  // one per state change, pair by id
{ t:"turn",     phase:"start"|"end", status? }            // turn boundaries -> drive the thinking indicator
{ t:"title",    title }                                   // session title update (soft-deprecated: clients only adopt it when the session has no name yet)
{ t:"error",    message }                                 // surfaced to the user
{ t:"system",   text }                                    // optional init note (model, cwd); also model/effort/mode/clear/Stop notices
{ t:"slash-commands", commands:[...], builtins:[{name,description}] }  // agent's `/` commands + daemon built-ins, for autocomplete
{ t:"permission", id, toolName, input, options:[{id,label,kind}] }  // tool wants approval; BLOCKS until reply
{ t:"permission-resolved", id, decision, auto?:bool, reason? }      // the gate settled (replay shows resolved state)
{ t:"stats", model, contextWindow, effort, permissionMode, costUsd, ctxTokens, apiKeySource, rateLimits:[{type,status,resetsAt}] }  // status-bar meta
{ t:"chat-cleared" }                                      // /clear wiped the conversation; client resets transcript to empty
```

`stats.apiKeySource` says how the agent authenticates (`"none"` = subscription/OAuth).
Clients hide the cost readout unless it's a real API key — subscription usage has no
per-token dollar cost, so showing `costUsd` there would be misleading.

## Client → daemon (structured `0x03` up-frames)

A plain user turn is a raw `0x00` input frame (see PROTOCOL.md). Structured client sends
use the same `{ "type":"chat", "ev": ... }` envelope, routed by the bridge:

```
{ t:"user", text, clientId?, attachments? }   // structured user turn (needed for attachments / retry idempotency)
{ t:"permission-reply", id, decision }        // answer an open permission gate
{ t:"interrupt" }                             // Stop button: abort the live turn
```

Anything else (e.g. `typing:start` / `typing:stop` presence) is re-broadcast verbatim to
the session's OTHER clients — client-to-client sync with no daemon handling.

**`clientId` retry idempotency.** A client stamps each optimistic send with its local
bubble id as `clientId`. The daemon remembers accepted clientIds: a RESENT clientId never
runs a second turn — it re-broadcasts the original `{t:"user"}` echo (fresh `seq`, so a
client past its high-water mark still sees it). The echo always carries the `clientId`
back, so the sender reconciles its optimistic bubble deterministically instead of
content-matching. Retried slash built-ins (`/model` etc.) are deduped the same way.

**`interrupt` (Stop).** Aborts the live turn: the daemon kills the agent child (SIGTERM,
2s SIGKILL escalation), emits a synthetic `{t:"turn", phase:"end"}` plus a `{t:"system"}`
"Stopped." notice, and relaunches with `--resume` so context survives. A queued control
change (`/model` sent mid-turn) folds into that single relaunch. Interrupting the first
turn of a fresh session (no resume id yet) resets honestly to a fresh chat.

## Sessions list: `working` + `lastSeq`

`GET /api/sessions` items carry two chat-status fields: `working` (a turn is live right
now — drive a "busy" indicator) and `lastSeq` (newest retained chat seq, `null` for
terminal sessions). A client that stores the last seq it SAW per session can badge unread
sessions (`lastSeq > seen`). Caveat: retry/queued re-emits bump `lastSeq` without new
content, so an occasional false-positive unread is possible; clients keying read receipts
on open/leave absorb this.

The daemon also broadcasts `{ "type":"rename", "name", "avatar" }` (a top-level frame,
not a ChatEvent) to a session's clients when its name or avatar changes.

## Archive lifecycle (chat sessions)

Archiving replaces killing for chat sessions: the agent ends but the transcript,
uploads, and a generated summary survive under `~/.codeout/archive/<id>/`. Deleting an
archive is the one true kill. Terminal sessions still use `DELETE /api/sessions/:id`.

```
POST   /api/sessions/:id/archive   -> meta            end the agent, keep the chat; summary generates async
GET    /api/archive                -> {archives:[…]}  metas WITHOUT summary text (name, cwd, agent, dates, size, summaryStatus)
GET    /api/archive/:id            -> meta            full record incl. `summary` (for the reopen sheet)
POST   /api/archive/:id/reopen     -> create() result body {mode:"summary"|"resume"}; default "summary"
DELETE /api/archive/:id            -> {ok}            permanent — removes transcript + uploads + summary
```

**Reopen semantics.** `"summary"` (default) creates a FRESH session in the same
cwd/agent/model whose system prompt is extended with the archived summary; the new chat
opens with a `{t:"system"}` event showing exactly what was injected ("Reopened from
archive — summary injected: …"). A still-pending summary is generated at reopen (the
call blocks up to the summarizer timeout). `"resume"` relaunches with claude's native
`--resume <resumeId>` for full conversational fidelity (heavier context) when the id
still resolves. The archived transcript is never replayed into the new session's log.
**Reopening CONSUMES the archive**: on success the archive record (transcript, uploads,
summary) is deleted — the conversation lives in the new session, so it leaves the
archived list. Clients should treat a reopened id as gone (re-fetch returns 404).

Summaries are one-shot `claude -p --model haiku` runs over a compacted transcript
(user turns + final assistant prose + one-line tool labels; thinking excluded).
`summaryStatus` is `"pending"` until it lands; failures stay pending and retry at
reopen. All endpoints are Bearer device/owner like the rest of the API; everything is
403 in DEMO mode.

**`parent` (subagent nesting).** When Claude spawns a subagent via the `Task` tool, the
subagent's `text` / `thinking` / `tool` events carry `parent` = the `Task` tool's
`tool_use` id (the same id as that `Task` tool event). `parent` is ABSENT on top-level
activity (no key, not `null`). Clients use it to render a subagent's prose/thinking/tools
nested inside the Task card. The `Task` tool event itself is top-level (no `parent`).

## Rules

- **Thinking indicator** is ON between `turn:start` and `turn:end`, NOT keyed to a single
  message type. Also clears on `error`. Add a client-side safety timeout. (In practice
  both shipped clients also clear it as soon as visible content streams, and re-arm it
  after a finished tool — that reads better than a chip sitting next to live text.)
- **Text streaming:** emit `{t:"text", id, text}` deltas with the same `id` as tokens
  arrive, then `{t:"text", id, final:true}`. Clients append by id, not replace.
- **History:** bounded ring (e.g. last N events or M bytes) per session; replay on attach.
  The ring is disk-backed, so it survives a daemon restart (see Wire, above).
- **Ordering:** every event has a monotonic `seq`. Order/gap-detect by `seq`, not arrival.
- **Input queue (multi-device).** The daemon SERIALIZES user input. While a turn is live,
  an incoming user message is queued, not sent to the agent (which would interleave two
  devices' input into one stdin, or be silently dropped). A queued message is echoed as a
  `{t:"user", queued:true}` event so its bubble shows immediately as pending. When the
  queue drains it (each into its own real `turn:start`/`turn:end`), the SAME `id` is
  re-emitted WITHOUT `queued` (status cleared). Clients should reconcile by `id`: render
  the bubble on first sight, drop the pending state when the un-`queued` echo arrives.

## File / image attachments

A user message MAY carry uploaded files. The flow is upload-first, then send:

1. The client POSTs the file(s) to the upload endpoint and gets back metadata
   (`{ files:[{name,path,size,type}] }`). `path` is the absolute path on the SERVER.
2. The client sends the user turn as a STRUCTURED chat event over the 0x03 path (not a raw
   input frame): `{ type:"chat", ev:{ t:"user", text, attachments:[{name,path,size,type}] } }`.
   The daemon routes it through the same serialized turn queue as a typed message.
3. Under the hood the daemon feeds the agent the user's text WITH the file paths appended,
   e.g. `"<text>\n\n[Attached files: /uploads/<id>/a.png, /uploads/<id>/b.pdf]"`, so the
   agent can read them. The re-broadcast, seq-stamped `{t:"user"}` echo carries the CLEAN
   `text` plus `attachments`, so every client renders the user's clean bubble + attachment
   chips/thumbnails, NOT the raw paths.

`attachments` is absent when there are none (a plain message stays byte-identical to before).
A turn with attachments and empty text is allowed (an attachments-only turn). When attachments
are present the daemon does NOT treat the text as a built-in (`/model`, `/effort`, `/mode`, `/clear`).

### `POST /api/sessions/:id/upload` (Bearer; multipart/form-data)

Streams the uploaded file(s) to the server-side uploads dir under `<uploadDir>/<id>/`, capped at
`COCKPIT_MAX_UPLOAD` bytes/file (default 100 MB). Returns:

```
{ files: [ { name, path, size, type }, … ] }
```

`name` = original filename, `path` = absolute on-disk path, `size` = bytes, `type` = best-effort
MIME from the extension. A file exceeding the cap → **413** (and all partials are cleaned up).
In CHAT mode the upload does NOT auto-inject a message (the next `user` event carries the refs);
in TERMINAL mode the paths are typed into the PTY (no auto-submit), as before.

### `GET /api/uploads/:id/:name` (Bearer)

Streams a previously uploaded file (for image thumbnails) with a Content-Type from its extension.
`:id` and `:name` are reduced to a basename and the resolved file must sit directly inside
`<uploadDir>/<id>/` (no traversal); a missing file → **404**, a bad path → **400**.

### `GET /api/settings/upload-dir` / `PUT /api/settings/upload-dir` (Bearer)

The server-side uploads directory (WHERE uploaded files land on the host) is a daemon-level
setting SHARED across all devices (not per-device), persisted in `~/.codeout/upload-config.json`
as `{ uploadDir }`. `GET` → `{ dir }`. `PUT { dir }` validates STRICTLY and persists it:

- `dir` must be a non-empty string that resolves to an ABSOLUTE path UNDER the user's home dir
  (`homedir()`); the home dir itself and anything outside it (`/etc`, `/root`, `/usr`, …) are
  rejected. Invalid → **400** with a clear message.
- A valid dir is created recursively at mode 0700 (if missing) and confirmed writable.
- Success → `{ dir }` (the resolved absolute path).

Resolution at runtime: persisted `uploadDir` (re-validated) → `CODEOUT_UPLOADS` env →
`~/.codeout/uploads`.

## Tool permissions (approval gate)

Tools do NOT auto-run. When the agent wants to use a tool, the daemon emits a
`permission` event and BLOCKS the tool at the agent until a client replies. The reply
travels back over the existing 0x03 chat path.

**Daemon -> client** when a tool needs approval:

```
{ t:"permission", id, toolName, input,
  options:[ {id:"allow_once",    label:"Allow once",        kind:"allow"},
            {id:"allow_session", label:"Allow for session", kind:"allow"},
            {id:"deny",          label:"Deny",              kind:"reject"} ] }
```

`id` is the tool call id, it equals the later `tool` event's `id`, so the client pairs
the prompt to its tool bubble.

**Client -> daemon** reply (over the 0x03 chat path):

```
{ type:"chat", ev:{ t:"permission-reply", id, decision } }   // decision = an option id
```

Transports (see PROTOCOL.md): plaintext clients send the WS JSON `{type:"chat", ev}`;
e2e clients send the same `{type:"chat", ev}` inside a 0x03 frame. The daemon's inbound
0x03 handler routes a `permission-reply` to the pending gate (it is NOT re-broadcast, 
the daemon emits the authoritative `permission-resolved`); any other client chat event is
still re-broadcast to the other clients.

**Behaviour:**
- `allow_once` -> run the tool (normal `tool` running->ok/error lifecycle).
- `allow_session` -> run it AND add `toolName` to a per-session allow-list; that tool is
  not prompted again for the life of the session (auto-allowed `permission-resolved` is
  emitted with `auto:true` instead of a `permission` prompt).
- `deny` -> the tool does not run; the agent receives a denied tool_result, which the
  daemon surfaces as `{t:"tool", status:"error", output:"denied by user"}`.
- Default posture is PROMPT. The one exception is claude's OWN safe-command classifier:
  the CLI auto-allows obviously read-only calls without asking us (no `permission` event
  is emitted for those). Everything the CLI would have prompted for in a TTY reaches the
  gate. This is the "pre-allow read-only" distinction the contract permits.
- A `permission` and its `permission-resolved` are persisted to the ChatLog, so a client
  that reconnects after the decision sees the gate already settled, not a stale live prompt.
- If a turn ends (or the backend dies) with a prompt still open, the daemon resolves it as
  `deny` (reason noted) so the agent never hangs and clients drop the live prompt.

**Mechanism (why this is light).** The daemon launches `claude` with the built-in
`--permission-prompt-tool stdio` flag (present in the CLI bundle, hidden from `--help`;
it is exactly what `@anthropic-ai/claude-agent-sdk` passes for its `canUseTool` callback,
verified by spying on the SDK's subprocess). With that flag, claude routes each
permission decision to a `can_use_tool` control_request on stdout and waits for the
daemon's `control_response` on stdin before running the tool, over the SAME stream-json
pipe. No MCP server, no SDK dependency, no change to text streaming / multi-turn /
`--resume` / queue / titles. The flag alone arms the gate (no `initialize` handshake
needed; verified against claude 2.1.179).

## Claude mapping (`claude -p --output-format stream-json --verbose --input-format stream-json --permission-prompt-tool stdio --append-system-prompt <chat nudge>`)

stdout is ndJSON. No PTY. Token streaming.
- `system`/`init` -> optional `system` event (capture `session_id` for `--resume` after a daemon restart).
  Its `slash_commands` array -> one `slash-commands` event (the agent's `/` command list, for autocomplete).
- `assistant` message content blocks: `text` -> `text`; `thinking` -> `thinking`;
  `tool_use` -> `tool(status:"running", name, input)`.
- `user` message `tool_result` block -> `tool(status:"ok"|"error", output)`, paired by `tool_use_id`.
  A denied tool yields `is_error:true` with our message, surfaced as `tool(status:"error", output:"denied by user")`.
- **`parent_tool_use_id`** rides on the top-level `assistant` / `user` / `stream_event` lines. When set
  (a subagent spawned by the `Task` tool), it equals that `Task` tool's `tool_use.id`; the daemon stamps it
  onto the emitted `text`/`thinking`/`tool` events as `parent`. `null` = top-level (no `parent` key emitted).
- `control_request{subtype:"can_use_tool", tool_name, input, tool_use_id}` -> `permission` event
  (its `id` = `tool_use_id` = the assistant `tool_use.id`). The reply is a `control_response`
  `{subtype:"success", response:{behavior:"allow", updatedInput}}` or `{behavior:"deny", message}`.
- `result` -> `turn(phase:"end")`. A new user prompt -> `turn(phase:"start")`. The `result` line
  also feeds the `stats` bar: `usage.{input_tokens,cache_read_input_tokens,cache_creation_input_tokens}`
  (→ `ctxTokens`), `modelUsage[model].contextWindow` (→ `contextWindow`), `total_cost_usd` (→ `costUsd`).
- `rate_limit_event` (`rate_limit_info.{rateLimitType,status,resetsAt}`) -> the `stats` bar's
  `rateLimits` (latest per type). No `text`/`tool` event, it's status-bar telemetry only.
- Use `--include-partial-messages` for token-level `stream_event` deltas (nicer typing feel).
- `--append-system-prompt` adds a short chat-mode nudge (be conversational; emit an
  `<options><option>…</option></options>` block for discrete multiple-choice questions, which
  codeout's markdown renderer turns into tappable chips). APPENDED to the default system prompt,
  so tools / permissions / titles / streaming are unchanged.

## Quick-reply options (chips)

codeout's markdown renderer parses an `<options><option>Label</option>…</options>` block into
tappable buttons. The chat backend's `--append-system-prompt` tells the agent to emit that block
when it poses a discrete multiple-choice question (short labels, one `<option>` per choice). The
user can tap a chip (sends that label as a normal user turn) or type a free-text answer. This is a
NUDGE in the system prompt, not a wire-format change, the block is just text inside a `text` event.

## Status bar (`stats` event)

The daemon emits a `{t:"stats", …}` ChatEvent that the client renders as a top status bar. It is
RECOMPUTED from the stream (nothing special is persisted, the accumulator is rebuilt as the agent
runs). Shape:

```
{ t:"stats",
  model:        "claude-opus-4-8[1m]" | null,   // live model (system/init; reflects /model)
  contextWindow: 1000000 | null,                // tokens the model's window holds (from result.modelUsage[model])
  effort:       "high" | null,                  // the --effort launch param (null = model default)
  permissionMode: "default"|"acceptEdits"|"plan"|"bypassPermissions",  // the --permission-mode launch param; reflects /mode
  costUsd:      0.25,                            // cumulative session cost (result.total_cost_usd; already cumulative)
  ctxTokens:    49000 | null,                    // how full the window is now = input + cache_read + cache_creation tokens
  rateLimits:   [ { type:"five_hour", status:"allowed", resetsAt:1781739600 }, … ] }
```

Sources (all from the Claude stream; no fabrication):
- **`model`**: `system/init` `model`. Also set on a daemon-side `/model` swap.
- **`contextWindow`**: `result.modelUsage[<model>].contextWindow` (e.g. `1000000`).
- **`ctxTokens`**: from each `result`: `usage.input_tokens + usage.cache_read_input_tokens +
  usage.cache_creation_input_tokens` (output tokens don't occupy the window).
- **`costUsd`**: `result.total_cost_usd` (the CLI reports it already-cumulative for the session).
- **`rateLimits`**: from each `rate_limit_event`: `rate_limit_info.{rateLimitType, status, resetsAt}`,
  kept LATEST PER `rateLimitType` (so `five_hour` and `seven_day` are separate entries). **There is NO
  percentage in the stream**: only `status` + `resetsAt` + `type`; the daemon does not invent one.
- **`effort`**: the daemon's `--effort` launch param (null = default), updated on `/effort`.
- **`permissionMode`**: the daemon's `--permission-mode` launch param (always concrete; a new session
  inherits the owner-set `defaultPermissionMode` setting), updated on `/mode`.

**When it's emitted:** on `system/init` (model), on each `result` (cost/ctx/window update), on each
`rate_limit_event` (rate update), and forced after a `/model`, `/effort`, `/mode`, or `/clear`. Emits are
COALESCED (one frame per ~250 ms tick) so a burst of result + rate lines doesn't spam frames; the
forced emits flush immediately. Each `stats` event carries a `seq` like every other event.

## Slash commands, built-ins, `/model`, `/effort`, `/mode`, `/clear`

**Autocomplete list.** The agent's `slash_commands` (from `system/init`) is relayed once as a
`{t:"slash-commands", commands:[...], builtins:[...]}` event so the client can show a `/` autocomplete.
It's re-emitted after a backend relaunch (e.g. `/model`, `/effort`) with a new `seq`. `commands` is the
agent's PLUGIN/skill list (e.g. `feature-dev:feature-dev`, `code-review:code-review`). `builtins` is the
daemon's CURATED list of built-ins that actually work headless, each `{name, description}`:

```
builtins: [
  { name:"model",  description:"Switch model" },
  { name:"effort", description:"low|medium|high|xhigh|max" },
  { name:"mode",   description:"default|acceptEdits|plan|bypassPermissions" },
  { name:"clear",  description:"Start a fresh chat" }
]
```

TUI-only built-ins (`/help`, `/compact`, `/agents`, …) are intentionally NOT in `builtins`, they have
no headless behaviour.

**Do built-in slash commands work headless?** No, not via the agent. Sent as a stream-json user message
to `claude -p`, a built-in like `/model` / `/effort` / `/mode` / `/clear` / `/compact` / `/agents` does NOT trigger
the built-in behaviour, the headless transport has no interactive picker/UI. So the daemon HANDLES the
useful ones itself (`/model`, `/effort`, `/mode`, `/clear`) in the chat input path before they reach the agent;
the rest fall through as a normal user turn.

**`/model <name>`, daemon-side switch.** The daemon intercepts it BEFORE the agent: echoes the command
as a `user` bubble, kills the claude child, and relaunches with `--model <name> --resume <session_id>`
(the captured `session_id`), keeping the full conversation context. A `{t:"system"}` notice (`Model
switched to <name>.`) is emitted and a forced `stats` follows. `/model` with no name reports the current
model. Refused mid-turn (a relaunch would drop the in-flight turn). The model is persisted, so a daemon
restart resumes on it.

**`/effort <level>`, daemon-side relaunch (same pattern).** `--effort` is a real claude flag
(`low|medium|high|xhigh|max`). The daemon validates the level, echoes the command, kills the child, and
relaunches with `--effort <level> --resume <session_id>` so context is kept. A `{t:"system"}` notice
(`Effort → <level>.`) is emitted and a forced `stats` shows `effort:<level>`. `/effort` with no level
reports the current effort; an unknown level is rejected with a notice. Refused mid-turn. The effort is
persisted, so a daemon restart resumes on it.

**`/mode <permission-mode>`, daemon-side relaunch (same pattern).** `--permission-mode` is a real claude
flag; the daemon exposes `default|acceptEdits|plan|bypassPermissions` (UI labels Default / Accept edits /
Plan / Auto). `default`/`acceptEdits`/`plan` keep the `can_use_tool` gate live for whatever they'd prompt
for; `bypassPermissions` ("Auto") runs every tool without asking (claude never escalates, so the gate
goes silent). The daemon validates the value, echoes the command, kills the child, and relaunches with
`--permission-mode <mode> --resume <session_id>` so context is kept. A `{t:"system"}` notice (`Permission
mode → <mode>.`) is emitted and a forced `stats` shows `permissionMode:<mode>`. `/mode` with no arg
reports the current mode; an unknown mode is rejected with a notice. Refused mid-turn. The mode is
persisted per session; a NEW session inherits the owner-set `defaultPermissionMode` setting
(`GET`/`PUT /api/settings/permission-mode`, PUT owner-only).

**`/clear`, fresh chat.** The daemon kills the child, drops the resume id and the conversation
scrollback (in-memory ring + on-disk ndJSON), resets the stats accumulators (cost/ctx/rate), and
relaunches claude CLEAN (no `--resume`). A `{t:"chat-cleared"}` event tells clients to reset the
transcript to empty, followed by a `{t:"system"}` notice (`Started a fresh chat.`) and a forced `stats`.
The session RECORD survives (same id/cwd/agent, tab + pairing stay valid), only the conversation is
wiped. Refused mid-turn. `seq` continues monotonically across the clear (gap-detect still holds).

## Adding an agent

Each agent gets its own backend module that parses the agent's native output into the same
ChatEvents above. The host (`sessions.js`) is agent-agnostic: it owns the turn queue, the
permission gate + session allow-list, the stats bar, the persistent log, and `/model /effort
/mode /clear /Stop` (all via `relaunchBackend` → `s.startBackend()` = kill child + recreate with
the captured `resumeId` → resume). Backends are dispatched by `CHAT_BACKENDS[agent]`, and the
picker reads `GET /api/agents` (`agents.js` detection: installed / chat-capable / coming-soon).

- **Claude** (`claude-chat.js`): `stream-json` ndJSON. Reference implementation.
- **Codex** (`codex-chat.js`, SHIPPED): `codex app-server --listen stdio://`, JSON-RPC 2.0 over the
  shared `json-rpc.js` transport. `initialize` → `thread/start` (resumeId → `thread/resume`); resume
  key = `thread.id`. Notifications → events: `item/agentMessage/delta`→`text` (streamed by itemId,
  DON'T re-emit the full text on `item/completed` if deltas came), `item/reasoning/*Delta`→`thinking`,
  `item/started`/`item/completed` for `commandExecution|fileChange|mcpToolCall|webSearch`→`tool`
  (running→ok/error), `turn/completed`→`turn:end`, `thread/tokenUsage/updated`→`ctxTokens`,
  `account/rateLimits/updated`→`rateLimits` (carries `usedPercent`). Approvals = server REQUESTS
  (`item/*/requestApproval`, `applyPatchApproval`, `execCommandApproval`) → `onPermission` → reply
  `{decision:"accept"|"decline"}` (NOT "reject"). No dollar cost (tokens only). `/model`+`/effort`
  ride `turn/start` overrides. Verified E2E incl. the approval gate on codex-cli 0.133.
- **Gemini** (`gemini-chat.js`, SHIPPED): `gemini --acp` (Agent Client Protocol) on the same
  `json-rpc.js` transport. `initialize` (advertise fs/terminal=false) → `session/new` (resumeId →
  `session/load`); resume key = `sessionId`. `session/update` variants → events (`agent_message_chunk`
  →`text`, `agent_thought_chunk`→`thinking`, `tool_call`/`tool_call_update`→`tool`); the streaming
  bubble uses a per-turn random id + a `final:true` closer on the `session/prompt` result (ACP chunks
  carry no stable id). Permission = `session/request_permission` REQUEST; Gemini supplies its OWN
  `options[]` → passed through, reply the chosen `optionId` (prefer `allow_once`). The chat persona +
  `<options>` nudge + archive summary are PREPENDED to the first prompt (ACP has no system-prompt
  field). Needs `GEMINI_API_KEY` (in SAFE_ENV) or a prior OAuth; unauthed → a clear error, no crash.
  Mapping unit-tested + handshake verified; a full authed turn is the one thing not yet run live.

## Titles

Server-side, derived from the first user message + first assistant reply. NEVER instruct the
agent to call back into the daemon's API (the old `curl` directive was insecure and 401'd anyway).

## Device identity (name + avatar + colour): daemon-synced

Each paired device has an identity: a **name**, a **bubble colour**, and an **avatar**. The
daemon is the single source of truth (NOT per-browser localStorage); identity is 2-way synced
to every client so a device looks the same on every surface.

- **`colour`** is a palette KEY (a string), not a hex value. Fixed set:
  `pink | emerald | violet | amber | sky | rose`. `pink` is the default/accent. Clients map
  the key to their own theme. Old records without a colour read back as `pink`.
- **`avatar`** is a data-URL image string (e.g. `data:image/png;base64,...`) bounded to
  **128 KB**, or `null` when unset. Old records without an avatar read back as `null`.

### `GET /api/devices` (Bearer; any paired-device token)

Returns the full device list with identity:

```
{ devices: [ { id, name, paired, current, colour, avatar }, ... ] }
```

`current:true` marks the device the requesting token belongs to. `colour` is always one of
the palette keys; `avatar` is a data-URL string or `null`.

### `PATCH /api/devices/:id` (Bearer; any paired-device token)

Edit a device's identity. Body (all fields optional, only the present ones change):

```
{ name?: string, colour?: "pink"|"emerald"|"violet"|"amber"|"sky"|"rose", avatar?: <data-url>|null }
```

- `colour` must be one of the palette keys, else **400**.
- `avatar` must be a `data:` URL ≤ 128 KB, or `null` to clear it, else **400**.
- `name` must be a non-empty string (trimmed, capped at 40 chars), else **400**.
- Unknown `:id` → **404**.
- Success → `{ ok: true }`.

**Permissive by design (flat trust).** Any paired-device token may edit ANY device, the
daemon does NOT enforce self-only editing (it matches codeout's revoke-anyone model; codeout
isn't multi-tenant). The iOS "edit only my own device" rule is a **client-side UX convention
for polish, NOT a server boundary.** The web app edits every device row.

### `devices-updated` signal (daemon → all clients, ALL sessions)

After any change to the device list, a successful `PATCH`, a revoke (`DELETE /api/devices/:id`
or `DELETE /api/devices/me`), or a new `POST /api/pair`, the daemon broadcasts a lightweight
signal to EVERY connected client across ALL sessions, over the same `0x03` JSON-frame
mechanism as chat events (PROTOCOL.md):

```
{ "type": "devices-updated" }
```

It carries no device data. On receipt a client refetches `GET /api/devices` and re-renders
device bubbles/avatars/colours. Note this frame's top-level `type` is `devices-updated`, NOT
`chat`, so a client's chat-event handler ignores it, route on `type` first.
