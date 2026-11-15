---
title: Chats' state filters - Plan
type: feat
date: 2026-11-15
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Chats' state filters - Plan

---

## Goal Capsule

- **Objective:** in Chats, the person narrows the list to what needs them, what is new, or what is running with one click, as Mail's category pills narrow a mailbox.
- **Means:** a row of Mail-style pills (All, Waiting, Unread, Working) at the top of the Chats list, in place of All Chats' agent pop-up (KTD1).
- **Authority:** the Requirements, then the Key Technical Decisions, then the units.
- **Stop conditions.** Stop and ask if the phone's Home needs a change.
- **Execution profile:** desktop UI in `app/src/shell`; one PR.
- **Who finishes:** `ce-work` on branch `feat/chat-state-filters`; the person checks it in the running app before merging.

---

## Product Contract

### Summary

The Chats list gains four pills under its title: **All**, **Waiting**, **Unread** and **Working**. The chosen one is a filled capsule with its name; the rest are grey circles with their symbol, as in Mail. The sidebar keeps All Chats, Pinned and Archived, and the list keeps a heading per agent. The agent pop-up from plan 2026-11-15-1035 (U5) goes.

### Problem Frame

The Chats list shows every chat of a source. Finding the ones that need you, have news, or are still working means scanning every row for a badge, a bold title or a green dot.

### Key Decisions

- **State pills replace the agent pop-up.** Governs R1, R4. (session-settled: user-directed — chosen over keeping the pop-up beside the pills: the person laid out Chats as sources in the sidebar, agents as the list's headings, and state filters on top)
- **Chats only.** Flow keeps its list as it is. (session-settled: user-directed — chosen over the same pills on Flow by kind)

### Requirements

- R1. The Chats list of All Chats and Pinned shows the pills All, Waiting, Unread and Working under its title; Archived shows none.
- R2. Waiting keeps the chats that wait on you, Unread those with news since you looked, Working those whose agent is running; All keeps every chat. Each keeps its agent headings.
- R3. The chosen pill holds for the session; a chat opened from ⌘K, a notification or Open the Chat that the pill would hide clears it to All.
- R4. New Chat starts with the default agent, as before the pop-up.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **One pure filter beside the rows.** `stateRows(rows, filter)` in `app/src/shell/sidebar-model.ts` reads each row's `RowState` (`kind === "waits"`, `unread`, `live`), so the list, ⌘[ ⌘] stepping and the tests read one rule. (R2)
- KTD2. **The pills are shadcn's ToggleGroup** in a `ChatFilters` component, drawn in Mail's shape: the chosen item a filled capsule with symbol and name, the rest icon-only circles named for screen readers. `ContentList` gains a `scope` slot under its toolbar. (R1)

---

## Implementation Units

### U1. The filter, the pills and the list

- **Goal:** the pills filter the Chats list; the agent pop-up goes.
- **Requirements:** R1, R2, R3, R4.
- **Files:** `app/src/shell/sidebar-model.ts`, `app/src/shell/content-list.tsx`, `app/src/shell/desk-sidebar.tsx`, `app/src/shell/shell.tsx`, `app/src/components/components.css`, `test/desk-sidebar.test.ts`.
- **Approach:**
  1. `stateRows` and the four filters (KTD1).
  2. `ChatFilters` on ToggleGroup in the list's `scope` slot for All Chats and Pinned (KTD2).
  3. The shell holds the filter, applies it to the rows, keys the list by source and filter, and clears it when an opened chat would be hidden; the agent pop-up and its state go.
- **Test scenarios:**
  - Waiting keeps only waiting rows, Unread only unread ones, Working only running ones, All every row, headings kept.
  - The pills render four named items with the chosen one pressed; Archived renders none.
- **Verification:** the pills filter the list in the running app, light and dark.

---

## Verification Contract

`npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:node`, then `npm run build:app && npm run build:mod && npm run smoke`.

---

## Definition of Done

- R1 to R4 hold in the running app.
- `docs/design.md` and `docs/manual.md` describe the pills, and the agent pop-up is under Tried and dropped.
