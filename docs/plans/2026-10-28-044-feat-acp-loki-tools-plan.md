---
title: loki's tools in Claude Code chats
date: 2026-10-28
status: active
---

# loki's tools in Claude Code chats

## Why

A chat that runs on Claude Code (plan 020) gets only Claude Code's own tools and MCP servers (KD11). The agent in it
cannot write to its memory, set a schedule, look at the canvas, add a Task or ask a question with loki's card, and the
MCP servers set up in loki's Preferences don't reach it: sessions open with `mcpServers: []`
(`daemon/acp/chats.ts`). This is the largest gap between the two engines. Plan 020 named the way through: a loki MCP
server handed to the ACP agent when its session opens.

## What changes

1. **loki serves its tools over MCP to each chat** (`daemon/acp/loki-tools.ts`). The daemon listens on a free loopback
   port and speaks MCP's Streamable HTTP, stateless, answering each POST with JSON. When an ACP session opens or
   loads, loki passes `{ type: "http", name: "loki", url: …/mcp, headers }`, whose header carries a key made for
   that chat. The key names the agent and the chat, so every call runs as that chat. It is kept in memory only, so it
   is useless once the daemon restarts, and the reloaded session gets a new one. The Claude adapter advertises
   `mcpCapabilities.http` (0.93.0); an agent that does not gets none of this, as today.
2. **Which tools.** Only those Claude Code has no counterpart for:
   1. `memory_read`, `memory_write`, `memory_edit`, `memory_delete`;
   2. `schedule_create`, `schedule_list`, `schedule_delete`;
   3. `user_ask` (the Claude adapter turns Claude Code's own question tool off in a client like loki's);
   4. the mods' tools: `canvas_read`, `canvas_focus`, `task_create`, `task_list`, `task_comment`, `task_close`, and any
      a person's mod registers.

   Their names are point 9's. Left out because Claude Code has its own: `read`, `write`, `edit`, `bash`, `ls`, `find`, `grep`, `image_view`,
   `web_search`, `subagent`, `background_*`, `skill`, and `mcp_search`, whose deferred loading is pi's.
3. **Every MCP server the agent has on reaches its Claude Code chats, and Claude Code connects to it itself.** When a
   session opens, loki passes each server that is on for the agent (Agents › Profile) as its config
   (`McpTools.acpServers`): a local server as its command, by full path, with its arguments and environment; a remote
   one as its URL and headers. `${keychain:…}` values are filled in. Claude Code names its tools as it names any
   server's (`mcp__notion__search`). A local server with its own folder, which ACP has no field for, or whose command or
   secret is missing, is left out with a line in the daemon's log.
4. **A server that signs in with OAuth signs in to Claude Code, once.** loki tells the agent it can show pages
   (`elicitation: { url }`). For a server Claude Code finds needs a sign-in, the Claude adapter asks loki to show the
   sign-in page. loki shows a card in the chat, on the Mac and the phone; allowed, the page opens in this Mac's
   browser, where Claude Code waits for the sign-in to come back. Claude Code keeps the token in its own store and
   refreshes it, so the next chats connect without asking. loki's own sign-in to the same server stays loki's, for its
   own chats.
5. **How a tool runs outside pi-durable** (`daemon/chat-tools.ts`). The kept tools use little of pi's tool API: the
   agent's store to read the chat's and the agent's documents, the chat's id, the call's id, the abort signal and
   streamed output. A `ChatTool` takes those as a `ChatCall`; loki's engine builds one from pi's API (`piTool`), and
   the endpoint from the agent's store and the chat its key names. No pi type is faked.
6. **Approvals stay Claude Code's.** Claude Code asks before an MCP tool as before any other, and that request is
   already loki's approval card (plan 020, KD10). The tools whose kind is read are allowed without asking through the
   adapter's `allowedTools`, as loki's own engine never asks for them outside strict: `memory_read`,
   `schedule_list`, `canvas_read`, `canvas_focus`, `task_list`, `user_ask`, and the memory writes, which loki has always counted as
   reads because each is a commit that can be undone; and a passed server's tools that say they only read, as loki's own connection to it lists them.
7. **The agent's memory is written through the tools.** The prompt stops telling the agent not to change its
   memory files and tells it to change them only with `memory_*`, which commit with the right author as in loki's
   own chats. This undoes plan 020's "read-only memory" in these chats.
8. **Background-task and schedule notices** already reach an ACP chat (`chat.deliver`); nothing changes there.
9. **Every tool name is `<subject>_<verb>`, and saved chats are renamed once.** Claude Code shows loki's tools by name
   (`mcp__loki__…`), which made the uneven ones plain. They follow the shape most already had (`memory_read`,
   `schedule_create`, `background_run`):
   1. `ask_user` → `user_ask`;
   2. `desk_state` → `canvas_read` and `desk_camera` → `canvas_focus`, on the Canvas's name ("desk" left the screen in
      September);
   3. `tasks`, one tool with an `action`, → `task_create`, `task_list`, `task_comment`, `task_close`, one per action as
      memory and schedules have; `task_list` is a read, so it runs without asking;
   4. `view_image`, on loki's own engine, → `image_view`.

   A saved chat keeps every call it made, so each store's calls and results are renamed when it first opens on this
   loki (`daemon/store-tool-names.ts`): the store is copied whole to `stores/backup-tool-names-<date>/` first, the
   rename is one transaction, and `stores/tool-names.json` notes it done. An old `tasks` call becomes its action's tool,
   and its result follows the call. Chats on an ACP agent are left as they are: their steps carry Claude Code's own
   names (`Agent`, `Skill`, `TaskOutput`). The names from October's rename (`AskUserQuestion`, `loki_camera`,
   `loki_task`, `Agent`, `Skill`, `bash_background`, `write_stdin`, `TaskOutput`, `TaskStop`, `Monitor`) are renamed
   the same way, and so is a chat imported from Letta afterwards. With that, the window, the question card and the
   label table drop loki's old names (`bash_background`, `write_stdin`, `ask_user`, `AskUserQuestion` as a question);
   the capitalised names they keep are Claude Code's and Letta Code's own. The "always allow" list carries over as
   before, a split tool's to each of its tools.

## Decisions

Settled with the person on 2026-10-27:

1. The tool list in point 2, `ask_user` included.
2. Every MCP server the agent has on must work in its Claude Code chats (point 3), and Claude Code connects to it
   itself rather than through a relay in loki (the person's choice, after a relay was built and dropped). An OAuth
   server costs one sign-in in Claude Code, besides loki's own (point 4); a local server runs once per Claude Code
   session, beside loki's own copy, which costs memory for each open Claude Code chat.
3. The agent writes its memory in Claude Code chats (point 7), undoing plan 020's read-only memory there, on purpose.
4. Read-only tools run without a card (point 6), and so do the memory writes and `ask_user`, as in loki's own chats.
5. The endpoint is built on `@modelcontextprotocol/server` 2.2.0, the server half of the client loki already pins.
   It adds only `@modelcontextprotocol/core` and zod, which loki already has, and runs stateless: each POST is
   answered with JSON, with no session ids or server-sent stream to keep.

Settled on 2026-10-28:

6. The names in point 9, in this plan rather than its own.
7. Saved chats are migrated, not read under both names: this replaces docs/style.md's rule that code reading old chats
   knows both names, for October's renames too. pi-durable has no way to change a saved entry, so loki writes the
   store's rows itself, as plan 032 did for pictures, after a whole copy. On this Mac that is about 5,000 calls and
   results across three stores, almost all from October's rename.
8. Letta's importer and the readers of Letta's shapes go in a plan of their own, next; this one only makes the importer
   write the names now.

## Tests

1. The endpoint (`test/acp-loki-tools.test.ts`, through the MCP client over HTTP): loki's tools run as the chat the
   key names; a request without the key is refused; the read-only tools are named as the agent names them.
2. The configs (`test/mcp.test.ts`): each server the agent has on is passed as itself with its secrets filled in; one
   switched off, in its own folder or not found is left out and said so; its read-only tools are named for the agent.
3. A session opened against `test/fixtures/fake-acp.mjs` receives the servers and the allowed tools, and its prompt
   says the memory changes through loki's tools; an agent without `mcpCapabilities.http` gets none, and its prompt keeps
   the memory read-only; a sign-in page the agent asks for is a card first and opens only when allowed
   (`test/acp-chats.test.ts`, `test/acp-prompt.test.ts`).
4. The memory, schedule and mod tool tests pass unchanged on loki's engine after the move to `ChatTool`.
5. The names (`test/tool-names.test.ts`): a call takes its name now, a split tool's by its action; a result follows its
   call; the "always allow" list carries over; a chat imported from Letta comes in under the names now. Every name is
   `<subject>_<verb>` or one word (`test/tools.test.ts`, `test/extensions.test.ts`).
6. The store (`test-node/store-tool-names.node-test.ts`): calls and results are renamed after a whole copy, a chat on
   an ACP agent and a current name are left, and a second pass finds nothing; through the daemon's store manager, a
   store is renamed once as it opens, and a new store is noted done.
7. On a copy of this Mac's real stores: the migration's counts, a Claude Code chat untouched, and the chats still
   open and fold.
8. By hand, with the person's Claude Code: in a Claude Code chat, ask the agent to remember something, to schedule a
   message, to look at the canvas, to add a Task and to search Notion; sign in to Notion from the card once, and check
   that a second chat does not ask again.

## Not in this plan

1. Moving a Claude Code chat to another Mac (its session stays where it is).
2. Retrying a scheduled message after a failed Claude Code turn, and running the mods' message rewrites before
   sending.
3. ACP agents other than Claude Code are handed the same servers when they support HTTP MCP, but are not tested by
   hand.
4. A server's read-only tools are listed from loki's own connection when the session opens; one that connects later
   asks before its reads until the next session.
5. Removing Letta's importer, its log reader and the readers of its shapes (questions' `multiSelect`, attachment tags,
   notices): the next plan.
