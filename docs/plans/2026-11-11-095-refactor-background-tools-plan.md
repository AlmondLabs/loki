---
title: Two background tools - Plan
type: refactor
date: 2026-11-11
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Two background tools - Plan

Plan 095 · follows plan 017 (U11, background tasks) and plan 094 (fewer tools)

---

## Goal Capsule

- **Objective:** an agent drives a background task with two tools instead of five. Every turn costs fewer tokens, and
  the model chooses between fewer near-twins.
- **Means:** `background_output`, `background_write` and `background_stop` fold into `background_watch`, which already
  answered with the task's new output and state. `background_run` stays.
- **Authority:** this plan's Requirements, then its KTDs. On 2026-11-11 the person chose this shape over keeping a
  separate stop tool or moving `background_run` into `bash`. They accepted that it bends docs/style.md's "one tool per
  action".
- **Execution profile:** one branch, one PR. The person raises and merges it.

---

## Product Contract

### Requirements

- R1. The background tools are `background_run` and `background_watch`. `background_watch { task_id, pattern?,
  timeout_ms?, input?, stop? }` writes `input` first, then stops the task if `stop` is set. It then waits for the
  pattern, the task's end, or the timeout (0 reads at once), and answers with the output since the last read and the
  task's state.
- R2. A stop answers once the task has ended, saying how it ended. The agent is not also sent a notice for it, as with
  any task it was waiting on.
- R3. The approval gate weighs a `background_watch` that types or stops as a command, as `background_write` and
  `background_stop` were. One that only reads or waits is a read.
- R4. Saved chats are rewritten once (store version 3): their output, write and stop calls, under loki's names and the
  older `TaskOutput`, `write_stdin` and `TaskStop`, become the `background_watch` calls that do the same. Chats on ACP
  agents keep their own names.
- R5. An "always allow" for `background_write` or `background_stop` carries over to `background_watch`. One for
  `background_output` does not, because it would widen a read into a stop.

### Scope Boundaries

- `bash` is untouched; it is pi-durable's tool.
- How a task runs, keeps output, and is stopped (`BackgroundTasks`) is unchanged.

---

## Planning Contract

### Key Technical Decisions

- **KTD1. One tool with optional fields, not an `action` argument.** Every call answers with the same thing, the
  task's output and state. `input` and `stop` are steps taken before that answer. docs/style.md names this as the one
  exception to "one tool per action".
- **KTD2. The call's kind follows its arguments.** `background_watch` declares itself a read. `callKind` in
  daemon/approvals.ts makes it a command when it has `input` or `stop: true`, beside the read-only `bash` check from
  plan 094.
- **KTD3. `MERGED_TOOLS` beside `RENAMED_TOOLS` and `SPLIT_TOOLS`.** It maps each old tool to its new tool and its
  arguments: output adds `timeout_ms: 0`, write turns `text` into `input` and adds `timeout_ms: 0`, and stop adds
  `stop: true`. `carriesAlways` decides R5.
- **KTD4. A stop waits up to the kill's grace period plus a second,** so its answer nearly always says how the task
  ended.

### Verification

- Tests: the two tools drive a task end to end (read, input, stop, no notice); the mode table for `background_watch`'s
  three kinds of call; the merged calls' arguments; the store rewrite; the always-allow carry; the extension's tool
  list and kinds; the window's step labels.
- By hand: in a standard-mode chat, start a server with `background_run`, watch it for "ready" without a card, stop it
  with a card.
