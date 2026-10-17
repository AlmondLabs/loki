---
title: ACP Chats - Plan
type: feat
date: 2026-10-17
topic: acp-chats
execution: code
---

# ACP Chats - Plan

## Goal

- **Objective:** The person can chat with any of their agents through Claude Code, signed in with their own Claude
  plan, without leaving loki. The chat behaves like any other: it streams, shows tool calls, asks for approvals in
  the Inbox and on the phone, can be stopped, and feeds the agent's memory through the passes.
- **Means:** loki becomes an [Agent Client Protocol](https://agentclientprotocol.com) client, in the role Zed plays.
  A chat gets an **engine**: **loki** (pi-durable plus a provider's model, as today) or an **ACP agent** (a program
  loki runs and talks to over stdio). Claude Code is the first ACP agent, through
  `@agentclientprotocol/claude-agent-acp`; any other agent that speaks ACP (Codex, Gemini CLI and the like) can be
  added by its command.
- **Why now:** a Claude subscription can't be used as an API provider, so the person's Claude Code chats happen
  outside loki today, and loki's Inbox, Tasks and memory never see them.
- **Execution profile:** One branch per unit, `feat/acp-…`, each from `main` after the one before has merged, each
  its own PR with every check run on CI's toolchain.

## Decisions

All user-directed, 2026-10-17, in the brainstorm.

- **KD1. A general ACP client, Claude first.** loki runs any ACP agent from a command; Claude Code is built in as the
  first one, found and tested first. (Chosen over a Claude-only integration.)
- **KD2. The engine is chosen per chat, for any agent.** An agent stays who it is (name, folder, persona, memory,
  Tasks); each chat picks where it runs. There is no separate kind of agent and no separate section in Agents.
  (Chosen over an ACP agent as its own entry with a badge, and over a separate list.)
- **KD3. Chosen in the model picker.** The picker gains a group per ACP agent ("Claude Code": its models, such as
  opus and sonnet) beside the providers' models. Choosing one before the first message makes the chat an ACP chat.
  (Chosen over a separate engine switch.)
- **KD4. Fixed once the chat starts.** After the first message the picker only offers the same engine's models: the
  history lives in a different place, and switching would lose detail. A new chat is how you change. (Chosen over
  switching with a handover summary.)
- **KD5. The agent's persona and memory go with it.** The agent's memory section (its `system/*.md` files, persona
  included, and the list of its other memory files) and its skills list are appended to the ACP agent's system
  prompt at the start of each session. Claude Code keeps its own `CLAUDE.md`, tools and settings. (Chosen over
  persona only, and over plain Claude Code.)
- **KD6. The passes run on a loki model when there is one.** Reflection, Learn and `/doctor` read an ACP chat's
  transcript like any other and run on the agent's own loki model. With no provider set up, they skip the agent, as
  they do today when its model is unavailable. (Chosen over skipping ACP chats and over hidden ACP sessions.)
- **KD7. New chats first; continuing existing Claude Code sessions comes later.** This plan handles chats started in
  loki. Listing `~/.claude/projects` sessions and continuing them in loki needs the adapter's experimental
  `session/list` and resume, and gets its own plan. (Chosen over doing it in the first PR, and over never.)
- **KD8. The agent does its own files and terminals.** loki does not offer ACP's `fs/*` or `terminal/*` client
  methods; Claude Code reads, writes and runs commands itself, as in a terminal. loki still shows every tool call,
  its diff and its output from `session/update`. (Chosen over loki handling files.)
- **KD9. The Claude adapter runs through `npx`, pinned.** loki runs
  `npx -y @agentclientprotocol/claude-agent-acp@<pinned version>` on first use. Claude Code users have Node on their
  PATH; nothing is bundled into the app, and a loki release moves the pin. (Chosen over bundling and over asking the
  person to install it.)
- **KD10. The agent's own modes, loki's approval cards.** The mode chip lists the modes the ACP agent reports (for
  Claude Code: default, acceptEdits, plan, bypassPermissions) instead of loki's four. Every
  `session/request_permission` becomes a loki approval card, in the Inbox and on the phone, with the options the
  agent offers (allow once, always allow, reject). loki's own "always allow" list does not apply: the agent keeps
  its own. (Chosen over mapping loki's modes onto the agent's.)
- **KD11. No loki tools inside ACP chats, for now.** The ACP agent gets only its own tools and MCP servers; loki's
  Tasks, desk and camera tools, and its `memory_*` tools, are not offered. Memory still grows through the passes
  (KD6). (Chosen over a loki MCP server passed at `session/new`.)

## Requirements

- R1. In a new chat with any agent, the model picker shows a **Claude Code** group when Claude Code can run (Node on
  PATH and the `claude` login present), and a group for each other ACP agent the person has added.
- R2. Choosing an ACP model before the first message makes the chat an ACP chat; after it, the picker offers only
  that engine's models, and the composer shows which engine the chat runs on.
- R3. An ACP chat streams the reply, shows tool calls with their arguments, diffs and results, and shows the
  agent's plan updates as a list.
- R4. Each permission request shows as an approval card with the agent's options, in the conversation, the Inbox's
  NEEDS YOU and on the phone; answering in any of them answers the agent.
- R5. Stop cancels the turn (`session/cancel`); the mode chip shows and sets the agent's modes.
- R6. The slash palette lists the agent's own commands (`available_commands_update`) alongside loki's; choosing one
  sends it as the agent expects.
- R7. The transcript is loki's own: history paging, the Inbox digest, the catch-up and the passes read it as they
  read any chat, and it survives loki and the agent restarting.
- R8. After a restart, sending to an ACP chat resumes its session when the agent can (`session/load` or resume);
  when it can't, loki says so in the chat and offers a new chat in the same folder.
- R9. Tokens and cost the agent reports land in the usage ledger under the agent's model, origin **chats**. When the
  agent reports none, the usage page shows nothing for those chats rather than a guess.
- R10. Settings › **engines** lists the ACP agents: Claude Code with its status
  (ready, Node missing, not signed in) and a way to add another by name and command.
- R11. When the agent process fails to start or exits, the chat shows the reason (the last lines of its stderr) and
  loki restarts it on the next send.
- R12. Words on screen follow docs/style.md §6; the manual explains engines, the Claude Code setup and what a Claude
  plan's terms mean for this (the person's responsibility, linked, not interpreted).

## Scope Boundaries

- Not in scope: continuing existing Claude Code sessions (KD7, its own plan); loki's tools over MCP (KD11);
  `fs/*` and `terminal/*` (KD8); switching engines mid-chat (KD4); images in ACP prompts beyond what the agent's
  `promptCapabilities` allows (sent when allowed, refused with a note when not).
- Not changed: loki-engine chats, pi-durable, the passes' own engine (always loki), the usage page.

## Mechanism

- **The engine flag.** `ChatInfo` (`daemon/kernel/index.ts`) gains `engine: { kind: "acp", agent: string,
  session_id: string | null } | null`; `null` is loki. `chat_model` with an ACP handle (`acp:<agent>/<model>`) sets
  it before the first message and is refused after it for a different engine (KD4). `ChatState` and the desk info
  carry the engine so the app can show it.
- **A seam in `DaemonChats`.** `daemon/chat-backend.ts` routes `send`, `abort`, `model`, `command` and `open` to an
  `AcpChats` (`daemon/acp/`) when the chat's engine is ACP. Everything else (titles, folders, approvals' plumbing,
  the projection) stays shared.
- **The client (`daemon/acp/`).** On `@agentclientprotocol/sdk` (Apache-2.0):
  - `agents.ts`: the configured agents (`~/.loki/state/acp.json`: id, name, command, args, env), with Claude Code
    built in (KD9), and a readiness check (command found; for Claude, `~/.claude` login present).
  - `process.ts`: one process per agent, started on first use, `initialize` with no `fs` or `terminal` capabilities
    (KD8), restarted on exit with backoff; stderr's tail kept for R11 (as `daemon/mcp/servers.ts` does).
  - `session.ts`: `session/new { cwd, mcpServers: [] }` with the agent's memory section and skills appended to the
    system prompt (KD5: `_meta.systemPrompt.append` for the Claude adapter; for an agent without it, sent as a
    context block ahead of the first prompt), `session/prompt`, `session/cancel`, `session/set_mode`, the model
    choice (`session/set_model` or the agent's config option), `session/load` after a restart (R8).
  - `events.ts`: `session/update` to `ChatEvent`s and to transcript entries. Message chunks become `streaming` and
    `step assistant` events; tool calls and their updates become `call` and `result` steps (diff content rendered
    as a unified diff in the result); plan updates become an assistant step with the list; thoughts are dropped, as
    on loki's engine; `available_commands_update` and `current_mode_update` become `device` events.
  - `permissions.ts`: `session/request_permission` goes through `Approvals.ask` unchanged, with the agent's options;
    the answer maps back to the option the person chose.
- **The transcript.** As each turn streams, the client appends `pi.user`, `pi.assistant` and `pi.tool-result`
  entries with pi-ai-shaped messages through a general `AgentStore.appendEntries` (today's `importEntries`,
  generalised), so `ChatProjection` and everything reading it work unchanged (R7). These entries are never sent to a
  model by loki: the engine is fixed (KD4).
- **Usage.** When the agent reports usage for a turn, the client adds it to the chat's `pi.usage` document under
  `acp:<agent>/<model>` in the same commit, which the ledger already follows (R9). It also writes `pi.live`'s run
  state so `busy()`, the Inbox's running dot and `turn_finished` behave as for loki's engine.
- **The app.** `ModelEntry` gains `engine` so the picker can group and lock (KD3, KD4); the mode chip takes its
  modes from the chat's `device` event when the engine is ACP (KD10); the slash palette's advertised commands become
  per chat (R6); the composer shows the engine's name in the model pill ("Claude Code · sonnet").

## Open questions (settled in unit 1)

- Whether the pinned Claude adapter advertises `loadSession` without its experimental v2 flag. If not, unit 1 turns
  on `CLAUDE_AGENT_ACP_EXPERIMENTAL_V2=1` for resume only, or R8 falls back to the "start a new chat" note.
- Whether the adapter reports token usage per turn, and in what shape (R9).
- How the adapter takes an appended system prompt in the pinned version (KD5).

## Units

1. **The client and the engine seam** (`daemon/acp/`, `daemon/chat-backend.ts`, `daemon/kernel/index.ts`, tests):
   the engine flag, the process, sessions, `session/update` to events and entries, permissions through
   `Approvals.ask`, Stop, modes, usage, restart and resume. Tests against `test/fixtures/fake-acp.mjs` (a scripted
   ACP agent, as `fake-mcp.mjs` is for MCP): a turn streams and lands in the projection; a tool call with a diff; a
   permission allowed from an approval; cancel mid-turn; the process dying and restarting; resume after a daemon
   restart; usage landing in the ledger. Then once by hand against the real Claude Code.
2. **The frames and the picker** (`core/frames.ts`, `core/models.ts`, `app/src/chat/`): ACP entries in `chat_models`,
   the engine in `ChatState`, the lock after the first message, the engine in the model pill, the agent's modes in
   the chip, per-chat slash commands. Screenshots in the PR.
3. **Persona and memory** (`daemon/acp/session.ts`, `daemon/memory.ts`, tests): the appended prompt (KD5), checked
   to reach the fake agent; the passes picking up ACP transcripts and skipping agents with no loki model (KD6).
4. **Settings and the docs** (`app/src/settings/`, phone, `docs/manual.md`, `docs/architecture.md`, `glossary.md`):
   the ACP agents page with Claude's status and adding a custom agent (R10); the manual's engines section (R12);
   **Engine** in the glossary; architecture.md names `daemon/acp/`.

## Verification

- Each unit's tests, plus the full checks (format, lint, typecheck, test, test:node, both builds, smoke) on CI's
  toolchain, Windows included. Tests never run the real adapter or touch `~/.claude`; they inject the command, as
  the MCP tests do.
- By hand, with the person's real Claude Code: start a Claude Code chat with an existing agent, ask it to edit a
  file in plan mode then acceptEdits, approve from the phone, stop a turn, restart loki and continue, check the
  Inbox digest, run Reflection on the chat, and check the usage page.
