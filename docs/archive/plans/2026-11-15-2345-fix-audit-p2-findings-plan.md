---
title: The audit's P2 findings - Plan
type: fix
date: 2026-11-15
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# The audit's P2 findings - Plan

---

## Goal Capsule

- **Objective:** fix the minor findings (P2) of the 2026-11-15 audit of the desktop UI (`.impeccable/audit/`), so what
  the desktop shows reads right, contrasts, follows Apple's words and keeps up in a long chat.
- **Means:** small fixes where each finding lives; no new component.
- **Authority:** the Requirements, then the Key Technical Decisions.
- **Stop conditions.** Stop and ask if a fix changes what a control does.
- **Execution profile:** desktop UI across `app/src`; one PR. The P1 accessibility findings follow in their own PR.
- **Who finishes:** `ce-work` on branch `fix/audit-p2`.

---

## Product Contract

### Requirements

- R1. A chosen option in a question card shows its tick or dot in light and dark.
- R2. The Windows and Linux close button turns red under the pointer, as those systems draw it.
- R3. Secondary text is never dimmed below the muted colour (AA, 4.5:1).
- R4. Controls are in Apple's title case: Welcome's Next, Skip for Now, Create and Open the Chat, Check Again; Show on
  Canvas; Send Again; Accept Edits.
- R5. Keys are in tooltips, not written on screen: Change Folder's footer and the suggestions panel.
- R6. Scrolling to a sent message honours Reduce Motion.
- R7. Removing an attached image is a 24px target with a name that says which.
- R8. Preferences' list holds only tabs for a screen reader, and the Phone page's on dot says On.
- R9. A focused text field shows it, beyond the caret.
- R10. Scrolling a long chat does not measure every row above the view.
- R11. `docs/design.md` describes the focus ring that ships.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **The marker is the fill's ink.** A chosen option is drawn on the affirmative fill, which is the accent, so its
  marker takes `--loki-on-affirm`. (R1)
- KTD2. **Red is `--loki-negative` with the window's ground as ink**, so it holds contrast in both themes. (R2)
- KTD3. **A field's focus is its edge in the accent**, not a ring: the bare first line of a sheet, which is focused
  whenever the sheet is open, and the phone's fields (iOS shows the caret alone) keep theirs. (R9)
- KTD4. **The row being read is found by halving.** The outermost rows stack in order, so their bottoms rise in
  order and a binary search finds the first one below the view's top; a row inside another is skipped, as its own
  row comes first. (R10)
- KTD5. **Not done here:** the title menu on Base UI's Menubar (its own PR); the step filter the audit counted twice is
  the phone's only (the desktop's thread draws `item/work.tsx`'s), so it stays.

---

## Verification Contract

`npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:node`, then
`npm run build:app && npm run build:mod && npm run smoke`. In the worktree's Vite: a focused field in Preferences,
Change Folder's footer, light and dark.
