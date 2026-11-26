---
title: The history tools for chats on an ACP agent
date: 2026-10-31
status: active
---

# History tools on an ACP agent

## Why

Plan 062 gave chats on loki's engine `history_search` and `history_read` and left ACP chats out. An ACP agent (Claude
Code, Cursor) compacts its own context, by its own rules, and loki does not see it happen: no `pi.compaction` entry is
written for an ACP chat. Its context can also go entirely: when the agent no longer has the chat's session, loki
opens a new one and the agent remembers none of the thread. Every turn is still in the chat's own store, as for any
chat, so the same tools can reach it.

## What changes

1. **The same two tools, over loki's MCP server.** `history_search` and `history_read` join the tools loki serves an
   ACP session (`LokiTools`, plan 044) beside memory and schedules. They are `ChatTool`s already, reading the chat
   through its store and the daemon's projection, so nothing about them changes. They only read, so the agent runs
   them without asking (`readOnly()` puts them on Claude Code's allowed list), and the agent names them
   `mcp__loki__history_search` and `mcp__loki__history_read`.
2. **Named in the agent's prompt.** loki cannot tell when an ACP agent compacts, so the `history` section of plan 062
   has nothing to wait for. Instead the prompt loki adds for an ACP agent with its tools (`agentPrompt`) names them in
   one sentence, as it names `suggestion_create`: an agent that loads MCP tools only when it searches for them may
   never read a tool's description.
3. **Background passes stay as they are.** A pass's session is served only its job's tools (plan 061).

## Decisions for review

1. **Always on in ACP chats, not only after a compaction.** There is no signal to wait for; the sentence costs a line
   of the prompt and the tools cost nothing until called.
2. **No change to how the agent compacts.** Claude Code's own compaction and `/compact` are its own (plan 020, KD10).

## Tests

1. The history tools served over loki's MCP server find a turn in the calling chat's store, by the thread's row.
2. They are among the tools the agent runs without asking.
3. The ACP prompt with loki's tools names `history_search`; without them it does not.
