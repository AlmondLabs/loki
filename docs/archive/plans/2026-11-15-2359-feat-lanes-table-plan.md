---
title: Lanes as a System Settings table - Plan
type: feat
date: 2026-11-15
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Lanes as a System Settings table - Plan

---

## Goal Capsule

- **Objective:** Preferences › Flow's lanes read as System Settings lists things: a row per lane saying what it shows,
  and the editor out of the page, in a sheet.
- **Means:** `app/src/settings/lanes.tsx` only; the lanes, what is saved and how it is shared do not change (plan 087).
- **Authority:** the Requirements, then the Key Technical Decisions.
- **Stop conditions.** Stop and ask if the change needs anything from the mod or the daemon.
- **Execution profile:** one settings part and its tests; one PR.
- **Who finishes:** `ce-work` on branch `feat/lanes-table`.

---

## Product Contract

### Requirements

- R1. Each lane is one row of the Lanes group: its name, a line on what it shows, and Edit…; an empty list says Flow
  shows all your work until you add one.
- R2. Add Lane… sits under the rows; it and Edit… open the editor in a sheet, with Cancel and Save, Return saving and
  Esc cancelling.
- R3. A saved lane's sheet has Delete Lane…, apart at the left, which asks once more before it deletes.
- R4. A name that is missing or taken is refused in the sheet, which stays open; nothing is sent until Save (plan 087).

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Rows, then a sheet, as System Settings and the HIG's lists do.** The two-column list-and-editor had the
  editor's controls fill the page beside a column of buttons. A row per lane keeps the page a list to scan (Lists and
  tables: succinct rows, the detail elsewhere); the editor is loki's one dialog (`Sheet`), over Preferences, as Rename
  is over a chat, so focus goes back to the row's Edit… when it closes. (R1–R3)
- KTD2. **A row's line says what the lane shows.** Chats by agent name, an agent this Mac does not know counted as
  another Mac's (a lane can hold one, plan 087 KTD2), then mail and Slack by how many accounts, since the accounts are
  read only while the sheet is open (`laneSummary`). (R1)
- KTD3. **The workbench shows it.** Lanes need the mod, which a dev server without the daemon lacks, so `?workbench`
  draws the table with made-up lanes and accounts, sheet included.

---

## Verification Contract

`npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:node`, then
`npm run build:app && npm run build:mod && npm run smoke`. In the worktree's Vite at `?workbench`: the rows, Edit…
opening the sheet with focus in the name, a taken name refused, Return saving and focus back on Edit…, Esc closing Add
Lane…'s sheet, Delete Lane… asking once more.
