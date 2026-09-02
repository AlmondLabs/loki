# Grounding dossier: Letta Code mod API (canvas mod design)

Sources (letta-code v0.31.6):
- BUNDLE = /Applications/Letta.app/Contents/Resources/app.asar.unpacked/node_modules/@letta-ai/letta-code/letta.js (unminified JS bundle with `// src/...` markers; NO .d.ts files ship in the package)
- SKILL = .../letta-code/skills/creating-mods/ (SKILL.md + references/*.md — the official API docs on this machine)

## Q1. Conversation id inside a TOOL handler — CONFIRMED
Tool `run(ctx)` ctx is assembled at BUNDLE:124262-124287 (`executeModTool`):
```js
const modContext = toolExecutionModContext(executionScope, options);
const context3 = { ...modContext, args, toolCallId: options.toolCallId ?? null, signal,
  secret: createModSecretResolver({...}),
  ...options.onOutput ? { onOutput: (chunk, stream) => {...} } : {},
  conversation: createModConversationHandle({ agentId: executionScope.agentId, backend,
    conversationId: executionScope.conversationId, sendMessageStream: ..., workingDirectory: options.workingDirectory }) };
```
`modContext` fields (BUNDLE:85507-85560 `buildModInvocationContext`): `app, workspace, cwd, sessionId (= conversationId), conversationSummary, lastRunId, agent{id,name}, model{id,displayName,provider,reasoningEffort}, toolset, systemPromptId, permissionMode, networkPhase, terminalWidth, contextWindow, cost, reflection, memfs, backgroundAgents, subagents`.
So conversation id = `ctx.conversation.id` (or `ctx.sessionId`). Note: docs (SKILL references/architecture.md:144) say "Tools currently receive ctx.conversation.getHistory() but not fork/send helpers" — but the CODE passes the FULL handle (fork/sendMessageStream included) to tools (BUNDLE:124276-124286). Treat fork/send-from-tool as undocumented/unsupported.

## Q2. Event handler context — CONFIRMED
Event ctx (SKILL references/events.md:300-316, verbatim):
```ts
{ conversation: { id: string | null; fork(options?): Promise<conversation>;
    getHistory(options?): Promise<Message[]>;
    sendMessageStream(messages, options?): Promise<AsyncIterable<chunk>>; };
  agent: ModContext["agent"]; cwd: string; model: ModContext["model"];
  permissionMode: string | null; signal: AbortSignal; }
```
Code: BUNDLE:387398-387410 builds eventContext = `{ ...context3, conversation: createModConversationHandle({ agentId: event.agentId ?? ctx.agent.id, backend, conversationId: event.conversationId ?? context3.sessionId, ... }), signal }`.
`conversation_open` payload (events.md:82-90): `{ agentId, agentName, conversationId, previousConversationId?, reason: "startup" | "new" | "resume" | "fork" }`.
`turn_start` payload (events.md:107-113): `{ agentId, conversationId, input: Array<MessageCreate | ApprovalCreate> }`.
`turn_end` (undocumented in skill docs; code only) payload at BUNDLE:495340-495345 & 445948-445956: `{ agentId, conversationId, stopReason, assistantMessage }`.
Supported event names (BUNDLE:387616-387627): `conversation_open, conversation_close, tool_start, tool_end, turn_start, turn_end, compact_start, compact_end, llm_start, llm_end`. Capability map (BUNDLE:386729-386746): turn_start AND turn_end gate on `capabilities.events.turns`.

## Q3. Injecting a user message / starting a turn from outside a turn — CONFIRMED (two mechanisms)
(a) **turn_end `continue`** — a `turn_end` handler returning `{ continue: string }` injects a real user message into the LIVE conversation. BUNDLE:386772-386774: `isTurnEndResultWithContinue: name === "turn_end" && typeof result2.continue === "string" && result2.continue.length > 0`. TUI consumption BUNDLE:495352-495363:
```js
if (turnEndContinue) { setTimeout(() => { processConversation([
  { type: "message", role: "user", content: turnEndContinue, otid: continueOtid }
], { allowReentry: true }); }, 0); return; }
```
Headless equivalent BUNDLE:445948-445960 (`emitHeadlessTurnEnd` returns `event.continue`). Constraint: only fires AT turn end — a WebSocket callback can set a flag/queue that the next `turn_end` drains, but cannot start a turn while idle via this path.
(b) **conversation handle send** — every command/event ctx (and, per code, tool ctx) carries `ctx.conversation.sendMessageStream(messages, sendOptions, requestOptions)` (BUNDLE:87132-87138), backed by `sendMessageStreamWithBackend(backend, conversationId, messages, opts = { streamTokens: true, background: true }, requestOptions)` (BUNDLE:123112). The handle can be captured and called later (e.g. from a WebSocket callback); it is bound to conversationId+backend, not to the turn. `fork(forkOptions)` (BUNDLE:87105-87113) creates a scoped handle to a forked conversation via `backend.forkConversation(...)`. Docs (architecture.md:70-79, commands.md:111-127) explicitly bless fork+send for background model work and warn: "Do not call ctx.conversation.sendMessageStream() on the active conversation from a busy command; direct sends can conflict with the active run." Direct sends to the main conversation bypass the TUI turn loop (no transcript rendering path found for them). No `letta.conversations` top-level API exists; the full `letta` API object (BUNDLE:387083-387273) is: `capabilities, client, getClient, signal, registerProvider, unregisterProvider, commands.{register,unregister}, tools.{register,unregister}, providers, events.{on,off}, permissions, diagnostics.report, ui.{openPanel,closePanel,notify,…}`.

## Q4. Observing assistant output — CONFIRMED (turn end), REFUTED (token stream of main conversation)
- `turn_end` event carries `assistantMessage` (last assistant text of the turn) + `stopReason` — BUNDLE:495340-495345: `const turnEndEvent = { agentId, conversationId, stopReason: stopReasonToHandle, assistantMessage };` where `assistantMessage` = text of last assistant buffer line (BUNDLE:495302-495304).
- `llm_end` (events.md:279-296): `{ agentId, conversationId, model, stopReason, usage: {promptTokens, completionTokens, totalTokens} | null, durationMs, error? }` — usage/stop only, NO message content; local backend only (events.md:64).
- `tool_end` (events.md:150-162): `{ agentId, conversationId, toolCallId, toolName, args, status, output }` — full tool output observable/replaceable.
- No mod event streams main-conversation assistant tokens. Streaming IS available for conversations the mod drives itself: `forked.sendMessageStream([...])` returns an AsyncIterable of chunks (events.md:308, commands.md:120-125).

## Q5. UI capabilities — CONFIRMED (panels + notify only; no ask-question)
- `letta.ui.openPanel({ id, order, render })` → `{ update(options?), close() }` (BUNDLE:387226-387263; ui.md:29-44). `render(ctx: { width, agent, model, backgroundAgents, subagents, row, columns, link, chalk }): string | string[]` (ui.md:59-76). `order` semantics (ui.md:47-55): >1 above input; 1 = dreaming row; 0 = statusline slot; <0 below.
- `letta.ui.notify(message)` — persistent transcript notification, TUI-only (ui.md:17-23; BUNDLE:387219-387225).
- Statusline = order-0 panel; old setStatus/setStatuslineRenderer APIs are removed traps (BUNDLE:87186-87192).
- NOT FOUND: any ask-question/prompt-user/select UI in the mod API (grep for askQuestion/ui.ask over bundle: none). Panels are TUI-only: "Desktop/listener disables this capability" (ui.md:13).

## Q6. turn_start context injection/rewrite — CONFIRMED
Handlers may mutate `event.input` or return `{ input }` or `{ cancel: { reason } }` (events.md:191-227). Code: BUNDLE:386748-386757 `isTurnStartResultWithInput` / `isTurnStartResultWithCancel`; applied at BUNDLE:387411-387419 (`event.input = result2.input`, first valid cancel reason wins). Cancellation only blocks submit; it does not synthesize a response (events.md:227). Docs pattern: append/prepend focused context (architecture.md:101-103).

## Q7. Existing mods on this machine — NOT FOUND
`~/.letta/mods/` does not exist (verified `ls`: "No such file or directory"); no diagnostics/latest.json. No example mods ship inside the app package (only `skills/`, `assets/`, `letta.js`). The creating-mods skill references (tools.md, commands.md, events.md, ui.md, plan-mode.md, architecture.md) are the best local exemplars.

## Extra facts relevant to a canvas mod
- Mods are plain .ts/.js files in `~/.letta/mods/` exporting `default function activate(letta)`; cleanup via returned disposer (SKILL.md:61-78). Node/Bun built-ins allowed (`node:http` etc.); third-party npm deps require `letta mods package` (SKILL.md:23, 123).
- `ctx.conversation.getHistory({ limit, order, includeErrors })` — default limit 100, max 500, via `backend.listConversationMessages` (BUNDLE:87050-87077).
- `ctx.conversation.updateLlmConfig({ model?, reasoningEffort?, contextWindow?, scope? })` and `updateTitle(title)` exist on the handle (BUNDLE:87120-87150).
- `letta.client` = lazy Letta API client proxy (BUNDLE:386697-386722); unavailable in listener mods (BUNDLE:387856-387858).
- Long-lived work must respect `letta.signal` / `ctx.signal` (aborted on /reload and shutdown) — events.md:320, architecture.md:126.
