---
title: Remove the migrations 1116 shipped - Plan
type: refactor
date: 2026-11-20
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Remove the migrations 1116 shipped - Plan

---

## Goal Capsule

- **Objective:** loki stops carrying conversions for data and peers older than release 2026.1116.0, and nobody's chats, pairings, desks, approvals or background passes change on the way. A `~/.loki` that never ran 1116 is refused with a message, not quietly damaged.
- **Means:** delete each conversion that 1116 contains and that has certainly run over every file it converts (KTD1). Delete each old-peer branch that a 1116 peer never takes (KTD5). Add one start-up check for data older than 1116 (KTD2).
- **Authority:**
  - The owner chose this work over the approvals and render-stability groups, and confirmed the scope on 2026-11-20.
  - They chose the start-up check over relying on every Mac already running 1116.
  - AGENTS.md and `docs/style.md` govern code style.
- **Stop conditions:** stop and ask if a removal would change how already-converted data reads or saves, or change a frame's shape between this build and a 1116 Mac.
- **Execution profile:** deletion first. Existing tests that cover kept behaviour pass unchanged. New tests only cover the start-up check and the cursor seed.
- **Finishes and ships:** an agent through `ce-work`, in one pull request that carries this plan, opened only when the owner asks.

---

## Product Contract

### Summary

One pull request removes about 600 lines of one-time conversion and old-peer code that the 1116 release has already run everywhere. These are:

- the Letta store rewrite and the tool-rename tables;
- the agent-record migration;
- the old passes-file carry-over;
- the camelCase conversion of files read at every start;
- the chat-history paging and draft branches kept for pre-1116 peers.

Conversions that can't be shown to have finished everywhere stay. These are recall files, widget logs and the move of open tasks. A new start-up check refuses a `~/.loki` that never ran 1116 and says to run 1116 once.

### Problem Frame

AlmondLabs/loki#184 kept every migration until a release had run it on installed Macs. v2026.1116.0 (2026-11-16) contains all of them, and every paired Mac runs it.

The code now costs reading time, and it holds rules that only made sense before 1116. Examples are the tool-rename tables, a `migrations.json` version for every store, and `historyLimits` paging for peers that no longer exist.

The updater always installs the newest release, so some installs would jump straight from a pre-1116 build to this one. That covers a switched-off Mac, an old install, or a restored `~/.loki`. Without the conversions, their data would break with no sign: phones unpaired, desks dropped, old tool names always allowed.

### Requirements

**What goes**

- R1. The Letta store rewrite, its per-store version marks and the tool-rename tables are gone. Every store already converted reads and replays the same.
- R2. The agent-record and memory migration is gone.
- R3. The old passes-file carry-over is gone. When `state/pass-cursors.json` is missing, the passes still start each existing chat from its current end rather than from the beginning.
- R4. Files read and rewritten at every daemon or mod start are read as snake_case only. These are `state/desks.json`, `state/devices.json`, `state/passes.json` and `state/pass-cursors.json`.
- R5. The history paging kept for peers that answer without a position is gone, and so is the draft branch for peers older than plan 049. Every frame keeps its shape in both directions with a 1116 Mac.

**What stays**

- R6. Recall files and widget logs keep their camelCase conversion on read, because nothing shows that every such file has been read since 1016.
- R7. The move of open tasks into suggestions stays, together with `suggestion_add` and `state/migrations.json`'s `tasks_moved`. The move retries until each task lands, and 1116 Macs still send `suggestion_add`.
- R8. `daemon/store-backup.ts` stays (pi-durable's own schema upgrades), and so do the phone router's old bookmark routes.
- R9. Files the migrations left behind stay on disk untouched: `backup-letta-*`, `stores/migrations.json`, `tool-names.json`, `state/reflection.json`, `reflection/` and `recall/worker.json`.

**Data older than 1116**

- R10. At start, before any store, approval or pass file is opened, the daemon refuses a `~/.loki` that holds loki data but was never started by a build that ran the agent migration. It also refuses one with a store that 1116 did not finish converting. The refusal tells the person to start loki 2026.1116 once first, and they see it where a failed start already shows.
- R11. A fresh `~/.loki` starts as usual, and every later start passes the check.

**Words**

- R12. `docs/manual.md`, `docs/architecture.md` and `docs/style.md` describe what remains. That includes the upgrade rule (anything older than 1116 goes through 1116) and a rule for the next tool rename.

### Key Decisions

- **Add a start-up check rather than rely on every Mac running 1116** (session-settled: user-directed — chosen over "no check, only my own Macs run loki": the updater jumps stale installs straight to the newest release). Governs R10, R11.
- **Keep any conversion whose finish can't be shown** (session-settled: user-approved — chosen over removing all of them and risking a card or log loki stops reading). Governs R6, R7.
- **Leave leftover files on disk** (session-settled: user-approved — chosen over deleting them in this pull request: deleting someone's files is its own decision). Governs R9.

### Scope Boundaries

- Optional frame fields documented as "absent from an older loki" stay optional. Each is also absent for other reasons, such as a row kind, an unset value or a stored record. Only the clause about older peers goes from their doc comments.
- Compatibility code for old clients rather than old peers stays: `OutsideMove.action "next"`, and replies from apps before plans 070 and 076.
- The canonical-scope tidy-up in `mod/desks.ts` stays. It is data hygiene, not a release migration.
- Considered and not built:
  - **Deleting `HistoryPage.more`.** 1116 apps still read it on the wire. Revisit when no 1116 app remains.
  - **A rollback guard.** Starting 1116 again on this data is benign: it re-checks stores with no mark and finds nothing to rewrite. That would change only if a later release migrates stores again.

### Deferred to Follow-Up Work

- Remove the task move, `suggestion_add`, recall's and widget-log's conversion and `core/snake-keys.ts`'s `migrateKeys` once a release after this one has shipped. For recall and widget logs, also once a sweep or a check shows no camelCase file remains.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Remove only what ran at start over every file.**
  - Proven converted, so they go:
    - stores (every listed agent's store opens at daemon start);
    - `approvals.json` (the `Approvals` constructor at daemon start);
    - agent records and memory (once, gated by `state/migrations.json` `agents`);
    - the four state files in R4.
  - Kept: recall and widget logs (converted only when read, R6) and the task move (it retries forever by design, R7).
  - Every removed piece is the same in v2026.1116.0. Only comments changed since the tag, plus one lint suppression.
- KTD2. **The start-up check keys on the marker 1116 already writes** (instantiates the start-up-check decision; R10, R11).
  - Every daemon from 2026-10-28 on, 1116 included, writes `agents: 1` to `state/migrations.json` at its first start, data or not. A missing marker next to loki data therefore means no 1116-era daemon ever ran on it.
  - A store mark below 3 in `stores/migrations.json` means 1116 never finished that store. That happens when a nightly from before 2026-11-11 last opened it, or when 1116's rewrite threw. A mark counts only for a listed agent whose `stores/<id>.sqlite` exists. Deleting an agent leaves its entry behind, and 1116 opens only listed agents' stores, so any other entry could never be cleared by running 1116.
  - A store with no mark is fine: a pre-marker store implies a missing `agents` marker, and stores created by this build carry no mark.
  - When neither marker exists and there is no data, the check writes `agents: 1` itself. It merges with `tasks_moved` and writes atomically, so the next start passes.
  - The check only reads, apart from that one write on a fresh `~/.loki`.
- KTD3. **The cursor seed survives as a first-start rule, not a migration** (R3). When `pass-cursors.json` is missing, `PassState` sets each listed chat's cursors to its current length and saves. It reads no old file.
  - Without the seed, a Mac whose 1116 carry-over failed would reflect over every chat at once.
  - `daemon/main.ts` keeps `await chats.loaded()` before `passes.start()`, so the timing stays as it is.
- KTD4. **`ThreadModel.load` keeps an optional `start`** (R5). An undefined `start` also means "no position known": the host has no history loader. About 25 test calls rely on it.
  - Only `ChatStore` loses its old-peer branches: `historyLimits`, the `first === null ? !!page.more` term and the `before === null` growth branch.
  - `loadOlder` with no position returns. Its "older" flag cannot be true without a position, because thread state is never reset.
- KTD5. **Old-peer removals keep the wire as it is** (R5).
  - The mod's `history_get` keeps clamping `limit`, because 1116 apps send it.
  - `chat_done.draft_suggestion_id` stays optional, since it is absent when there is no draft.
  - `stateFolders(undefined)` stays "all folders". It is the current reconnect and poll path, not only an old peer's push.
- KTD6. **`core/snake-keys.ts` keeps `OLD_KEYS` whole** (R6). `migrateKeys` for recall and widget logs applies every key. `test/fixtures/frames.ts`'s snake-case guard also uses every key as a forbidden wire key, for 14 test files.
- KTD7. **The next tool rename brings its own one-time migration and marker** (R12). `docs/style.md` says so in place of the `RENAMED_TOOLS` rule. The new marker must not reuse `stores/migrations.json`: stores created after this change carry no mark, and a reused key would read them as old.

- KTD8. **The refusal has its own exit code, and the shell stops on it** (R10). A daemon exit today reaches the window only as the generic "keeps stopping" note (`crash_loop_note`), while the shell restarts the daemon forever.
  - The daemon exits with a new code defined beside `EXIT_HELD` in `daemon/main.ts` and `src-tauri/src/harness.rs`.
  - `supervise_daemon` in `src-tauri/src/lib.rs` treats that code as final: it stops restarting and publishes the refusal as the daemon status's error, naming 2026.1116.

### Open Questions

- Deferred to implementation: what exactly counts as "loki data" for R10. At least:
  - a listed agent;
  - any `stores/*.sqlite`;
  - any of `state/{desks,devices,approvals,passes,pass-cursors}.json`.

  U1 settles the list from the files the removed conversions read.

---

## Implementation Units

### U1. Refuse data older than 1116

- **Goal:** a `~/.loki` that a 1116-era daemon never started is refused at start, with a message saying to run 1116 once first. A fresh one gets the marker.
- **Requirements:** R10, R11 (KTD2, KTD8).
- **Dependencies:** none. It lands first, so the removals below never run against unchecked data.
- **Files:**
  - a new `daemon/old-data.ts`;
  - `daemon/main.ts`, where the check runs before `StoreManager`, `Approvals` and `PassState` are built;
  - `src-tauri/src/harness.rs` and `src-tauri/src/lib.rs` for the new exit code;
  - `test/old-data.test.ts`, plus a Rust test in `src-tauri/src/harness.rs` for the new code's status.
- **Approach:**
  1. Read `state/migrations.json` and `stores/migrations.json` with the existing `readJson`. Treat a malformed file as no marker.
  2. Decide: refuse, mark a fresh `~/.loki`, or pass.
  3. On refuse, report the sentence naming 2026.1116 and exit with KTD8's code. Doc comments on the code in both languages state its meaning, because it crosses a process boundary.
  4. Write a doc comment on the check stating the two marker files' meaning, because they are files under `~/.loki`.
- **Patterns to follow:**
  - `daemon/passes-state.ts` for state-file reads, and `writeJsonAtomic` for the one write.
  - `EXIT_HELD` and its branch in `supervise_daemon` for the exit code.
- **Test scenarios:**
  - A folder with an agent record and no `state/migrations.json` is refused, and the message names 2026.1116.
  - A folder with an agent record and `{ "agents": 1, "tasks_moved": [...] }` passes.
  - A folder with `agents: 1` and a store marked 2 in `stores/migrations.json` is refused.
  - A folder with `agents: 1` and a store with no mark passes.
  - A folder with `agents: 1`, a listed agent's store marked 3, and a leftover entry marked 2 for a store file that no longer exists passes.
  - In Rust, the new exit code maps to a final status carrying the refusal, while other codes still go through `crash_loop_note`.
  - An empty folder passes, writes `agents: 1`, and passes again on a second check.
  - An empty folder that already holds `tasks_moved` keeps it when the marker is added.
  - A malformed `state/migrations.json` next to loki data is refused, not crashed on.
- **Verification:** the tests pass, and a daemon started on a fixture folder from before 1116 stops with the message (see the Verification Contract).

### U2. Stores and approvals without the rename tables

- **Goal:** stores open without the Letta rewrite or version marks, and approvals load without renaming old tool names.
- **Requirements:** R1, R8, R9 (KTD1).
- **Dependencies:** U1.
- **Files:**
  - deleted: `daemon/store-migration.ts`, `test/tool-names.test.ts`, `test-node/store-migration.node-test.ts`;
  - changed: `daemon/kernel/stores.ts`, `daemon/tool-kinds.ts`, `daemon/approvals.ts`, `test/extensions.test.ts`.
- **Approach:**
  1. `StoreManager`'s default opener keeps `backupBeforeMigration` and loses the version check, the rewrite and the mark. Complete the comment at its pi-durable copy, which the comment purge cut mid-sentence.
  2. `tool-kinds.ts` loses everything from `RENAMED_TOOLS` to `renameToolsIn`. It keeps `ToolKind`, `KindedTool`, `withKind`, `declaredKind`, `CODING_TOOL_KINDS` and `isRecord`.
  3. `Approvals` builds its always-set from the stored names minus `NEVER_ALWAYS_TOOLS`, with no write-back.
  4. In `test/extensions.test.ts`, drop the `RENAMED_TOOLS` assertion and the describe "tools allowed always, under their old names".
- **Test scenarios:**
  - The existing `test/approvals.test.ts` always-allow tests pass unchanged (current names).
  - The existing `StoreManager` tests pass unchanged.
- **Verification:** no code imports the removed names, and `test:node` passes without the store-migration file.

### U3. No agent migration and no passes carry-over

- **Goal:** the daemon starts without the agent migration or the old passes files, and still seeds cursors when `pass-cursors.json` is missing.
- **Requirements:** R2, R3 (KTD1, KTD3).
- **Dependencies:** U1.
- **Files:**
  - deleted: `daemon/agent-migration.ts`, `test/agent-migration.test.ts`, `test/passes-migrate.test.ts`;
  - changed: `daemon/main.ts`, `daemon/passes-state.ts`;
  - new: `test/passes-seed.test.ts`.
- **Approach:**
  1. `main.ts` loses the `migrateAgents` call, `oldPassFiles` and `carryOverPasses`. It keeps `await chats.loaded()` before `passes.start()` and calls the seed between them.
  2. `PassState` replaces `migrate` and `started` with one seed method. When the cursors file is missing, it sets each given chat's cursor for each job to its entry count and saves.
  3. `OLD_DEFAULT_DAILY_CAP`, `dirs` and the unused imports go.
- **Test scenarios:**
  - With no `pass-cursors.json` and two chats of 10 and 0 entries, seeding writes both cursors at 10 and 0 for every job.
  - With an existing `pass-cursors.json`, seeding changes nothing, so a cursor at 4 stays 4.
  - With no `pass-cursors.json` and no `passes.json`, `settings()` returns the defaults: reflection on, learn off at its default cap, ACP on.
- **Verification:** the daemon starts in the smoke run, and nothing references `oldPassFiles`, `recallDir` in `main.ts`, or `AGENTS_VERSION`.

### U4. Start-up files read as snake_case only

- **Goal:** desks, devices and both passes files are read without `migrateKeys`, while recall and widget logs keep it.
- **Requirements:** R4, R6 (KTD1, KTD6).
- **Dependencies:** U3 (both edit `daemon/passes-state.ts`).
- **Files:**
  - `daemon/passes-state.ts`, `mod/desks.ts`, `mod/devices.ts`;
  - `core/snake-keys.ts`, only if an export becomes unused;
  - `test/snake-keys.test.ts`.
- **Approach:**
  1. Each of the four reads becomes a plain read, with no `changed` and no write-back on that path.
  2. In `mod/desks.ts`, the canonical-scope tidy-up keeps its own write-back.
  3. `OLD_KEYS`, `OLD_TASK_METADATA_KEYS` and `migrateKeys` stay, because recall, widget-log, the task move and the test guard use them.
- **Test scenarios:**
  - The existing desks, devices and passes tests pass unchanged (they write snake_case).
  - `test/chat-listing.test.ts`'s canonical-scope case still rewrites `desks.json`.
  - `test/snake-keys.test.ts` keeps its `migrateKeys` tests, since the function stays.
- **Verification:** outside `docs/plans/`, `git grep migrateKeys` lists only `mod/recall.ts`, `mod/widget-log.ts`, `mod/task-migration.ts`, `core/snake-keys.ts`, its tests and `docs/style.md`.

### U5. Old-peer branches

- **Goal:** the chat store and suggestions drop the branches only pre-1116 peers took, and the wire stays as it is.
- **Requirements:** R5 (KTD4, KTD5).
- **Dependencies:** none.
- **Files:**
  - `core/attention/chat-store.ts`, `mod/suggestions.ts`, `core/frames.ts` (doc comments only);
  - `test/thread-model.test.ts`, `test/suggestions.test.ts`, `test/peer-state.test.ts`.
- **Approach:**
  1. `ChatStore` loses `historyLimits`. `loadThread` asks for one `HISTORY_PAGE`, and "older" comes only from a known first position. `loadOlder` returns when there is no position.
  2. `Suggestions` returns success after a draft update without checking `draft_suggestion_id` against an older peer.
  3. The doc comments on `history`'s `start`, `chat_done.draft_suggestion_id` and `stateFolders` lose their older-loki clause.
- **Test scenarios:**
  - Delete the thread-model test "a page without a position… as an older Mac's answer does".
  - Delete the suggestions test for a draft carried to an older Mac, and the fake's `older` option.
  - The peer-state test about a push without folders keeps its assertion, and its name loses "as an older loki's".
  - A chat whose history loads with a position still reports older entries and loads them on `loadOlder`. That is the existing `ChatStore` and thread-model coverage, which passes unchanged.
- **Verification:** the frames tests pass unchanged, which shows no frame changed shape.

### U6. The words

- **Goal:** the docs describe what loki does after this change and how to upgrade from before 1116.
- **Requirements:** R12 (KTD7).
- **Dependencies:** U1–U5.
- **Files:** `docs/manual.md`, `docs/architecture.md`, `docs/style.md`.
- **Approach:**
  1. In the manual, the "Saved chats are kept in the shapes…" and "Leaving Letta behind…" passages give way to one passage:
     - upgrading from before 2026.1116 goes through 2026.1116;
     - what the start-up check says;
     - which leftover files may remain.

     The Tasks, `bd`, `LOKI_BD` and `LOKI_TASKS_DIR` passages stay.
  2. In architecture:
     - drop `store-migration.ts`, `agent-migration.ts` and `tool-names.json`;
     - say `state/migrations.json` now holds the task move's record and the start-up marker;
     - call `stores/migrations.json` an old file the start-up check reads.
  3. In style, `:103-106` becomes KTD7's rule. The `migrateKeys` rule at `:77-78` stays, worded for recall and widget logs only. The `task-migration.ts` example name stays.
- **Test expectation:** none. No test reads these docs, and the format check is the only automated check on them.
- **Verification:** none of the three docs names a removed file or function, and each names the upgrade rule.

---

## Verification Contract

| Check | When |
|---|---|
| `bun run lint:fast` and `bun run typecheck` | while working |
| `bun run format:check && bun run lint && bun run typecheck && bun run test && bun run test:node` | before pushing |
| `bun run build:app && bun run build:mod && bun run smoke` | before pushing |
| the cargo lines in `docs/CONTRIBUTING.md#checks` (U1 changes `src-tauri/`) | before pushing |
| On a copy of a pre-1116 fixture folder, the built daemon stops with the 2026.1116 message. On a fresh folder it starts. | by hand, before pushing |
| On this Mac's `~/.loki`, read-only: every store listed in `stores/` has 3 in `stores/migrations.json`; the daemon log has no "did not open"; `state/migrations.json` has `agents: 1`; the R4 files hold no camelCase keys; `approvals.json` holds no old tool names | by hand, before pushing |
| CI on the pull request, Windows included | after pushing |

Every check runs on CI's toolchain: bun from `packageManager`, the newest Node 22 and `SHELL=/bin/bash`. Tests inject the file root and never touch the real home folder.

---

## Definition of Done

- Every unit's verification holds, and every check in the Verification Contract passes.
- `git grep` finds none of these outside `docs/plans/` and git history: `store-migration`, `agent-migration`, `RENAMED_TOOLS`, `SPLIT_TOOLS`, `MERGED_TOOLS`, `renameToolsIn`, `carryOverPasses`, `historyLimits`.
- The kept conversions (R6, R7) and the files left on disk (R9) are untouched.
- No dead import, unused export or half-removed helper is left behind. `bun run lint` reports no unused code.
- The pull request carries this plan and the doc changes.
