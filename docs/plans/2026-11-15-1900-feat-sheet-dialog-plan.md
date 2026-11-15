---
title: Sheet on shadcn's Dialog - Plan
type: feat
date: 2026-11-15
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Sheet on shadcn's Dialog - Plan

---

## Goal Capsule

- **Objective:** the desktop's sheets (Preferences, Search, Rename, Labels, Change Folder, Keys, Suggestions, Welcome) behave as a Mac's do, with focus held inside, Esc and a click outside closing them, and focus back where it was, from one well-tested dialog rather than loki's own.
- **Means:** `Sheet` draws a desktop sheet with shadcn's Dialog on Base UI (plan 2026-11-15-1035 moved the other controls); the phone's bottom sheets keep their own markup and drag.
- **Authority:** the Requirements, then the Key Technical Decisions, then the units.
- **Stop conditions.** Stop and ask if a sheet's look or keys would change on screen.
- **Execution profile:** `app/src/components` and `app/src/ui`; one PR.
- **Who finishes:** `ce-work` on branch `feat/sheet-dialog`; the person checks it in the running app before merging.

---

## Product Contract

### Summary

Every caller keeps `Sheet` and its props. On the desktop it becomes shadcn's Dialog: Base UI holds focus inside, puts it on the first control (or the one marked `autofocus`), returns it to the opener, closes on Esc and a click outside, locks the page's scroll and hides the rest of the window from a screen reader. The look stays: the same veil, card, glass, widths, tops and the fade and rise when a click opens it. The phone's bottom sheet keeps its own markup, since its drag and receding screen are its own (as the phone's touch-sized controls kept theirs).

### Problem Frame

`Sheet` reimplements a dialog: its own Tab loop, focus on open, focus back on close, Esc and veil clicks. Each is a place for a bug (a Tab loop that misses a control added later, focus lost when the opener is gone) and none of it is shared with the shadcn controls the app now uses.

### Requirements

- R1. A desktop sheet is shadcn's Dialog on Base UI: modal, focus held inside, first control or `autofocus` focused, focus returned on close.
- R2. Esc closes a sheet that has `onClose` and `escape` on; a click outside closes one with `onClose`; Welcome, with neither, closes on neither.
- R3. The look holds: veil (none for `clear`), card, width, height, top, the veil's scroll for `scroll`, the stacking `zIndex`, the fade and rise on a click only.
- R4. Bottom sheets (the phone's) are unchanged.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Dialog's parts, loki's classes.** `Sheet` composes `Dialog`, `DialogPortal`, `DialogOverlay` and two parts added to `app/src/ui/dialog.tsx` in shadcn's style, `DialogViewport` and `DialogPopup` (Base UI's Viewport and Popup), since shadcn's `DialogContent` centres a fixed-size card with a close button while loki's sheets hang from a top and size to a width. The veil and card keep their `loki-veil` and `loki-sheet-card` rules. (R1, R3)
- KTD2. **Dismissal by reason.** `onOpenChange` reads Base UI's reason: `escape-key` closes only with `escape` and `onClose`, `outside-press` only with `onClose`; Welcome passes neither and sets `disablePointerDismissal`. (R2)
- KTD3. **The bottom sheet stays loki's.** `placement="bottom"` draws the existing markup with `useSheetMotion`; only the desktop branch changes. (R4)

---

## Implementation Units

### U1. Sheet on Dialog

- **Goal:** desktop sheets on shadcn's Dialog; the phone's untouched.
- **Requirements:** R1–R4.
- **Files:** `app/src/ui/dialog.tsx`, `app/src/components/index.tsx`, `app/src/components/components.css`, tests that render a sheet.
- **Test scenarios:**
  - A desktop sheet renders as a modal dialog named by its label, in the veil and card classes, `clear` without a veil.
  - Esc and outside press close or not as R2 says.
  - A bottom sheet renders as before.
- **Verification:** Preferences, ⌘K, Rename and the Keys sheet in the running app: focus inside, Esc, a click outside, focus back.

---

## Verification Contract

`npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:node`, then `npm run build:app && npm run build:mod && npm run smoke`.

---

## Definition of Done

- R1 to R4 hold in the running app.
- `docs/design.md` says the desktop's sheets are shadcn's Dialog, and the Tab loop's "next step" note goes.
