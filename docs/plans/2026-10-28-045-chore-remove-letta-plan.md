---
title: loki without Letta
date: 2026-10-28
status: active
---

# loki without Letta

## Why

loki has run on its own daemon since 2026-10-10 (plan 017), and the import from Letta has done its work. What is left of
Letta is of two kinds: code that only the import needs, and code that reads the shapes the import wrote into loki's
stores and records. The first can go. The second can go once those shapes are rewritten, the way plan 044 rewrote old
tool names: then nothing in loki knows Letta, and nothing needs to.

Measured on this Mac on 2026-10-28, read-only:

| What the import left                                          | Where                          | How many            |
| ------------------------------------------------------------- | ------------------------------ | ------------------- |
| Codex-style `exec_command { cmd }` calls                      | stores, tool calls             | 5,798               |
| `Full transcript available at:` lines, `system_alert` notes   | stores, user messages          | 1,371               |
| `Background command "…" completed` notices                    | stores, task notifications     | 374                 |
| `multiSelect` in questions                                    | stores, `AskUserQuestion` args | 9                   |
| `~/.letta/loki/…` paths                                       | stores, memory, two chats' folders | 2,067 rows, 2 files, 5 docs |
| ChatGPT's provider under Letta's names (`chatgpt-plus-pro`, `chatgpt_oauth`) | 7 chats' model, agent records | 7 + 3 |
| effort under Letta's keys (`reasoning.reasoning_effort`, `effort`, `thinking`) | agent records `model_settings` | 1 |

`~/.letta/loki` itself is a stale folder here (9.5 MB, last written 2026-10-11), not the link Tauri's move leaves.

## What changes

1. **The import goes.** `daemon/import/letta.ts` and `letta-log.ts`, the `chat_import` and `chat_import_status`
   frames, Settings' Import block, the run at start and smoke's Letta seeding. `convert.ts` goes too; the two things a
   chat move shares with it, `ImportedEntry` and the `loki.branch` kind, move to the kernel.
2. **Dead Letta code goes:** Letta's `list_models` parser (`core/models.ts`, no caller), the helper-agent filter
   (`isSubagent`; loki's helpers are not records), the old Settings page id `letta`, `.gitignore`'s `.letta/`.
3. **Stores are migrated once more** (`daemon/store-migration.ts`, which takes over plan 044's
   `store-tool-names.ts`). One pass over a store's entries, after a whole copy, in one transaction, except chats on an
   ACP agent:
   1. loki's old tool names (plan 044);
   2. `exec_command`'s `cmd` argument becomes `command`;
   3. in user messages, Letta's `<system-alert>`, `<channel-notification>` and `{"type":"system_alert"…}` blocks are
      wrapped in `<system-reminder>`, so the model still reads them and the window hides them as it hides loki's
      own; `Full transcript available at:` lines, which point into Letta's folder, are dropped;
   4. a task notification's `Background command "X" completed` summary becomes `X`, as loki writes it;
   5. a question's `multiSelect` becomes `multi_select`;
   6. `.letta/loki/` in any path becomes `.loki/`.

   Then, through pi-durable's own API with the store open: a chat whose model names ChatGPT's provider Letta's way
   takes pi-ai's name, a chat whose folder is under `.letta/loki` moves to `.loki`, and Learn's chats brought from
   Letta are hidden. `stores/migrations.json` notes each store's version (2), replacing plan 044's `tool-names.json`;
   every step is idempotent, so a store at version 1 simply runs them all.
4. **Agent records and memory are migrated once** (`daemon/agent-migration.ts`, noted in
   `state/migrations.json`): a model handle takes pi-ai's provider name, `model_settings` keeps effort as
   `reasoning_effort` only and drops `provider_type`, and memory files naming `.letta/loki/` are rewritten and
   committed as loki.
5. **Then the readers go:** `cmd` in the step's argument keys, Letta's blocks in `stripHarnessMarkup` and the
   `system_alert` row, the notice regex, `multiSelect` in the question card's input, the model healing on start and
   before a turn (`piHandle` lives on in the migration alone), the extra effort keys, which the profile pages read too,
   and `legacyChats`.
6. **The old folder:** Tauri's move from `~/.letta/loki` to `~/.loki` and its link go (`src-tauri/src/root.rs`), with
   the cask's zap of `~/.letta/loki` and the skill's note. A Mac that never ran loki after the move starts fresh;
   loki does not delete `~/.letta`, which is Letta's.
7. **Docs:** `docs/SECURITY.md` and `docs/preview-checklist.md` rewritten for the daemon-only loki; the bug template,
   README, glossary, manual and architecture lose the import and Letta's setup; comments say what loki does without
   "as Letta did". `docs/research/` stays as history.

## Decisions

Settled with the person on 2026-10-28:

1. Migrate every Letta shape still in saved data, then delete its reader, rather than keep readers.
2. Rewrite old `~/.letta/loki` paths and drop the move and link.
3. Rewrite the two stale docs in this PR.

Taken here:

4. The skill installer's commit subject (`Install skill:` in `mod/skill-sources.ts`) stays: it is read from memory's git
   history, which is not rewritten.
5. A chat's history is rewritten where it names Letta's paths and shapes, not where it only quotes Letta: the model's
   past words stay its own, and tool results (the record of what a command printed) are left as they were.
6. Letta's compaction note no longer shows as a "context compacted" row in an imported chat: it is a reminder now,
   and the chat's own compaction entry, which the import wrote, still marks the place.
7. A helper agent's record from Letta (`role:subagent`) moves to `backend/backup-letta-<date>/agents/`, so nothing
   needs to filter helpers out any more.

## Tests

1. The store migration (`test-node/store-migration.node-test.ts`): each step on its own, idempotent; an ACP chat left;
   copied first; through the store manager, once.
2. The agents' migration (`test/agent-migration.test.ts`): model handle, effort keys, a helper's record moved out,
   paths in memory committed as loki, chats' models and folders moved and Learn's old chats hidden, an ACP chat left,
   and a second start that reads nothing.
3. The readers without Letta's shapes: steps, questions, markup, notices (existing tests, Letta cases removed).
4. On copies of this Mac's real stores and records: every count in the table goes to 0, chats still open.

## Not in this plan

1. Deleting `~/.letta`: Letta's, and the person's to remove.
2. Rewriting memory's git history.
3. The tests still describe some turns in Letta's app-server events (`test/fixtures/letta-events.ts`), which the
   fixture turns into loki's own chat events; rewriting them in loki's events is test work of its own.
4. Older loki builds' own leftovers, such as the `loci-desk` block, which are loki's, not Letta's.
