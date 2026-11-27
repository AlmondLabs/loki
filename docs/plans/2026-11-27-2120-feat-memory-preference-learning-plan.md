---
title: Preference learning, shared memory, and memory hygiene
date: 2026-11-27
status: draft
---

# Preference learning, shared memory, and memory hygiene

## Why

Inspecting live memory in `~/.loki` showed why agents fail to learn and apply user preferences:

1. **Reflection prioritizes project logs over preferences.** One prompt asks Reflection to track domain status, tool
   failures (`FAILURE_RULE`), and user preferences together. In practice, nearly all Reflection commits update
   `reference/` project files with transient status while `system/human/` goes untouched.
2. **The 12 KB `CORE_BUDGET` starves `system/human/`.** Redundant routing stubs in `system/` consume ~2.6 KB of the
   budget for files already listed in `Other memory files`, leaving almost no headroom for new preferences.
3. **Behavioral preference data goes unread.** `state/flow-ledger.jsonl` and user edits/rejections in
   `state/reply-proposals.json` are never surfaced to Reflection, and `ReplyProposals.send()` overwrites the agent's
   original draft `text` on edit so the diff is lost.
4. **Preferences are siloed per agent.** Each agent has its own memory repo; teaching one agent how the person
   communicates or works never carries over to other agents.
5. **`memoryDump()` (used by `/doctor`) truncates before `system/`.** Walking files alphabetically with an 80 KB limit
   fills up on large `reference/` files, `skills/`, and binary files (`profile.png`) before ever reaching `system/`.
6. **`memory_search` and `memory_read` struggle on large repos.** Exact single-substring matching misses multi-word
   queries, and `memory_read` lacks line pagination (`offset`/`limit`).

## What changes

1. **Preserve reply draft diffs (`core/frame-types.ts`, `mod/reply-proposals.ts`, `mod/reply-proposal-format.ts`).**
   When the person edits a reply proposal's `text` or ticket `subject` before sending, save `proposed_text` and
   `proposed_subject` on the `ReplyProposal` record (preserving the original draft across undo + re-edit).
2. **Shared cross-agent memory (`daemon/memory.ts`, `daemon/acp/prompt.ts`, `daemon/read-only-gate.ts`).**
   Store cross-agent user preferences under `<backend>/shared-memory/` (addressed by `shared/<path>` in all four
   `memory_*` tools, initialized lazily as its own git repo). Load `shared/*.md` in full in `memorySection` before
   `system/`, with a 6 KB `SHARED_BUDGET` checked by `overBudget()`. Invalidate every agent's section cache on
   `shared-memory` commits.
3. **Tokenized memory search & paginated reads (`daemon/memory-search.ts`, `daemon/memory.ts`).**
   Add BM25 + substring `searchMemory()` over agent memory and `shared/`, skipping `skills/` and binary files. Add
   `offset` and `limit` line pagination plus `FILE_LIMIT` truncation footers to `memory_read`.
4. **Fix `memoryDump()` for `/doctor` (`daemon/memory.ts`, `daemon/passes.ts`, `daemon/doctor.ts`).**
   Exclude `skills/` and binary files, and order files by priority (`shared/` → `system/` → `reference/human/` →
   other files) so core rules and preferences are always reviewed first.
5. **Behavioral signal collector & preference-first Reflection (`daemon/preference-signals.ts`, `daemon/reflection.ts`,
   `daemon/passes-state.ts`, `daemon/passes.ts`, `daemon/main.ts`).**
   Collect `<reply-edits>` (edited sends and rejections) and `<flow-patterns>` (consistent triage patterns from
   `flow-ledger.jsonl`) since `signals_at[agentId]` and pass them to Reflection, advancing `signals_at` only on success.
   Update Reflection and Doctor instructions to prioritize preference/correction extraction, store cross-agent rules in
   `shared/` as scannable `when X → do Y` bullets, drop redundant `system/` routing stubs, and avoid transient task logs.

## Tests

- `test/memory.test.ts`: `shared/` read/write/edit/delete and cross-agent visibility, paginated `memory_read` and
  binary refusal, tokenized multi-word `memory_search`, and prioritized/filtered `memoryDump`.
- `test/memory-disclosure.test.ts`: `shared/` budget reporting in `overBudget()` and binary exclusion in
  `memorySection()`.
- `test/preference-signals.test.ts`: `ReplyProposals` preserving `proposed_text`/`proposed_subject`, and
  `collectPreferenceSignals()` over reply edits/rejections and Flow ledger patterns.
- `test/reflection-pass.test.ts` and `test/doctor.test.ts`: Reflection receiving `signals`, writing to `shared/`,
  advancing `signals_at` only on success, and `/doctor` receiving `shared/` and `system/` ahead of large `reference/`
  files.

## Manual

Update `docs/manual.md` (Agents › Reflection and `/doctor`) and `docs/architecture.md` (Memory and background passes).
