---
title: The ☰ menu on Base UI - Plan
type: refactor
date: 2026-11-15
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# The ☰ menu on Base UI - Plan

---

## Goal Capsule

- **Objective:** the ☰ menu on Windows, Linux and in a browser tab (`shell/title-menu.tsx`) is drawn by Base UI, as
  every other menu loki draws has been since plan 2026-11-15-2330, instead of by hand with its own keys and focus code.
- **Means:** shadcn's DropdownMenu with its submenu parts; `titleMenus` and `runMenuItem` stay as they are.
- **Authority:** the Requirements, then the Key Technical Decisions.
- **Stop conditions.** Stop and ask if it changes what the menu holds or where ☰ sits.
- **Execution profile:** one shell part, its CSS and tests; one PR.
- **Who finishes:** `ce-work` on branch `refactor/title-menu-base-ui`.

---

## Product Contract

### Requirements

- R1. ☰ opens the menu titles of the Mac's menu bar, in order, then Hide loki (Minimise loki on Windows), each title
  opening its items beside it with their keys in Ctrl words, as before.
- R2. By keyboard: Return, Space or ↓ open it, ↑↓ Home End and type-ahead move, → Return or Space open a title, ← or Esc
  go back to the titles, Esc closes; Tab, a press outside or a pick close it, and focus goes back to ☰ unless the pick
  took it elsewhere. By pointer, pointing at a title opens it.
- R3. It looks as the other drawn menus do: strong glass, growing from ☰ when clicked and simply there when opened by a
  key.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Submenus, not Base UI's Menubar.** Menubar draws its titles across a bar; ☰ is one 28 px button beside the
  sidebar toggle in a browser tab and at the strip's left on Windows and Linux, where a row of titles would not fit.
  The titles stay in ☰'s menu, each a `DropdownMenuSub`, which gives the cascade, the hover and the → ← keys that the
  hand-written panel coded itself (about 100 lines of keys, focus and outside-press handling go). (R1, R2)
- KTD2. **The same parts as `DrawnMenu`.** The content takes `loki-popover` for its glass and grows only after a pointer
  (`lastInput`), and `finalFocus` returns to ☰ unless focus already left the menu, as plan 2026-11-15-2330 does for the
  other menus. Its own panel CSS (`.loki-title-menu*`) goes. (R3)
- KTD3. **The workbench shows it.** The shell needs the daemon, so `?workbench` draws ☰ with Windows' keys.

---

## Verification Contract

`npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:node`, then
`npm run build:app && npm run build:mod && npm run smoke`. In the worktree's Vite at `?workbench`: Return opens the menu
on its first title, ↓ → opens Go on Search, Return runs it and focus goes back to ☰, ← goes back to the titles, Esc and
Tab close it.
