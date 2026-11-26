# Plan: the sidebar stays where it helps

2026-11-14

## Why

The design review of 2026-11-14 (`.impeccable/critique/2026-11-14T03-14-55Z__app-src.md`) found the sidebar empty or
gone exactly where it should help. Mail's sidebar always lists its mailboxes with their counts; Finder keeps its
sidebar whatever the view; macOS folds a sidebar only when the window is too narrow for both panes. loki does three
things otherwise:

1. **Flow has no list.** `ListColumn` has sections for Chats, Agents and Learn and none for Flow, so the sidebar shows
   the four places and nothing under them, while the lanes hide in the title's menu (`LaneSwitch` in
   `desk/catch-up-parts.tsx`).
2. **Canvas hides it.** `sidebarHidden` (`desk/pane.ts`) gives the canvas the whole window, so switching a chat's tab
   takes away the way to every other chat, and the Flow badge with it.
3. **It folds below 1100.** `NARROW_BELOW` in `shell/column.ts` folds the sidebar in any window under 1100 wide, which
   is most windows on a 13-inch Mac beside another app.

## Decided

The person asked for all three, 2026-11-14.

1. **Lanes are sidebar rows in Flow.** Under the places, a "Lanes" list: Everything, the person's lanes, then one per
   agent with cards, each with the count of cards that need the person (the same count as the Flow badge, so the
   rows add up to what the badge says), the active one chosen, and New Lane… at the end. Choosing a row switches the
   lane, as the menu does. The title's menu stays, as Mail keeps its mailbox menu in the toolbar too; it is the same
   list, so a lane the menu shows the sidebar shows.
2. **Canvas keeps the sidebar.** The canvas fills the pane beside it, as it does beside the chat inset; ⌃⌘S still
   folds the sidebar for a wider canvas, and that choice is kept.
3. **Fold below 800, not 1100.** At 800 the pane keeps about 520 for the thread with the sidebar at its narrowest
   (220), which still reads; under it the sidebar folds as today, and the toggle peeks it.

## Where

`desk/flow-column.tsx` (new, the lanes list, with `flowLanes` pure for its test), `shell/shell.tsx` (the Flow section),
`desk/pane.ts` (`sidebarHidden` goes), `shell/column.ts` (`NARROW_BELOW`), docs/design.md and docs/manual.md. Tests:
the lane rows and their counts, the Canvas tab keeping the column, and the new fold.
