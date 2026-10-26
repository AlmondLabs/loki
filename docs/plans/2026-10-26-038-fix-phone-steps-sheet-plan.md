---
title: The phone's steps sheet reads like Claude's
date: 2026-10-26
status: active
---

# The phone's steps sheet reads like Claude's

## Why

On the phone, a run of the agent's work opens as a bottom sheet of its steps. Each row put the step's target first:
for a command, the command itself. A long path has no place to break, and the sheet is a grid whose one column was as
wide as its widest line, so the column, the title and every row ran off the right edge of the screen. pi's shell tool
is `bash` in lowercase, which the wording did not know, so a command read "Used bash" instead of "Ran". The person
asked for the sheet to read like Claude's app.

## What changes

1. **Rows**: the kind of step on top ("Ran", "Read memory", "Asked an agent"), what it was for under it on one line,
   cut with an ellipsis, and a chevron that says the row opens. The desktop list keeps its order.
2. **Header**: the close or back button, then the title, left-aligned. A step's page is titled by its tool ("Bash",
   "Memory read", an MCP tool as `server.tool`, `stepTitle`), not by its long description.
3. **No overflow**: every phone sheet's grid has one column the sheet's width (`minmax(0, 1fr)`), so a long line
   wraps or cuts instead of widening the sheet.
4. `bash` reads as a command: "Ran", with the terminal icon.

## Checked

A scratch page at 390 px with long made-up commands: the sheet is 390 px wide and no element reaches past the right
edge; screenshots of the list and a step's page.

## Tests

`test/tool-steps.test.ts`: `bash` reads "Ran" with the terminal icon; `stepTitle` for a shell, a memory and an MCP tool.
