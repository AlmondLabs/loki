# Plan: Built-in `plan` tool, auto-backgrounding `bash`, and async / worktree `subagent`

## Context

Loki's native Pi engine already renders `<AgentPlan>` checklists in the UI when a tool named `plan` outputs `[x]`, `[~]`, and `[ ]` lines (`core/harness.ts`), supports background command execution with live watching and steering notices (`daemon/background.ts`), and delegates self-contained tasks to hidden helper conversations (`daemon/subagents.ts`). Three targeted upgrades close the remaining gaps:

1. **Built-in `plan` tool** (`daemon/plan.ts`): exposes the checklist tool directly on native chats, excluded from approval prompts (`NEVER_ASK`) and excluded from advisor prompt sections (`LEFT_OUT_SECTIONS`).
2. **Auto-backgrounding `bash` & task listing** (`daemon/background.ts`, `daemon/extensions.ts`): folds `background_run` into `bash` via `background?: boolean` and `wait_ms?: number` (returning inline output if the command finishes within `wait_ms`, or returning a `task_id` and notifying on completion if it runs longer), and makes `task_id` optional on `background_watch` to list active/recent tasks.
3. **Async subagents, continuation & git worktree isolation** (`daemon/subagents.ts`, `daemon/worktrees.ts`): adds `async?: boolean`, `workspace?: "inherit" | "worktree"`, and `subagent_id?: string` to `subagent`, plus `subagent_status` and `subagent_stop`.

## Design & Lifecycle

- **Approvals & Advisor (`daemon/approvals.ts`, `daemon/advisor-gate.ts`)**:
  - `plan` is in `NEVER_ASK`.
  - `bash` counts as `"read"` only when `isReadOnlyCommand(command)` holds AND neither `background: true` nor `wait_ms` is set. Advisor refuses `bash` calls with `background` or `wait_ms`.
  - `subagent` with `workspace: "worktree"` counts as `"command"` (since it creates a git worktree and branch). `subagent_status` is `"read"`; `subagent_stop` is `"command"`.
- **Async subagents via `Harness`**:
  - `ToolExecutionApi` and `ConversationHandle` in `@earendil-works/pi-durable` are strictly invocation-bound and reject once `execute()` returns.
  - Therefore `SubagentManager` takes `harnessFor?: (agentId: string) => Promise<Harness>` and a long-lived `context` (from `daemon/main.ts` -> `stores.get(agentId).harness`).
  - Helper conversations created with `Harness` use `{ ownership: { kind: "ownerless" } }`, copy the parent agent's `PiAgentDoc` settings, apply child `cwd` and extension exclusions, and record `{ hidden: true, helper_for }` on `ChatDoc`.
  - When `async: true`, execution runs against `withAbortSignal(run.abort.signal, withoutAbortSignal(manager.context))`; completion notifies the parent chat via `<task-notification>` with `<kind>subagent</kind>` unless a `subagent_status` call is already waiting on it.
  - Synchronous `subagent` preserves the existing `ToolExecutionApi` fallback when `harnessFor` is absent (for lightweight extension unit tests).
- **Git worktrees (`daemon/worktrees.ts`)**:
  - Runs `git` with `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=NO_FILE`, `GIT_TERMINAL_PROMPT=0`, `-c core.hooksPath=...`, `-c core.fsmonitor=false`.
  - Creates branch `loki-subagent/<id>` under `<worktreesDir>/<id>`, preserving subdirectory offset when the chat's `cwd` is inside a repository subfolder.
  - Preserves worktrees after completion so the parent agent or user can inspect/cherry-pick/merge commits; removes them via `subagent_stop` (default `remove_worktree: true`), agent removal (`stopAgent`), or daemon shutdown (`stopAll`), using `git branch -d` (never force-deleting unmerged commits).

## Verification

- `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run build:app`, `bun run build:mod`
- Vitest suites: `test/plan-tool.test.ts`, `test/subagents.test.ts`, `test/extensions.test.ts`, `test/background-schedule.test.ts`, `test/approvals.test.ts`, `test/advisor.test.ts`, `test/tool-steps.test.ts`, `test/daemon-tools.test.ts`, plus full `bun run test`, `bun run test:node`, and `bun run smoke`.
