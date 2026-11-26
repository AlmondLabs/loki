---
title: Scripts for every agent - Plan
type: feat
date: 2026-11-14
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Scripts for every agent - Plan

Plan 099 · follows plan 2026-11-11-1011 (scripts and the Google tools), plan 094 (fewer tools) and plan 097 (account
operations through scripts)

---

## Goal Capsule

- **Objective:** every agent's chats can run scripts, and eight of loki's own tools leave the model's list for them:
  `history_search`, `history_read`, `schedule_create`, `schedule_list`, `schedule_delete`, `canvas_read`,
  `canvas_focus` and `chat_list`. The model is offered fewer tools, and no agent's prompt costs more than it does
  today.
- **Means:** the rule that offers the script tool only to an agent with a script-only mod tool goes. The eight tools
  become script-only, in four namespaces. What only those tools' descriptions taught (how to make a widget) moves to a
  prompt section. The script tool's own description is shortened. The prompt measurement is fixed first, so every
  figure in this plan is measured once and honestly.
- **Authority:** this plan's Requirements, then its KTDs. The person chose scripts for every agent on 2026-11-13 and
  chose the eight tools, the trim, the script cap and the prompt pin on 2026-11-14.
- **Stop conditions:** stop and ask if the fixed measurement (U1) shows any kind of agent paying more after U4 than
  before U2; if a shortened script description makes a script test fail for want of something the old text said
  (U4); or if helpers turn out to need the moved tools (KTD7). Do not choose a fallback alone.
- **Execution profile:** one branch, one PR. The person raises and merges it.

---

## Product Contract

### Summary

Every chat on loki's engine has `codemode`, and every Claude Code or other ACP chat has loki's `script` tool. An agent
reads its history, lists or changes its schedules, reads the canvas, moves the person's view and lists chats from a
script. A script that only reads runs without a card in standard mode; one that creates or deletes a schedule asks
once, as any script does at its first change. What the person sees on the canvas, in schedules and in a compacted
chat is unchanged.

### Problem Frame

The model is offered 24 tools in every chat, about 4,000 tokens a turn. Eight of them are rarely used and need no
turn of their own: they read, or make one small change. They stay in the model's list because only agents that own an
account have scripts (plan 2026-11-11-1011, R1). An agent without an account would have paid for the script tool and
gained nothing to call from a script. Once loki's own tools are script-only, every agent has something to call, and the
reason for that rule is gone.

The figures that rule was weighed with were also wrong. `test/scripts-prompt.test.ts` counts the messages a model
request carries and the tool list separately, but the leading system message carries the tool list too
(`toolsAdded`), so each tool definition is counted twice. The script tool's real cost per turn is about 440 tokens
(409 its definition, about 33 its section), not 929. Plan 097's R7 figures are inflated the same way.

### Requirements

- R1. **Every agent has scripts.** `codemode` is offered in every chat on loki's engine that does not name its tools
  outright. loki's MCP endpoint serves `script` to every ACP chat. Background passes with fixed tool lists, and helpers
  (KTD7), are unchanged.
- R2. **Eight tools become script-only** (`callers: ["tools"]`), on loki's engine and in ACP chats: `history_search`,
  `history_read`, `schedule_create`, `schedule_list`, `schedule_delete`, `canvas_read`, `canvas_focus` and
  `chat_list`. Their behaviour, kinds and arguments are unchanged. Old chats show their calls as they were (plan 094,
  R6).
- R3. **Four namespaces name them** in the script section, one short line each: `history`, `schedule`, `canvas` and
  `chat`.
- R4. **How to make a widget stays in front of every agent.** The widget-file instructions now in `canvas_read`'s
  description (the folder, the kit types, the `.tsx` shape) become a `canvas` prompt section, which also reaches ACP
  chats.
- R5. **Words that name the moved tools follow them.** The history section (shown after a compaction), the prompt for
  ACP chats, the canvas activity note ("call canvas_read for the full picture"), `chat_message`'s and
  `suggestion_create`'s descriptions where they point at `chat_list`, and `docs/manual.md`.
- R6. **The script tool's description is shorter.** loki writes its own, keeping what a script needs to run correctly.
- R7. **The prompt is measured once and pinned so no agent pays more.** `test/scripts-prompt.test.ts` counts the system
  prompt's text and each tool definition once. It pins three kinds of agent (no account, a Google owner, a Slack
  owner), each at or below what it pays before this plan, measured with the fixed method in U1.
  - Measured on 2026-11-14, in tokens a turn (the system prompt and each tool definition, counted once): an agent with
    no account went from 3,927 to 3,421, a Google owner from 4,533 to 3,584, and a Slack owner from 4,486 to 3,537.
    The test pins both: below the first figure, and at most 50 over the second.
- R8. **The script cap stays at four.** A script refused because four are running is logged, with how many were
  running, so the cap can be judged with data later.

### Scope Boundaries

- Not in scope: the memory tools (reflection and the doctor run with them alone), `web_search` (used often),
  `background_watch` (it pairs with `background_run`), MCP servers (a plan of their own), and `SCRIPTS_AT_ONCE`.
- No tool is renamed, and none changes what it does.
- `suggestion_create`, `chat_message`, `reply_propose` and `user_ask` stay direct tools: each card is the person's.

---

## Planning Contract

### Key Technical Decisions

- **KTD1. The hide rule goes.** `ModRegistry.prepare` stops hiding `SCRIPT_TOOL` when no mod tool is script-only. A
  chat that names its tools outright is still left alone, and the script section still renders only where the tool is
  offered (`daemon/scripts.ts`). In `daemon/acp/loki-tools.ts` the `script` tool is served whenever the chat's tools
  include a script-only one, which is now every chat.
- **KTD2. `callers` on loki's own tools.** History and schedule tools are `ChatTool`s, which already carry `callers`
  into pi-durable (`piTool`). `canvas_read`, `canvas_focus` and `chat_list` are `LokiTool`s; `LokiTool` gains
  `callers`, and `toolRegistrar` passes it on. Scripts' allowlist (`scriptMayCall`) needs nothing more.
- **KTD3. Four namespaces, by prefix** (`SCRIPT_NAMESPACES`): `history_`, `schedule_`, `canvas_` and `chat_`.
  `chat_message` shares the `chat_` prefix but is not script-only, so scripts never see it; the namespace's line says
  it lists agents and chats. Each line stays under about 15 tokens.
- **KTD4. `canvas_read` answers an object to scripts.** It already answers JSON text. It gains
  `outputSchema: { type: "object" }`, so a script reads its fields without `JSON.parse` (the mod registry already
  parses a typed tool's text). The others answer text, as now.
- **KTD5. The canvas section.** A mod prompt section in `mod/tools.ts`, holding the widget-file text that
  `canvas_read`'s description held, and nothing else. A mod section reaches ACP chats too (plan 2026-11-11-1011, fact
  4), which is wanted here: every chat has a canvas.
- **KTD6. loki's own script description.** `loki.scripts` already wraps the script tool; it replaces the description
  as well. It keeps: what a script is and its sandbox; `await tools.<name>(args)` and what it resolves to; `return`
  and `console.log`; `searchTools()` and `describeTool()`; `store`/`load`; the options line. It drops the output
  formatting details, `image()`, `ALL_TOOLS` and `describeNamespace()`, which the model never needs to be told before
  it uses them. Target: at most 250 tokens, measured. The functions stay available; only the text is shorter.
- **KTD7. Helpers keep dropping scripts.** A helper (`daemon/subagents.ts`) runs without the script extensions, so it
  loses the eight tools. A helper is a short task in the parent's folder; its own history is short, and the canvas,
  schedules and other chats are the parent's to handle. Raised for review; the person may reverse it.
- **KTD8. The measurement.** The test builds the request as now, and counts the leading system message's text (its
  content and sections) and the tool definitions once each, from `getCurrentTools`, not from the messages' JSON.
  Before any other unit, it records today's figures for the three kinds of agent; those become the pins.
- **KTD9. Asking is plan 097's.** `schedule_create` and `schedule_delete` are commands, so a script that calls one asks
  once, at that call, outside strict mode. `chat_list` stays in `NEVER_ASK`. Nothing in `daemon/approvals.ts`
  changes.
- **KTD10. Fencing is unchanged.** None of the eight tools is marked `strangerText`. `history_read` can return an
  earlier tool's output, which may hold a stranger's text; it does so unfenced today too, and an account read in that
  history was fenced when it was first read.

### Units

- **U1. Measure honestly.** Fix `test/scripts-prompt.test.ts` (KTD8). Record, before anything else changes, what each of
  the three kinds of agent pays per turn on main; write the figures into the test and this plan. Correct the figures
  in `daemon/scripts.ts`'s `SCRIPT_LISTING_TOKENS` comment and add a line to plan 097 saying its R7 figures counted
  tools twice.
- **U2. Script-only tools.** `callers` on the eight tools (KTD2), the four namespaces (KTD3), `canvas_read`'s
  `outputSchema` (KTD4). Tests: `test/extensions.test.ts`'s script-only list; the eight are absent from the model's list
  and present to a script; a script reads `canvas_read`'s fields; the ACP listing serves none of the eight directly.
- **U3. Scripts for every agent.** Remove the hide rule (KTD1). The history section shows where the script tool is
  offered and the chat was compacted, and says to read history with a script. The canvas section (KTD5). The ACP
  prompt's line about loki's tools, the canvas activity note, and the descriptions that name `chat_list` (R5). Tests:
  an agent with no account has `codemode` and the four namespaces; a chat with a fixed tool list has neither; the
  history section's condition; the canvas section reaches an ACP prompt.
- **U4. A shorter script description** (KTD6). Tests: the description stays under its target; `test/scripts.test.ts`
  passes unchanged.
- **U5. Refusals logged** (R8). Tests: a fifth script is refused, as now, and the refusal is logged once.
- **U6. Pins and words.** The three pins (R7), measured after U2-U4. `docs/manual.md` (Scripts, the canvas, history,
  schedules), `glossary.md` (Script-only tool), `docs/architecture.md`, and `docs/SECURITY.md` (Scripts: a schedule
  change now asks once per script).

- **Found by hand, fixed here.** `scopeForCall` (`mod/tools.ts`) turned a chat's id into its desk without the calling
  agent, so `canvas_read` in an agent's main chat (id `default`) answered for a desk named `default`, not
  `default-<agent>`, and the agent wrote its widget there. Present before this plan for the model's own `canvas_read`
  too; the call now passes its agent.

### Verification

- Every check in AGENTS.md, with CI's toolchain.
- By hand, in a standard-mode chat of an agent that owns no account:
  1. Ask what is on the canvas, then to show one widget. Both run as scripts, with no card, and the view moves.
  2. Ask to schedule a daily reminder, then to cancel it. Each asks once.
  3. In a compacted chat, ask about something from before the compaction. The agent searches its history with a
     script.
  4. In a Claude Code chat on the same agent, ask what is on the canvas. It runs through loki's `script` tool.
