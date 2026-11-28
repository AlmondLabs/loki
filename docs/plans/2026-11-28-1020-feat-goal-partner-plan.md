---
title: Goal-seeking partner for loki
date: 2026-11-28
status: accepted
---

# Goal-seeking partner for loki

## Why

loki's agents know what happened in past conversations through memory, and Flow surfaces incoming chats, mail, Slack messages, and Jira tickets. Neither gives loki a model of what the person is trying to achieve across short (days/week), medium (month/quarter), and long (year+) horizons, nor a loop that keeps goals current, fights the urgency trap, lowers activation energy, and proactively nudges without becoming noisy.

Behavioral science points to four failure modes loki can address directly:

1. **The intention–behavior gap & activation energy.** Goals stall when starting requires gathering context. An agent with access to chats, accounts, and memory can prep the next step before nudging.
2. **WOOP (Outcome, Obstacle, Plan) & lead vs. lag measures.** Goals need a clear outcome, a likely obstacle with an If–Then fallback, and small controllable weekly lead commitments alongside the lag outcome.
3. **The Ostrich problem & manual bookkeeping.** People abandon trackers when behind or when updating feels like work. Reflection already reads quiet chats and can log real progress, evidence, and candidate goals automatically.
4. **The mere urgency effect & goal competition.** Keeping active short-term focus visible (highlighting >3 active short-term goals), surfacing goals in every agent's prompt, and running calm daily/weekly reviews in Flow keeps attention aligned with stated goals.

## What changes

### 1. Core model and behavioral helpers (`core/goals.ts`)

- Shared types (`Goal`, `GoalHorizon`, `GoalStatus`, `GoalHealth`, `GoalLeadHabit`, `GoalProgressEntry`, `GoalsSettings`, `GoalsPulseStatus`, `GoalsSnapshot`), all `snake_case` on disk and on the wire.
- `goalHealth()`: calm, non-punitive health state (`moving`, `quiet`, `at_risk`, `paused`, `achieved`, `suggested`, `dropped`) based on horizon staleness thresholds and target dates.
- `weeklyHabitProgress()`: Monday–Sunday weekly check-in tracking for lead commitments.
- `isInQuietHours()` & `goalNeedsNudge()`: quiet-hours and per-cadence cooldown gating.
- Prompt builders for conversational goal discovery (`goalDiscoveryBrief`), working on a goal (`goalWorkBrief`), and proactive check-ins/reviews (`goalPulseBrief`).

### 2. Daemon store, prompt section, agent tools, and Reflection (`daemon/goals-store.ts`, `daemon/goals.ts`, `daemon/reflection.ts`, `daemon/passes.ts`)

- `GoalsStore` persists `<stateDir>/goals.json`, validates parent hierarchy without cycles, caps per-goal evidence entries at 50, clears `sections` cache on writes, and emits change events.
- `goalsExtension` injects `<goals>` into every native and ACP chat prompt (separate from `shared/` memory budgets) and provides `goal_list`, `goal_create`, and `goal_update` (`NEVER_ASK` in `daemon/approvals.ts`; `goal_list` allowed in `daemon/read-only-gate.ts`).
- `reflectionJob` receives active goals and can record real progress (`goal_update`) or propose recurring untracked ambitions as `status: "suggested"` (`goal_create`), never silently activating goals.

### 3. Proactive partner loop (`daemon/goal-pulse.ts`)

- `GoalPulse` runs on a 5-minute interval (and on manual trigger via `goals_pulse_run`).
- Delivers weekly reviews (wins with evidence, honest mirror of attention vs. intention, course-correction options) and daily focus / stalled-goal prep-first nudges into Flow chats.
- Respects quiet hours, per-goal cadence cooldowns, and an anti-nagging check that skips automatic nudges when the previous nudge in that chat has not been answered.

### 4. Wire protocol, mod handlers, and Flow boost (`core/frames/goals.ts`, `mod/frames/goals.ts`, `core/attention/priority.ts`, `mod/chat-listing.ts`)

- WebSocket frames (`goals_list`, `goals_create`, `goals_update`, `goals_delete`, `goals_progress_add`, `goals_habit_toggle`, `goals_settings_set`, `goals_pulse_run`, `goals_work_start`, `goals_discover_start`, and `goals_changed` push).
- `ChatListing.flow()` marks chats linked to active goals (`goal_title`), and `core/attention/priority.ts` gives unread goal-linked chats a subtle `GOAL_POINTS` boost.

### 5. Desktop (`⌘3`) and Phone UI + Preferences › Goals

- `app/src/goals/`: 3-column Goals view (`⌘3`) with sidebar sources (`Active`, `Short`, `Medium`, `Long`, `Suggested`, `Achieved`), inline evidence logging, WOOP clarity card, interactive weekly lead habit check-ins, **Work on This**, **Discover Goals**, and **Check In Now**.
- `app/src/settings/goals.tsx`: `Preferences › Goals` page for enabling proactive check-ins, default partner agent, autonomy mode (`Prep and nudge` vs. `Nudge only`), daily/weekly schedule, quiet hours, and manual runs.
- `app/src/phone/goals.tsx`: mobile Goals screen accessible from Home and More.

## Verification

- Unit and integration tests in `test/goals-core.test.ts`, `test/goals-store.test.ts`, `test/goal-pulse.test.ts`, and `test/goals-frames.test.ts`, plus updates to existing exhaustive frame/extension/preferences/shell tests.
- Full repo verification: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test`, `bun run test:node`, `bun run build:app`, `bun run build:mod`, `bun run smoke`.
