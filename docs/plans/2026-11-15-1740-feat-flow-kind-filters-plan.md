---
title: Flow's kind filters - Plan
type: feat
date: 2026-11-15
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Flow's kind filters - Plan

---

## Goal Capsule

- **Objective:** in Flow, the person goes through one kind of card at a time (only mail, only Slack) with one click, as Mail's category pills narrow a mailbox.
- **Means:** the pills Chats gained in plan 2026-11-15-1523, over Flow's list: All, then one per kind of card Flow holds (Chats, Mail, Slack, Jira).
- **Authority:** the Requirements, then the Key Technical Decisions, then the units.
- **Stop conditions.** Stop and ask if the phone's Flow needs a change.
- **Execution profile:** desktop UI in `app/src/desk` and `app/src/shell`; one PR.
- **Who finishes:** `ce-work` on branch `feat/flow-kind-filters`; the person checks it in the running app before merging.

---

## Product Contract

### Summary

Flow's list gains pills under its title: **All**, then **Chats**, **Mail**, **Slack** and **Jira**, each only when Flow holds a card of that kind. They look and act as Chats' pills: the chosen one a filled capsule with its name, the rest grey circles with their symbol. The kind narrows the deck as the lane does: the list, the arrows, the moves and the count.

### Problem Frame

Flow mixes every kind of card. Someone who wants to clear their mail, or answer Slack before the chats, scans the list for symbols and skips the rest one card at a time.

### Key Decisions

- **One pill per kind Flow holds.** A kind with no card in Flow, in any lane, has no pill, so a person without Slack never sees an empty Slack pill; the chosen kind keeps its pill while it is chosen, and with fewer than two kinds there are no pills at all. (session-settled: user-directed — the person asked for Flow's kind pills after Chats' state pills)

### Requirements

- R1. Flow's list shows the pills All, Chats, Mail, Slack and Jira under its title, each kind only when Flow holds a card of it; with fewer than two kinds, none.
- R2. A kind narrows the deck to its cards, as a lane does: the list, ↑↓, the moves and the count; All shows every kind. Lanes and kinds combine.
- R3. The chosen kind holds while the app is open; switching it keeps the selected card when it is of the new kind.
- R4. The pills are Chats' pills: one component, one look.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **The kind narrows beside the lane.** `app/src/desk/flow-kinds.ts` holds the kinds, `kindOf(item)` and `inKind`; `useFlowDeck` narrows the lane's cards by the kind, and `useDeckQueue` treats a kind switch as a lane switch (`switchLane` keeps the selection only when the new lane and kind hold it). (R2, R3)
- KTD2. **One pill row.** Chats' `ChatFilters` becomes `FilterPills` in `app/src/shell/filter-pills.tsx`, taking its pills as a list; Chats and Flow both use it in `ContentList`'s `scope` slot. (R4)
- KTD3. **The shell holds the kind**, as it holds Chats' state, so it outlasts leaving Flow. (R3)

---

## Implementation Units

### U1. The kinds, the deck and the pills

- **Goal:** the pills narrow Flow's deck.
- **Requirements:** R1–R4.
- **Files:** `app/src/desk/flow-kinds.ts`, `app/src/desk/use-deck-queue.ts`, `app/src/desk/use-flow-deck.ts`, `app/src/desk/catch-up.tsx`, `app/src/shell/filter-pills.tsx`, `app/src/shell/desk-sidebar.tsx`, `app/src/shell/views.tsx`, `app/src/shell/shell.tsx`, `test/flow-kinds.test.ts`.
- **Test scenarios:**
  - Each kind keeps only its cards; All keeps every card.
  - The pills offered are All and the kinds Flow holds, the chosen one kept; none with fewer than two kinds.
  - A kind switch keeps the selected card of the new kind and sorts the rest afresh; a card of another kind is not kept.
- **Verification:** the pills narrow Flow in the running app, light and dark.

---

## Verification Contract

`npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:node`, then `npm run build:app && npm run build:mod && npm run smoke`.

---

## Definition of Done

- R1 to R4 hold in the running app.
- `docs/design.md` and `docs/manual.md` describe Flow's pills.
