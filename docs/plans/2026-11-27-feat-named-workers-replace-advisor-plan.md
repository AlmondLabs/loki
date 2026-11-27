# Plan: Named Subagents, Hybrid Model Selection, & Workers Tab (Replacing Specialized Advisor)

## Context

Loki previously maintained two overlapping child-conversation mechanisms:
- **Advisor**: a specialized, 1-per-chat read-only reviewer spanning `core/`, `daemon/`, `mod/`, and `app/`.
- **Subagents**: general-purpose helper conversations supporting synchronous, async (`subagent_status` / `subagent_stop`), continuation (`subagent_id`), and git worktree isolation (`workspace: "worktree"`).

Now that subagents support async notifications, continuation, and worktrees, keeping a separate 50-file Advisor subsystem creates duplication and confusion. Unifying them into **Named Subagents + a Workers UI Tab** delivers the full utility of both in one model.

## Design

1. **Named Subagents (`core/subagents.ts`)**:
   - Assign memorable lowercase single-word names (`kestrel`, `ember`, `polaris`, `atlas`, `zephyr`, …) from `SUBAGENT_NAMES` via `pickSubagentName` instead of numeric `sub-1`/`sub-2` IDs.
   - Index helper conversations in `ChatIndex` as `<parentChatId>~subagent~<name>` (`hidden: true`, `subagent_for: parentChatId`, `subagent_meta` persisted on `ChatDoc`) so they remain hidden from the sidebar and Flow while live-openable and inspectable across restarts.
2. **Hybrid Model & Effort Routing (`daemon/subagents.ts`)**:
   - Add optional `model?: string` (`"inherit"` default, `"fast"`, `"strong"`, or explicit `"provider/modelId"`) and `reasoning_effort?: ReasoningEffort` to `subagent`.
   - Resolve `"fast"` and `"strong"` dynamically from `api.models.getAvailable()` (preferring the parent provider when multiple tiers exist, sorting by cost/tier hints) and validate explicit handles against connected providers.
3. **Read-Only Subagents (`daemon/read-only-gate.ts`)**:
   - Rename `daemon/advisor-gate.ts` to `daemon/read-only-gate.ts` (`readOnlyRefusal`, `READ_ONLY_TOOLS`, `readOnlyExtension`).
   - Add `read_only?: boolean` to `subagent`: restricts the helper to read-only tools (plus deferred `changes_read`), enforces `readOnlyRefusal` on every tool call without prompting for approvals, and rejects combining `read_only: true` with `workspace: "worktree"`.
4. **Workers UI Tab & Switcher (`app/src/`)**:
   - Replace `AdvisorPanel` / `AdvisorHeader` / `AdvisorAnswerRow` with `WorkersPanel`, `WorkersHeader`, `OpenWorker`, and `SubagentEventRow`.
   - Desktop workspace tab becomes `Messages | Workers | Canvas`, featuring a compact worker switcher bar (`Kestrel · haiku · running`, `Read-only`, branch pill) above a live `<Conversation>` thread. Clicking a `subagent` step notice or header chip jumps straight to that worker. Phone opens worker chats as standard conversation routes with back navigation to the parent chat.
5. **Advisor Subsystem Removal**:
   - Remove `core/advisor.ts`, `daemon/advisor*.ts`, `mod/advisor.ts`, `mod/chat-advisor.ts`, `app/src/workspace/advisor-pane.tsx`, `app/src/chat/advisor-header.tsx`, `advisor_consult`, `/advisor`, `advisor_model` / `advisor_reasoning_effort` profile fields, and advisor move holds.
   - Retain backwards-compatible stripping of legacy `<loki-advisor-answer>` markup in `core/harness.ts` and `"advisor"` -> `"helpers"` normalization in `daemon/usage.ts`.

## Verification

- `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run build:app`, `bun run build:mod`
- Full `bun run test` (including `test/tokens.test.ts`, `test/style.test.ts`, `test/core-portability.test.ts`, `test/scripts-prompt.test.ts`, `test/subagents.test.ts`, `test/workers-ui.test.ts`), `bun run test:node`, and `bun run smoke`.
