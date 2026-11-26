---
title: Remove migrations a release has shipped - Plan
type: refactor
date: 2026-11-20
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Remove migrations a release has shipped - Plan

---

## Goal Capsule

- **Objective:** loki's code reads and writes only the shapes it saves today. Every one-time migration, and every branch kept for a Mac on an older build, is gone, and nobody on a 1116 or later build loses a chat, setting, approval, suggestion, pairing or memory file.
- **Means:** delete each migration that v2026.1116.0 already ran on every paired Mac, with the tests that exist only for it, and the docs that name it (KTD1). One pull request, one commit per unit (KTD6).
- **Authority:** the owner confirmed on 2026-11-20 that every paired Mac runs 1116 or later and asked for this plan. AlmondLabs/loki#184 kept these until a release shipped them. AGENTS.md and `docs/style.md` govern code style.
- **Stop conditions:** stop and ask if a candidate still does live work for data a 1116 build writes, if a pre-merge check on a paired Mac (R9) finds data still in an old shape, or if a removal would change what a person sees, saves or sends.
- **Execution profile:** deletions that keep behaviour. Existing tests pass, except the ones each unit names for deletion or edit.
- **Finishes and ships:** an agent through `ce-work`; one pull request, opened when the owner asks.

---

## Product Contract

### Summary

Delete the store, Letta, pass-file, Tasks and field-name migrations, the tool-name rename tables, and the old peer-protocol branches that #184 kept, now that v2026.1116.0 has run them on every paired Mac. The docs that describe them say what loki does instead.

### Problem Frame

loki changed what it saves several times in October 2026: snake_case field names, new tool names, chats moved off Letta, Tasks folded into suggestions, background passes into one state file, and the protocol between paired Macs. Each change shipped with code that rewrites old data once, or accepts an older peer's frames. #184 cut most dead code on 2026-11-02 but kept about 800 lines of these, because no release had shipped the newer ones yet. v2026.1116.0 (2026-11-16) now contains all of them, and the owner confirmed every paired Mac runs it. The code still runs on every start, still costs a reader the time to understand it, and `docs/style.md` still points new work at helpers that only exist for the past.

### Requirements

**Behaviour that stays**

- R1. A chat, its history, its "always allow" list, its widget log, its pins and its suggestions read as they do today on any Mac whose data a 1116 or later build has opened.
- R2. Pairing, chat moves, peer state and suggestions between two Macs on this build work as they do today.
- R3. Background passes keep their settings and cursors; agent records, memory and Learn's recall files keep their contents.
- R4. Where a migration's code also does live work for today's data, the live part stays (KTD2).

**What goes**

- R5. The store entries' rewrite (`daemon/store-migration.ts`) and the tool-name rename tables in `daemon/tool-kinds.ts`.
- R6. The Letta agent migration (`daemon/agent-migration.ts`) and the carry-over from the old background-pass files (`state/reflection.json`, `reflection/`, `recall/worker.json`).
- R7. The Tasks-to-suggestions move (`mod/task-migration.ts`), its peering step, and the `suggestion_add` frame that only it sent.
- R8. `core/snake-keys.ts` and every `migrateKeys` read; the old peer-protocol branches (U6).

**Proof**

- R9. Before merge, each paired Mac is checked for data still in an old shape (KTD5). Any found stops the merge.
- R10. `docs/manual.md`, `docs/architecture.md` and `docs/style.md` lose every mention of the removed code, and `docs/style.md` says how a future rename of saved data ships (KTD4).

### Scope Boundaries

- Files the migrations left on disk stay: `stores/migrations.json`, `state/migrations.json` (its `agents` and `tasks_moved` keys), `stores/backup-*` folders, `state/reflection.json`, `reflection/`, `recall/worker.json`, `~/.loki/tasks`. loki never reads them again; deleting a person's files is not needed for this work.
- pi-durable's own schema migration and its copy before it (`backupBeforeMigration`, `daemon/store-backup.ts`) stay: a newer pi-durable still migrates its schema as it opens a store.
- `npm run shrink-images` (`daemon/store-images.ts`) stays: a script a person runs, not a migration.
- Fields that are optional because new code still leaves them out, or because chats saved before plan 049 lack them, stay optional with their defaults: `ChatInfo`'s `purpose`, `draft` and `suggestions`, `MovedChat`'s, `ChatState.suggestions`, a state reply's `learn` and `mods`, and `seen.json`'s `rests`, `return_times` and `lanes`. The `<loki-tasks>` strip in `core/harness.ts` stays, since old transcripts still hold the blocks.
- The server's history `limit` clamp up to `HISTORY_MAX` stays; lowering it changes no 1116 reader and is not needed here.
- Considered and not built: a fallback that still reads an old shape if one is found after merge. R9's check finds old data before merge instead; a fallback would keep the code this plan removes.

#### Deferred to Follow-Up Work

- The "absent from an older loki" wording on inbox and chat-list fields in `core/frame-types.ts` and `core/frames.ts` (plans 022, 067, 073, 078, 097 and others). Some of those fields may be newer than v2026.1116.0, so each needs its own check against the tag.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **A candidate goes only when v2026.1116.0 contains it and every reader of the old shape runs at a time a 1116 build has passed.** Each was checked: `git cat-file -e v2026.1116.0:<path>` for every file, and each migration's add date (2026-10-10 to 2026-10-29) is before the release. Readers that run at every start (stores at first open, approvals, desks, devices, passes, agents) have rewritten their data; lazy readers are covered by KTD5.
- KTD2. **Keep the live part of a mixed module, not the module.** `daemon/tool-kinds.ts` keeps `ToolKind`, `withKind`, `declaredKind`, `CODING_TOOL_KINDS` and `isRecord`, which every tool registration uses; only the rename tables go. `daemon/kernel/stores.ts` keeps pi-durable's backup before it opens a store; only loki's entries pass and its version mark go.
- KTD3. **The wire guard in the bridge tests keeps its list, in the test fixture.** `assertSnakeCase` (`test/fixtures/frames.ts`) fails a frame carrying an old camelCase field, using `OLD_KEYS`. A plain camelCase pattern would also flag map keys that are ids, so the list of names that were renamed moves into the fixture as test data, and its test moves with it. Production code keeps no copy.
- KTD4. **The rule for a future rename becomes a process, not a helper.** `docs/style.md` says a rename in saved data or a frame ships with its own one-time migration, kept until every install loki has shipped to has run a release containing it, then removed. Since 1116 an install updates straight to its channel's latest release, so one that was off across a release skips it; the release that removes a migration names, in its notes, the release an older install must open first. No generic `migrateKeys` stays in waiting.
- KTD5. **Lazy readers are proved by looking at the data, not by keeping the code.** The widget log reads a chat's file only when that chat opens, and Learn reads recall files when it lists them, so an old chat untouched since mid-October could still hold camelCase fields. The pre-merge check (R9) on each paired Mac is these four, so every Mac's result compares with this one's:
  1. No `OLD_KEYS` name appears as a quoted JSON key (`"agentId":`) in the files the removed `migrateKeys` readers load: `state/desks.json`, `state/devices.json`, `state/passes.json`, `state/pass-cursors.json`, `state/widget-log/*.json` (outside each entry's `data`) and `recall/**/*.json`. Stores and `mcp.json` are left out, since their camelCase names belong to pi-durable and MCP.
  2. Every `stores/*.sqlite` is listed in `stores/migrations.json` at 3.
  3. `state/migrations.json` has `agents: 1`.
  4. In the folder `tasksDir()` resolves to (`tasks`, the older `board`, or `LOKI_TASKS_DIR`), `bd --readonly list` shows no open task outside `tasks_moved`. A task the move reports and never records (no source chat, or no folder) does not stop the merge, since 1116 would never move it either.

  This Mac passed all four on 2026-11-20, with no tasks folder.
- KTD6. **One pull request, a commit per unit.** The units are independent deletions with no shared runtime risk, and each reads in one sitting. Scope is left out of the title, since the work spans `daemon`, `mod` and `core`.
- KTD7. **A history page's position becomes required everywhere it travels.** A 1116 Mac always sends `start` (`mod/frames/history.ts`), so an optional field only serves a peer that no longer exists. Tests that load a thread without one pass `0`. Keeping it optional at `ThreadModel` alone would keep the unknown-position path alive for tests only.
- KTD8. **`peer_state_get` with no folders still means all.** A 1116 Mac sends it that way when it reaches a peer and on its five-minute poll (`mod/peering.ts`, `mod/peer-state.ts`), so the default is live protocol, not an old branch. The `state_changed` push shares the same parser, so nothing is deleted there.

### Assumptions

- The owner's confirmation covers every Mac that has ever been paired, including one that is off today.
- No install outside the owner's Macs runs 2026.1022.0 or older; the owner chose to build on that (2026-11-20). The notes of the first release carrying this change say that an install on 2026.1022.0 or older must install and open 2026.1116.0 once before updating (KTD4).
- No Mac has open Tasks in a beads store that the move could not route (a desk on a Mac that was off). R9 checks this.

---

## Implementation Units

### U1. Store entries and tool names

- **Goal:** stores open without loki's entries pass, and tool names have one spelling.
- **Requirements:** R1, R4, R5.
- **Dependencies:** none.
- **Files:**
  - delete `daemon/store-migration.ts`, `test-node/store-migration.node-test.ts`, `test/tool-names.test.ts`
  - modify `daemon/kernel/stores.ts`, `daemon/tool-kinds.ts`, `daemon/approvals.ts`, `test/extensions.test.ts`
- **Approach:**
  1. `daemon/kernel/stores.ts` opens the store after pi-durable's backup, with no version check, pass or mark (KTD2).
  2. `daemon/tool-kinds.ts` drops `RENAMED_TOOLS`, `SPLIT_TOOLS`, `MERGED_TOOLS`, `MergedTool`, `renamedCall`, `renameToolsIn`, `isOldTool` and `renamedTools`.
  3. `daemon/approvals.ts` reads the stored "always allow" list as it is, still dropping `NEVER_ALWAYS_TOOLS`, and no longer saves it back on start.
  4. `test/extensions.test.ts` drops its check of `RENAMED_TOOLS`'s values; its check of today's tool names stays.
- **Patterns to follow:** `daemon/kernel/stores.ts`'s existing injected `openStore` for the store manager's tests.
- **Test scenarios:**
  - A store opened by the store manager comes back with its chats and history, and no `migrations.json` is written next to it.
  - An "always allow" list naming `bash` and `user_ask` is honoured for both after a restart.
  - An "always allow" list naming a tool in `NEVER_ALWAYS_TOOLS` still drops it.
- **Verification:** no code imports a removed name; the store manager's and approvals' existing tests pass.

### U2. Letta agents and the old pass files

- **Goal:** the daemon starts without the Letta migration or the old background-pass carry-over.
- **Requirements:** R3, R6.
- **Dependencies:** none.
- **Files:**
  - delete `daemon/agent-migration.ts`, `test/agent-migration.test.ts`, `test/passes-migrate.test.ts`
  - modify `daemon/main.ts`, `daemon/passes-state.ts`
- **Approach:**
  1. `daemon/main.ts` drops the `migrateAgents` call and `oldPassFiles`.
  2. `carryOverPasses` keeps its live part (R4): on a start with no `state/pass-cursors.json`, every existing chat's cursors start at its current length, so Reflection does not read every chat's whole history. Only its reads of `state/reflection.json`, `reflection/` and `recall/worker.json` go.
  3. `daemon/passes-state.ts` replaces `migrate` with that first-start step and drops `OLD_DEFAULT_DAILY_CAP` and `dirs`.
- **Test scenarios:**
  - Pass settings and cursors written by today's `PassState` read back unchanged after a restart (existing `PassState` tests).
  - A first start with no cursors file and two chats of 5 and 12 entries sets both jobs' cursors to 5 and 12.
  - A start with a cursors file leaves it as it is.
- **Verification:** the daemon starts on a copy of this Mac's `~/.loki` and the passes report their settings as before.

### U3. Tasks into suggestions

- **Goal:** the mod no longer reads beads or moves Tasks.
- **Requirements:** R2, R7.
- **Dependencies:** none.
- **Files:**
  - delete `mod/task-migration.ts`, `test/task-migration.test.ts`
  - modify `mod/index.ts`, `mod/peering.ts`, `test/peering.test.ts`
  - modify `core/frames.ts` (the `suggestion_add` frame and its `suggestion_added` reply), `mod/frames/suggestions.ts`, `mod/suggestions.ts`, `mod/programs.ts`, `test/frames.test.ts`, `test/suggestions.test.ts`
- **Approach:**
  1. `mod/index.ts` drops `moveOpenTasks`, its queue and the `moveTasks` dependency it hands to peering.
  2. `mod/peering.ts` drops the `tasks` syncer; the other syncers keep their `after` links unchanged.
  3. The `suggestion_add` frame, which only the move sent, goes with its handler and its sample and routing entries in `test/frames.test.ts`. The agent's `suggestion_create` tool calls `Suggestions.add` directly and is untouched.
  4. `Suggestions.add` drops its `{ id }` option and the lookup of an existing id, which only the move and the frame used, and `mod/frames/suggestions.ts` stops picking `add`.
  5. `mod/programs.ts`'s doc comment stops listing `bd` among the programs the mod runs.
- **Test scenarios:**
  - Existing peering tests pass with `moveTasks` removed from their deps.
  - Delete: `test/frames.test.ts`'s "an add names the chat, a title, a text and a target; the phone may not send one", and `test/suggestions.test.ts`'s "an add with an id the chat already holds returns that suggestion and adds nothing".
- **Verification:** a mod start on a Mac with no beads store logs no `tasks:move` line.

### U4. Field names

- **Goal:** saved files are read as they are, with no `migrateKeys`.
- **Requirements:** R1, R3, R8.
- **Dependencies:** U3 (it reads `OLD_TASK_METADATA_KEYS`).
- **Files:**
  - delete `core/snake-keys.ts`
  - modify `mod/desks.ts`, `mod/devices.ts`, `mod/recall.ts`, `mod/widget-log.ts`, `daemon/passes-state.ts`, `test/fixtures/frames.ts`
  - move the guard's test out of `test/snake-keys.test.ts` (KTD3), then delete that file
- **Approach:**
  1. Each reader parses its file directly; a rewrite it does for its own reason stays (`mod/desks.ts` rewrites a desk filed under a scope that is no longer canonical).
  2. `test/fixtures/frames.ts` keeps its own list of renamed field names for `assertSnakeCase` (KTD3).
- **Test scenarios:**
  - A desks file, a devices file and a recall card in today's shape load and are not rewritten.
  - A desk filed under an old scope is still moved to its canonical one.
  - `assertSnakeCase` still fails a frame with `agentId` at any depth, and passes snake_case fields and user data under `data`.
- **Verification:** no import of `core/snake-keys.ts` remains; the bridge tests that call `assertSnakeCase` pass.

### U6. Old peer-protocol branches

- **Goal:** history pages and suggestion drafts assume a peer on 1116 or later.
- **Requirements:** R2, R8.
- **Dependencies:** none.
- **Files:**
  - modify `core/attention/chat-store.ts`, `core/attention/thread.ts`, `core/frames.ts`, `app/src/desk/use-desk.ts`, `mod/suggestions.ts`, `daemon/chat-move.ts`
  - test `test/thread-model.test.ts`, `test/chat-events.test.ts`, `test/compaction-marker.test.ts`, `test/suggestions.test.ts`
- **Approach:**
  1. History without a position (plan 033): `ChatStore` drops `historyLimits`. A first load always asks for `HISTORY_PAGE`, and `loadOlder` with no first position returns. The `history` frame's `start`, `HistoryPage.start` and `ThreadModel.load`'s `start` become required (KTD7), and the "replace everything, position unknown" path in `ThreadModel.load` goes.
  2. Drafts (plan 049): `Suggestions` treats a `chat_update` that succeeds as the draft saved, and the "runs an older loki" refusal goes.
  3. The doc comments on `stateFolders` (`core/frames.ts`), the `history` frame's `start` and `MovedChat`'s plan-049 fields (`daemon/chat-move.ts`) stop naming an older loki. `stateFolders` keeps returning undefined for no folders (KTD8).
  4. `chat_done`'s doc comment in `core/frames.ts` stops naming a loki from before plan 049 and says why `draft_suggestion_id` is still sent: a 1116 Mac drafting here checks it while Macs update one at a time. `daemon/chat-backend.ts` keeps replying with it.
- **Test scenarios:**
  - A first history load asks for one page and keeps its position.
  - Scrolling to the top of a chat whose first page starts at 0 asks for nothing more.
  - A draft whose `chat_update` succeeds marks the suggestion drafted.
  - A draft whose `chat_update` fails with the held message still answers with the held words.
  - Delete: `test/thread-model.test.ts`'s "a page without a position replaces what was loaded, as an older Mac's answer does", `test/suggestions.test.ts`'s "a draft to a chat on a Mac whose loki does not say it saved one stays pending", and `world()`'s `older` option.
- **Verification:** the desk, the Flow deck and the phone load and scroll a long chat's history as before.

### U5. Docs

- **Goal:** the docs describe loki as it is and say how a future rename ships.
- **Requirements:** R10.
- **Dependencies:** U1–U4, U6.
- **Files:** `docs/manual.md`, `docs/architecture.md`, `docs/style.md`, `docs/SECURITY.md`.
- **Approach:**
  1. `docs/manual.md`:
     - The tool-name paragraph keeps what a person sees (old chats show their calls as they were) and drops the rename map and its `daemon/tool-kinds.ts` pointer.
     - The store-rewrite and Letta paragraphs and "What happened to Tasks" become past tense, with no retry, `bd` or `migrations.json`.
     - `LOKI_BD` and `LOKI_TASKS_DIR` leave the list of environment variables.
  2. `docs/architecture.md` drops `daemon/store-migration.ts`, `daemon/agent-migration.ts`, `mod/task-migration.ts`, `suggestion_add` and `bd` (as a child process and a program the mod finds), keeping pi-durable's backup before a schema migration. `stores/migrations.json` and `state/migrations.json` are described as files left on disk that loki no longer reads.
  3. `docs/style.md` replaces its `migrateKeys` and store-rename rules with KTD4's process; its naming example `task-migration.ts` becomes another file.
  4. `docs/SECURITY.md` drops `bd` from the programs loki runs.
- **Test scenarios:** Test expectation: none -- docs only.
- **Verification:** `git grep` in `docs/` outside `docs/plans/` finds no removed file or helper, and no `LOKI_BD`, `LOKI_TASKS_DIR`, `` `bd` `` or `migrations.json` except where it is described as a file left on disk.

---

## Verification Contract

| Check | When | Proves |
|---|---|---|
| `bun run format:check && bun run lint && bun run typecheck` | every unit | no dangling import or type |
| `bun run test && bun run test:node` | every unit | R1–R3 through the remaining tests |
| `bun run build:app && bun run build:mod && bun run smoke` | before push | the daemon and mod start |
| By hand, this Mac | before push | the daemon on today's build, then this branch, on `~/.loki`: chats, history, always-allow, passes and pins as before |
| By hand, every paired Mac (R9, KTD5) | before merge | no data in an old shape |

All on CI's toolchain: the newest Node 22, the bun in `packageManager`, `SHELL=/bin/bash`.

---

## Definition of Done

- Every unit's files are deleted or edited as listed, and no code imports a removed file or name.
- Every check in the Verification Contract passes, including the by-hand check on each paired Mac, recorded in the PR.
- `docs/manual.md`, `docs/architecture.md` and `docs/style.md` match the code (R10).
- No abandoned attempt, commented-out code or leftover helper stays in the diff.
- The PR body carries the release-note line for older installs (Assumptions), ready for the release that ships it.
