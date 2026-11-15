---
title: The phone's markup apart, and loki's drawn menus on shadcn - Plan
type: refactor
date: 2026-11-15
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# The phone's markup apart, and loki's drawn menus on shadcn - Plan

---

## Goal Capsule

- **Objective:** `app/src/components/index.tsx` reads as shadcn's controls with a phone branch, and the menus loki
  draws itself (a button's menu, a sidebar row's menu) are shadcn's DropdownMenu on Base UI.
- **Means:** the phone's markup moves to `app/src/components/phone.tsx`; `MenuItems`, `PopoverMenu` and the sidebar's
  `RowMenu` render Base UI's Menu through `app/src/ui/dropdown-menu.tsx`.
- **Authority:** the Requirements, then the Key Technical Decisions, then the units.
- **Stop conditions.** Stop and ask if the phone's look or its gestures need a change.
- **Execution profile:** `app/src/components`, `app/src/shell`, `app/src/desk`; one PR.
- **Who finishes:** `ce-work` on branch `refactor/inline-ui-wrappers`; the person checks the menus in the Mac app's
  browser build before merging.

---

## Product Contract

### Summary

The handoff asked for screens to call `app/src/ui` directly. They cannot: the wrappers choose the phone's markup or
shadcn's at run time (`inLan`), and the chat and desk screens are drawn on both. So the phone's markup moves into a
file of its own, each wrapper becomes shadcn's control plus one line handing the phone its markup, and the drawn menus
move onto shadcn as plan 2026-11-15-2130 KTD6 left for this step.

### Problem Frame

`components/index.tsx` mixes two designs in one file: the desktop's shadcn controls and the phone's own buttons,
chips, switch, popover and bottom sheet. The drawn menus repeat the listeners Base UI already has: a press outside,
Esc, ↑↓ Home End, focus going back, and a position kept inside the window by hand.

### Requirements

- R1. A drawn menu opens from its button, or at the pointer for a sidebar row, sits on the side with room, moves with
  ↑↓ Home End and type-ahead, and closes on Esc, Tab, a press outside or a pick, with focus back on its button or row.
- R2. A menu keeps its entries as they are: icons, checkmarks, keys on the right, separators, a submenu's label over
  its items, a disabled item's reason as its tooltip.
- R3. The phone looks and works as before.
- R4. Call sites of `Button`, `IconButton`, `Chip`, `Switch`, `Popover` and `Sheet` do not change.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **The wrappers stay; their phone half moves.** Screens keep importing from `components`, because one screen
  serves both the Mac and the phone and the choice is made at run time. `components/phone.tsx` holds the phone's
  Button, IconButton, Chip, Switch, Popover and BottomSheet; `index.tsx` keeps the shadcn half. (R3, R4)
- KTD2. **Menus are Base UI's Menu.** `MenuItems` draws `DropdownMenuItem`, `DropdownMenuSeparator`,
  `DropdownMenuGroup` with `DropdownMenuLabel`, and `DropdownMenuShortcut`, so `menuKey`, `menuRows` and the outside
  press listeners go. A choice keeps `menuitemradio` and `aria-checked` and loki's check glyph. (R1, R2)
- KTD3. **A row's menu hangs from a point.** The sidebar's menu is a controlled Menu with no trigger, positioned
  against a virtual element at the pointer (or the row, opened by a key), and hands focus back to the row. (R1)
- KTD4. **No opening on the checked row.** Base UI's menu, like the Mac's pull-down menus, opens with nothing chosen
  by a click and on the first item by a key; the checkmark still shows the current choice.
- KTD5. **The Mac app keeps its native menus.** `NATIVE_MENUS` still pops up AppKit's menu; only the drawn menu
  changes.

---

## Implementation Units

### U1. The phone's markup apart

- **Files:** `app/src/components/phone.tsx` (new), `app/src/components/index.tsx`.
- **Test scenarios:** the existing phone and button tests pass unchanged.

### U2. Menus on DropdownMenu

- **Files:** `app/src/shell/menu-items.tsx`, `app/src/shell/desk-sidebar.tsx`, `app/src/desk/desk-pane.tsx`,
  `app/src/desk/new-chat.tsx`, `app/src/components/components.css`, `test/menu-items.test.ts` (new).
- **Test scenarios:**
  - Closed, a menu's button says it has a menu and is not expanded, and no menu is drawn.
  - Hung from a point, it draws no button of its own.
  - Open (in the browser, as Base UI draws it only once mounted): the entries in order, an icon column once any item
    has one, a checked choice with its glyph, keys on the right, one separator between groups, a submenu's label over
    its items, a disabled item's reason as its tooltip.

---

## Verification Contract

`npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:node`, then
`npm run build:app && npm run build:mod && npm run smoke`. In the worktree's Vite: New Chat's agent menu by mouse and
keys, light and dark.

---

## Definition of Done

- R1 to R4 hold in the running app.
- `docs/design.md` describes the drawn menus on Base UI and where the phone's markup lives.
