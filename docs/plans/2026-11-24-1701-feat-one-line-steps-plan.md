---
title: One line for every step - Plan
type: feat
date: 2026-11-24
topic: one-line-steps
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# One line for every step - Plan

## Goal Capsule

- **Objective:** a turn's steps list reads as one line per step on desktop, whatever tool the agent called, so a long
  turn fits on the screen and scans top to bottom.
- **Means:** one shared rule in `app/src/shared/tool-steps.ts` turns any step row into a single line: an icon, a title
  that truncates, and a one-word tag on the right. Every tool name the app can meet gets an entry in one table (KTD1).
  Paths shrink to their file name (KTD3). Unknown tools get a readable title from their name (KTD4). ACP agents' own
  kind of call picks their icon and tag (KTD5).
- **Product authority:** the owner, in the quick-fixes session of 2026-11-24, looking at a Work view where most steps
  took two lines ("Fix the read-only forecast helper…" over "Asked an agent", a `/tmp/…` path over "Used read").
- **Stop conditions:** stop and ask if one line can't keep a step's failed or waiting ending visible at the narrowest
  chat width, or if a tag word collides with a word `test/words.test.ts` refuses.
- **Execution profile:** `app/src/shared/tool-steps.ts`, `app/src/item/work.tsx`,
  `app/src/shared/icons.tsx`, `app/src/chat/tool-steps.tsx`, `app/src/chat/chat.css`; `core/harness.ts`
  and `daemon/acp/chats.ts` for the ACP kind; tests; `docs/manual.md`. Branch `feat/one-line-steps`, commit scope `chat`.
- **Open blockers:** none.

---

## Product Contract

### Summary

Each step in a turn's Work view is one line: the kind of step as an icon, what the step was about as its title, and a
muted one-word tag on the right that says what was done ("Ran", "Read", "Edited", "Agent"). A file step shows the file's
name, not its path. A tool loki doesn't know shows its name as words ("Advisor consult"), not "Used advisor_consult".
Hovering a step shows its whole title and path; opening it shows everything, as today.

### Problem Frame

The desktop Work view draws a step through `ChainOfThoughtStep`, which puts `description` on a line of its own.
`Step` in `app/src/item/work.tsx` passes the verb there whenever the step has a target, so every step with a target is
two lines: the target, then "Ran", "Asked an agent" or "Updated memory" under it. Steps without a target are one line
but read badly: the label falls back to "Used " plus the raw tool name ("Used advisor_consult"). The daemon's own file
tool is called `read`, lowercase, and `stepVerb` only knows `Read`, so a file read shows as "Used read" with the generic
tool icon. File titles are whole absolute paths (`/tmp/crm-activation-planning-nov24/test_seed_…`), cut off before the
file name. ACP agents name a call by its title and loki drops the ACP `kind` (read, edit, execute, search, fetch, think),
so most Claude Code and Codex steps get the generic icon. The desktop chat's own step list (`StepsList` in
`app/src/chat/tool-steps.tsx`) also stacks its verb and target in a two-row grid (`.loki-steps-text`).

### Requirements

**One line**

- R1. Every step in the desktop Work view (`app/src/item/work.tsx`) and the desktop step list
  (`app/src/chat/tool-steps.tsx`) is one line high when closed: icon, title, tag.
- R2. The title truncates first. The tag, and a "failed" or "waiting on you" ending, stay visible at the narrowest chat
  width.
- R3. Thoughts, the plan line and the collapsed summary line keep their look, one line each.
- R3a. On desktop, a closed stretch shows only its summary line, which counts failed steps ("· 1 failed"); the line
  naming the last failed step under it goes, in the Work view and the desktop step list. The phone keeps it.

**What each line says**

- R4. Every tool name in the Tool Catalogue below gets the title, tag and icon given there.
- R5. A tool not in the catalogue gets its name as words, its first letter capitalised and `_` as spaces, with the tag
  "Tool". An MCP tool (`mcp__<server>__<tool>`) gets its tool name as words and its server name as the tag.
- R6. A step whose agent gave a description (`ToolStep.description`) is titled by it, whatever the tool, as today.
- R7. A title that is a file path shows the file's name. When two steps in the same stretch would show the same name,
  both show the last folder too (`farmart/shared-customer-crm.md`).
- R8. An ACP step whose title already reads as words keeps it. Its icon and tag come from the ACP `kind` of the call.
- R9. A failed step's tag reads "Failed" in the negative colour, in place of its usual tag.

**Nothing lost**

- R10. Hovering a step shows its whole title, with the whole path for a file step.
- R11. Opening a step shows what it shows today: description, command or input, output.
- R12. Screen readers hear the title then the tag, in one phrase ("shared-customer-crm.md, Memory").

### Tool Catalogue

The tag is one word, title case as a label per `docs/style.md`. "Title" says where the line's title comes from when
the step has no description (R6 always wins).

| Tools | Icon | Title | Tag |
|---|---|---|---|
| `bash`, `Bash`, `Shell`, `shell`, `local_shell`, `exec_command`, `run_command`, `execute_command` | terminal | trimmed command (core's `shellTitle`) | Ran |
| `background_run` | terminal | trimmed command | Started |
| `background_watch`, `Monitor`, `TaskOutput`, `BashOutput` | terminal | its description, else "A command" | Waited |
| `TaskStop` | terminal | its description, else "A command" | Stopped |
| background task notice (event) | list | its summary | Finished |
| `read`, `Read` | file | file name | Read |
| `write`, `Write` | file | file name | Wrote |
| `edit`, `Edit`, `MultiEdit`, `NotebookEdit` | pencil | file name | Edited |
| `apply_patch`, `ApplyPatch`, `memory_apply_patch` | pencil | the first file the patch names | Edited |
| `memory_read` | file | memory file name | Memory |
| `memory_write`, `memory_edit`, `memory_delete`, `memory_apply_patch`, `memory` | pencil | memory file name | Memory |
| `ls` | search | the folder's name | Listed |
| `find`, `Glob` | search | the pattern | Found |
| `grep`, `Grep` | search | the pattern, "in <folder>" when given | Searched |
| `web_search`, `WebSearch` | globe | the query | Web |
| `WebFetch` | globe | host and path, no scheme | Fetched |
| `subagent`, `Task`, `Agent` | bot | the description, else the prompt's first line | Agent |
| `SendAgentMessage` | bot | the message's first line | Agent |
| `advisor_consult` | bot | its `text`'s first line, else "Review the changes" | Advisor |
| `user_ask`, `AskUserQuestion` | message | the first question | Asked you |
| `codemode` | code | the `// @description:` line, else "A script" | Script |
| `skill`, `Skill`, skill loaded (event) | sparkles | the skill's name | Skill |
| `suggestion_create` | lightbulb | the suggestion's title | Suggested |
| `chat_message` | message | the message's first line | Message |
| `reply_propose`, `message_propose` | message | the draft's first line | Draft |
| `ticket_propose` | ticket | the ticket's title | Ticket |
| `mcp_search` | wrench | the query | Tools |
| `plan`, `TodoWrite`, `UpdatePlan`, `update_plan` | list | drawn as the plan line, unchanged (R3) | — |
| `mcp__<server>__<tool>` | wrench | the tool name as words | the server's name |
| any other name | wrench | the name as words | Tool |

ACP calls (R8), by their `kind`: `read` file / Read, `edit` pencil / Edited, `delete` pencil / Deleted, `move` pencil /
Moved, `execute` terminal / Ran, `search` search / Searched, `fetch` globe / Fetched, `think` brain / Thought, `other`
wrench / Tool.

### Key Decisions

- **The tag is one word on the right, not a second line and not a lead verb.** (session-settled: user-directed — chosen
  over the verb on its own line, today's layout, and over the verb in front of the title: the title says what the step
  was about and should be read first, and a fixed-width word on the right lines up down the list.) Governs R1, R2.
- **One table owns every tool's icon, tag and title rule.** Today `stepVerb`, `stepIcon`, `stepKind` and the `ICON` map
  in `work.tsx` each keep their own `switch` or `Set`, and they disagree (`read` is a file step in none of them).
  Governs R4.
- **No failed step named under a closed stretch on desktop.** (session-settled: user-directed — chosen over keeping the
  "✕ <step> failed" line under the summary: the summary already counts failures, and the open list marks each one.)
  Governs R3a.
- **Desktop only; the phone sheet keeps its two lines.** The phone's steps sheet was designed as kind over purpose on
  two lines, with 20px icons sized for a finger (`docs/manual.md`, the phone screenshot). It takes the catalogue's words
  and stays two lines. (session-settled: user-directed — chosen over one line on the phone too.) Governs U6.

### Scope Boundaries

- Titles from the model (the `description` field, plan 2026-11-23 step descriptions) are not changed; this plan only
  draws them.
- The opened view of a step (`StepOpened`, `StepDetail`) is not redesigned; it gains no fields and loses none.
- Considered, not built: grouping runs of the same tool ("Read 6 files"). It hides which files, and the one-line list
  already fits about twice as many steps.
- Considered, not built: relative paths from the chat's folder. The file name alone is shorter, and R7 covers clashes.

### Sources / Research

- `ChainOfThoughtStep` draws `description` as its own block under the label (`app/src/ui/ai-elements/chain-of-thought.tsx`);
  `Step` passes `description={target ? verb : undefined}` (`app/src/item/work.tsx`).
- `stepVerb`'s default returns `Used ${name}` for any name without a space (`app/src/shared/tool-steps.ts`); the daemon's
  file tools are `read`, `write`, `edit`, `ls`, `find`, `grep` (`daemon/tools.ts`, pi's coding tools).
- `StepText` renders verb and target as two grid rows (`.loki-steps-text { display: grid }`, `app/src/chat/chat.css`).
- ACP `tool_call` updates keep `u.title` as the row's name and drop `u.kind` (`daemon/acp/chats.ts`).
- `toolLabel` and `toolStep` build a row's title source in core, and rows are rebuilt on every load
  (`core/harness.ts`, `core/attention/thread.ts`), so a new `kind` field reaches old ACP chats only where the stored
  call kept it.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **`stepLines(rows)` returns each row's `{ title, tag, icon, full }`; `stepLine(row)` is one row's.** It reads one
  catalogue table keyed by tool name (with the shell names and the MCP prefix handled as rules), so the Work view, the
  desktop step list and the phone use one source. `stepVerb`, `stepIcon` and `stepKind` stay as thin readers of the
  same table for the summary line and filters, so their callers don't move in this change.
- KTD2. **The tag sits inside the step's button, after the title.** The button is a one-row flex: the title in its
  own truncating span, the tag `shrink-0` and `ml-auto`, so the title gives way first. `ChainOfThoughtStep` is not
  changed; its `description` line is simply no longer used by steps. The button's `aria-label` is "<full>, <tag>".
- KTD3. **Path shortening happens in the app, at draw time.** `stepTarget` keeps returning the full path, used by
  hover and the opened view. `stepLines` gives each path its file name, and the last folder only for names that
  clash in that list. It uses `/` and `\` both, so Windows paths shorten too.
- KTD4. **Unknown names read as words.** `nameAsWords("advisor_consult")` is "Advisor consult"; an MCP name drops its
  prefix and server, and the server becomes the tag. A name that already has a space (an ACP title) is left as it is.
- KTD5. **The ACP kind is kept on the call.** `daemon/acp/chats.ts` keeps `u.kind` on the call and writes it as
  `tool_kind` on the live call frame and on the stored `toolCall` block, outside the arguments, so the opened step's
  input is unchanged. Core's `Step` call variant carries `tool_kind`, `pi-steps.ts` reads it back from storage, and
  `toolStep` copies it to a new optional `ToolStep.acp_kind`. Doc comments on both fields state them, since steps cross
  to the phone. ACP rows stored before this change have none and fall back to R5.
- KTD6. **Failed and waiting replace the tag.** A failed step's tag is "Failed" in `text-loki-negative`; a step
  waiting on the person shows "Waiting" in `text-loki-attention`. The " · failed" text after the title goes, so the
  line has one place for its state.
- KTD7. **Core titles the tools whose few words live in their own argument.** `toolLabel` falls back, after the usual
  keys, to `text` (`advisor_consult`, `chat_message`, `reply_propose`), `title` (`suggestion_create`), `subject` then
  `text` (`message_propose`), `message` (`SendAgentMessage`), and the first file a patch names. Rows are rebuilt on
  load, so old chats get these titles too.

### Sequencing

U1 first. U2, U3, U4 and U6 follow U1, in any order. U5 comes last.

---

## Implementation Units

### U1. One catalogue and `stepLine`

- **Goal:** one table and one function give any row its icon, title, tag and full text.
- **Requirements:** R4, R5, R6, R7, R9, R10. KTD1, KTD3, KTD4, KTD6.
- **Dependencies:** none.
- **Files:** `app/src/shared/tool-steps.ts`; `app/src/shared/icons.tsx` (globe, bot, code, wrench, question, brain,
  checklist); `core/harness.ts` (KTD7); `test/tool-steps.test.ts`.
- **Approach:**
  1. Write the Tool Catalogue as a table, with rules for shell names, MCP names and unknown names.
  2. `stepLine` picks the title: description, else the catalogue's title rule, else the name as words.
  3. `shortPaths` shortens file titles across a stretch.
  4. Rebuild `stepVerb`, `stepIcon` and `stepKind` on the table; `read`, `write`, `edit` count as file steps.
- **Test scenarios:**
  - Each row of the catalogue gives its icon, title and tag, one assertion per tool name.
  - `read` with `path: "/tmp/crm/test_seed.py"` gives title `test_seed.py`, tag "Read", icon file, full the whole path.
  - Two `memory_edit` steps on `a/x.md` and `b/x.md` give `a/x.md` and `b/x.md`; one alone gives `x.md`.
  - `C:\\work\\loki\\notes.md` gives `notes.md`.
  - `advisor_consult` with `{ question: "Is this safe?\nmore" }` gives title "Is this safe?", tag "Advisor".
  - `advisor_consult` with no arguments gives title "Advisor consult".
  - `mcp__github__list_pull_requests` gives title "List pull requests", tag "Github".
  - `frobnicate_widget` gives title "Frobnicate widget", tag "Tool".
  - An ACP row named "Read signups.csv" with `acp_kind: "read"` keeps the title and gets tag "Read", icon file.
  - A `bash` step with description "Run the CRM tests" is titled by it.
  - A failed step's tag is "Failed".
  - `workSummary` output is unchanged for the existing cases.
- **Verification:** the test file covers every catalogue row.

### U2. The Work view draws one line

- **Goal:** `Step` in `app/src/item/work.tsx` draws icon, title and tag on one line.
- **Requirements:** R1, R2, R3, R3a, R9, R10, R12. KTD2, KTD6.
- **Dependencies:** U1.
- **Files:** `app/src/item/work.tsx`; `test/item-work.test.ts`.
- **Approach:**
  1. `Work` builds `stepLines` for the stretch and passes each `Step` its line.
  2. `Step` reads `stepLine` for the icon, title, tag and `title` attribute; it stops passing `description`.
  3. The running shimmer and the waiting state keep the title truncating, with the state in the tag.
  4. The trailing " · failed" span goes; the tag carries it.
- **Test scenarios:**
  - A `read` step renders its file name, the tag "Read" and the full path in the `title` attribute, and no second line.
  - A failed step renders the tag "Failed" and no " · failed" text.
  - A running step renders its title inside the shimmer and still has a tag.
  - A waiting step renders "Waiting".
  - The step's accessible name is "<title>, <tag>".
- **Verification:** the screenshot's turn shows one line per step at the narrowest chat width.

### U3. The desktop step list draws one line

- **Goal:** `StepsList` in `app/src/chat/tool-steps.tsx` matches the Work view.
- **Requirements:** R1, R2, R9, R10.
- **Dependencies:** U1.
- **Files:** `app/src/chat/tool-steps.tsx`; `app/src/chat/chat.css`; `test/tool-steps.test.ts` or a render test beside it.
- **Approach:** `StepText` gets a one-line mode (title truncating, tag right) used by `StepsList`; the phone sheet keeps
  the two-row mode until U6. Styles stay on the scales in `docs/design.md`.
- **Test scenarios:** a rendered list row has one text row with the title and tag; a failed row shows "Failed".
- **Verification:** `test/tokens.test.ts` passes, and the chat's step list matches the Work view by eye.

### U4. ACP steps keep their kind

- **Goal:** Claude Code, Codex and other ACP steps get icons and tags from the ACP `kind`.
- **Requirements:** R8. KTD5.
- **Dependencies:** U1.
- **Files:** `daemon/acp/chats.ts`; `core/harness.ts`; `core/attention/transcript.ts`; `core/attention/thread.ts`;
  `core/attention/pi-steps.ts`; `test/acp-chats.test.ts`.
- **Approach:** store `u.kind` with the call; `toolStep` copies it to `ToolStep.acp_kind`; the field is optional and its
  doc comment says what sends it.
- **Test scenarios:**
  - A fake ACP `tool_call` with `kind: "edit"` and title "Edit notes.md" gives a step with `acp_kind: "edit"`.
  - A stored ACP call without a kind gives a step without one.
- **Verification:** a Claude Code chat's steps show file, pencil and terminal icons with matching tags.

### U5. The manual

- **Goal:** the manual describes one-line steps.
- **Requirements:** R1, R4, R7, R10.
- **Dependencies:** U2–U4.
- **Files:** `docs/manual.md` (the desktop thread's steps paragraph; the phone paragraph only if U6 lands).
- **Approach:** say what a step line holds and that hovering shows the whole path, in the manual's voice.
- **Test expectation:** none -- documentation only.
- **Verification:** the manual matches the built behaviour.

### U6. The phone sheet takes the same words

- **Goal:** the phone sheet's rows read from the same table and keep their two lines: the verb over the title.
- **Requirements:** R4, R7 on the phone.
- **Dependencies:** U1.
- **Files:** `app/src/chat/tool-steps.tsx` (`StepsSheet`, the two-row `StepText`).
- **Approach:** the sheet's first line is the catalogue's verb ("Read memory", "Asked the advisor"), which says more than the
  one-word tag on a line of its own; its second line is the title from `stepLines`; layout and `app/src/phone/phone.css`
  unchanged.
- **Test scenarios:** `stepVerb` gives the catalogue's verb for `read` and `advisor_consult`; `stepLines` gives their titles.
- **Verification:** the phone, rebuilt with `npm run build:app`, shows the new words on the same two lines.

---

## Verification Contract

| Gate | Command or check | Applies to |
|---|---|---|
| Format, lint, types | `bun run format:check && bun run lint && bun run typecheck` | all units |
| Tests | `bun run test && bun run test:node` | U1–U4, U6 |
| Builds and smoke | `bun run build:app && bun run build:mod && bun run smoke` | all units |
| CI toolchain | Newest Node 22, the bun in `package.json`'s `packageManager`, `SHELL=/bin/bash` | before push |
| By hand | A native turn with `bash`, `read`, `memory_edit`, `subagent`, `advisor_consult`, a script and an MCP call, and a Claude Code turn with Read, Edit, Bash and Grep: each step one line at the narrowest chat width, the tag visible, hover shows the path | U2–U4 |
| PR title | `PR_TITLE="feat(chat): one line for every step" node --experimental-strip-types scripts/check-pr-title.ts` | the PR |

---

## Definition of Done

- Every requirement R1–R12 has a passing test or a by-hand check from the Verification Contract.
- All checks pass with CI's toolchain, and the PR's CI, Windows included, is green.
- Screenshots of the Work view before and after, from a demo daemon, in the PR.
- No comment outside the kinds AGENTS.md allows.
- This plan ships in the PR that builds it.
