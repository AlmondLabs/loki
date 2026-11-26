---
title: Popover and the tab row on shadcn - Plan
type: refactor
date: 2026-11-15
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Popover and the tab row on shadcn - Plan

---

## Goal Capsule

- **Objective:** the last two controls loki draws itself, `Popover` and `TabRow` in `app/src/components/index.tsx`, are
  shadcn's on Base UI, as plan 2026-11-15-1035 set out (KTD1, KTD4) and its PRs left undone.
- **Means:** `shadcn add popover tabs` (base-nova) into `app/src/ui`, bent to loki's fences; the wrappers render them.
- **Authority:** the Requirements, then the Key Technical Decisions, then the units.
- **Stop conditions.** Stop and ask if the phone's look or its gestures need a change.
- **Execution profile:** desktop UI in `app/src/components`, `app/src/chat`, `app/src/desk`, `app/src/shell`; one PR.
- **Who finishes:** `ce-work` on branch `refactor/popover-tabs-on-shadcn`; the person checks it in the Mac app before
  merging.

---

## Product Contract

### Summary

A popover on the desktop is Base UI's: it hangs from the control that opened it, turns to the other side when the
window has no room, and closes on Esc or a press outside, handing focus back to that control. The pane header's tab
views are shadcn's Tabs in their segmented capsule. The phone keeps its own markup for both, as Button, Switch and
Sheet do.

### Problem Frame

Each of loki's popovers repeats the same window listeners for a press outside, Esc and focus going back, and each
places itself with absolute offsets from a wrapper, so one near the window's edge is cut off. The tab row hand-writes
a tablist's roving focus that Base UI already has.

### Requirements

- R1. A desktop popover opens from its control, sits beside it on the side that has room, and closes on Esc, a press
  outside or a second press on the control, with focus back on the control.
- R2. The pane header's tab views keep their tablist: a name, one selected tab, Tab lands on it, ←→ Home End move and
  choose, each tab names the panel it controls.
- R3. The phone looks and works as before.
- R4. Nothing a person can do today goes away.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **`Popover` owns its trigger.** It takes `open`, `onOpenChange` and a `trigger` element and renders Base UI's
  Root, Trigger, Portal, Positioner and Popup, so outside presses, Esc and focus return are Base UI's and the call
  sites' own listeners go. This changes the wrapper's props, which plan 2026-11-15-1035 KTD1 kept: a popover cannot
  hang from a control it does not know. `anchor` and `side` become Base UI's `align` and `side`. (R1)
- KTD2. **The phone keeps its markup.** Under `inLan` or `touch`, `Popover` draws today's `loki-popover` panel beside
  the trigger in one positioned wrapper and runs one shared dismissal (press outside, Esc, focus back), so the phone's
  call sites lose their listeners too. (R3)
- KTD3. **TabRow is shadcn's Tabs, not the toggle group.** Plan 2026-11-15-1035 KTD4 put it on the toggle group, which
  has no tab role. Tabs keeps the tablist; Base UI lets a tab's own `aria-controls` win over its panel lookup, so the
  desk's panels stay where they are, outside the header. `activateOnFocus` keeps arrows choosing. (R2)
- KTD4. **The slash palette is not a popover.** It follows the message box and never takes focus, so it draws its own
  panel with the popover's look, as the label picker does.
- KTD5. **The model picker's desktop popover goes.** On the desktop the model is picked in ⌘K
  (`conversation.tsx`, `inCommand`), so its popover branch is never drawn; the picker is the phone's sheet.
- KTD6. **Menus stay on `PopoverMenu`.** Moving them to shadcn's DropdownMenu belongs with inlining the wrappers.

---

## Implementation Units

### U1. The ui pieces

- **Files:** `app/src/ui/popover.tsx`, `app/src/ui/tabs.tsx` (new, via `shadcn add`).
- **Approach:** `cn` from `@/lib/utils`, `z-toast` for the positioner as the menus have it, `shadow-float`,
  `font-semibold` and `outline-hidden` for the fenced classes.

### U2. Popover on Base UI

- **Files:** `app/src/components/index.tsx`, `app/src/components/components.css`, `app/src/shell/menu-items.tsx`,
  `app/src/desk/new-chat.tsx`, `app/src/desk/desk-pane.tsx`, `app/src/chat/link-header.tsx`,
  `app/src/chat/permission-mode.tsx`, `app/src/chat/model-picker.tsx`, `app/src/chat/slash-palette.tsx`.
- **Test scenarios:**
  - Closed, a popover's trigger names it with `aria-haspopup` and `aria-expanded="false"`, and its panel is not drawn.
  - On the phone, the open panel is drawn beside its trigger with its role and name.
  - The link chip that folds several links still says how many and opens a dialog.

### U3. TabRow on Tabs

- **Files:** `app/src/components/index.tsx`, `app/src/components/components.css`, `test/list-row.test.ts`,
  `test/shell-look.test.ts`.
- **Test scenarios:**
  - The pane header's tab row is a tablist with its name and one selected tab with tab stop 0, the others -1.
  - A tab given `panelId` names that panel in `aria-controls`.

---

## Verification Contract

`npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:node`, then
`npm run build:app && npm run build:mod && npm run smoke`. In the worktree's Vite: the desk's tabs by mouse and keys,
the link list, the folder field and the chat actions menu, light and dark, one near the window's edge.

---

## Definition of Done

- R1 to R4 hold in the running app.
- `docs/design.md` describes Popover and TabRow on Base UI; `docs/manual.md` says Esc or a press outside closes a
  popover.
