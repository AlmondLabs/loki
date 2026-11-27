# Fix ACP Support Gaps and Add Antigravity (`agy`)

Date: 2026-11-28

## Goals

1. Fix lifecycle, streaming, persistence, usage, permission, elicitation, protocol, and Settings issues in `loki`'s ACP subsystem.
2. Add Antigravity CLI (`agy`) as a built-in ACP engine (`id: "agy"`, `name: "Antigravity"`, `command: "agy"`, `args: ["acp"]`, `login: "agy acp --login"`).

## Scope

### Built-in Antigravity Engine & Environment Handling (`daemon/acp/agents.ts`, `daemon/mcp/index.ts`)
- Export `AGY` and include it in `BUILT_IN_AGENTS`.
- Verify executable permissions (`statSync().isFile()` and `X_OK` on POSIX) in `commandPath`.
- Pass each ACP engine's `env` into `McpTools.acpServers` so stdio MCP server binaries on engine-specific `PATH` resolve cleanly.

### Process & Protocol (`daemon/acp/process.ts`)
- Pass real client version in `initialize` `clientInfo`, advertise `session: { compaction: {}, notices: {} }`, validate `init.protocolVersion === PROTOCOL_VERSION` and `init.authMethods`, flush trailing stderr on stream end, add `resumeSession` and `closeSession`, and forward optional `AbortSignal` (`$/cancel_request`) to `newSession`, `loadSession`, `resumeSession`, and `prompt`.

### Catalog, Wire Frames & Settings (`daemon/kernel/index.ts`, `core/frame-types.ts`, `core/frames/chat.ts`, `daemon/acp/catalog.ts`, `app/src/settings/engines.tsx`)
- Add `cost_so_far` to `ChatEngine`, `reasoning` to `UsageAdd`, and `"pi.compaction"` support to `AgentStore.appendEntries`.
- Expose optional `env`, `auth_method`, and `login` in `EngineView`, `chat_engine_set`, `AcpCatalog`, and `EngineForm`, with duplicate-id validation, broader `SIGNED_OUT` matching, cache eviction on edit/remove, and `commandFound` gating in `AcpCatalog.models()`.

### Loki HTTP MCP & Daemon Wiring (`daemon/acp/loki-tools.ts`, `daemon/acp/scripts.ts`, `daemon/main.ts`)
- Cap HTTP request bodies (`MAX_BODY_BYTES`), attach `cwd` on `ChatCall` in `runAs`, scope `LokiTools.readOnly(agentId)` by `forAgent`, add `forgetChat`/`forgetAgent` token cleanup, document `// @description:` in `scriptToolDescription`, await `lokiTools.start()`, and skip archived/uninstalled engines in `passes.acp.engineFor`.

### Stream, Lifecycle, Approvals & Harness (`daemon/acp/stream.ts`, `daemon/acp/chats.ts`, `daemon/acp/engine.ts`, `daemon/chat-backend.ts`, `daemon/chat-move.ts`, `core/attention/model.ts`, `core/chat-links.ts`, `app/src/chat/permission-mode.tsx`, `core/harness.ts`, `app/src/shared/tool-steps.ts`)
- Serialize turn persistence on `Turn.writeChain`, push completed call steps synchronously, fix empty `newText` diff lines and `resource`/`resource_link` tool content, track `thoughtTokens` and persisted `cost_so_far`, handle `config_option_update` mode/model changes, `compaction_summary_chunk`/`compaction_update`, and error `notice`s.
- Probe `checkEngine` in an isolated `AcpProcess`, close sessions cleanly on `leave`/`Stopped`/aborted `newSession`, try `resumeSession` before `loadSession`, synchronize `runPass` mutations onto `live.queue`, handle `"default"` model / cleared effort resets, guard image-only sends to text-only agents, prevent `elicit` deadlock during `newSession` and bind `stop` signal + `allow_always: false`, auto-allow pass tools in `permission`, expose `allow_always` to `offersAlways`, refuse `exportChat` on ACP chats, expand `ACP_MODES` & `isOpenDoor`, and normalize `mcp__loki__*` / `script` in harness formatters.
