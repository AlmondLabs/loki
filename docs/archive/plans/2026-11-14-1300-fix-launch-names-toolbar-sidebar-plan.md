# Plan: launch, accessible names, one toolbar, the sidebar's leftovers

2026-11-14

## Why

Four findings from the design review of 2026-11-14 (`.impeccable/critique/2026-11-14T03-14-55Z__app-src.md`) that
plans 2026-11-14-0852 and 2026-11-14-1130 left. The person asked for all four on 2026-11-14; ⌘[ ⌘] as Back and Forward
waits for its own decision.

## 1. Launch lands somewhere real

A window with no chat remembered held the desk's shared scope, which the pane drew as a chat called "shared", "no
agent", "Loading the thread…" forever. Mail opens on the Inbox, Notes on the last note; none opens on an empty room.

**Built.** `shell/landing.ts` decides once per window, once the chats and Flow's cards have come: Flow when something
waits on the person, else the chat they were in most recently, else nothing. With nothing, the pane says "No Chat
Selected" with **New Chat**, and the shared scope is never drawn as a chat.

## 2. Accessible names

The review read Archive's name as "done with this thread: …". Chrome's accessibility tree says otherwise: every
button's name is its visible word, and the sentence is its description (the tooltip), as Apple's VoiceOver hints are.
What was wrong was smaller:

- No button told a screen reader its key; the key was only in the tooltip's words. `ariaShortcut` in
  `shell/keymap.ts` turns a shown key back into `aria-keyshortcuts` through the same tables `formatKeys` writes with, and
  `Button`, Flow's moves, the places and the sidebar toggle carry it.
- About twenty names, tooltips and placeholders behind a choice (`copied ? "copied" : "copy as markdown"`) were
  lowercase; `test/words.test.ts` missed them because it read only plain strings. It now reads both sides of a choice,
  however deep, and a template's opening words.

## 3. One toolbar on every pane

The chat had a Mac toolbar (its name over a grey line of facts, its controls at the trailing edge); Flow had a small
label and a run of numbers, Agents a face and a hint beside the name, Learn a large title inside its column.

**Built.** Every pane's header is `PaneHeader` with `ToolbarTitle` as its line, at the pane's top:

- Flow: the lane's name, still the menu that switches it (the sidebar lists the same lanes, and the menu serves when
  the sidebar is folded), over "6 need you · 17 chats" with the blue dot while something needs you, and the quiet
  count of other lanes.
- Agents: the agent's name over what the page shows ("What it knows, file by file"), the pages as the segmented
  control at the trailing edge, as the chat's Messages and Canvas are; New Agent the same, as New Chat is.
- Learn: "Learn" over its counts (due, cards, leads, deleted), the due count led by the blue dot.

## 4. The sidebar's leftovers

- **A heading that repeats the place above it** ("Chats" under Chats, "Agents" under Agents, "Learn" over "Views")
  is said to a screen reader only (`ColumnHeader quiet`); its "+" keeps the trailing edge. Learn's list starts at its
  Views. Flow's "Lanes" says something new and stays.
- **Update Available** leaves the sidebar's foot: a newer loki is said once per version, as a notice with
  **Update…** (Preferences › loki) and **Later**; Preferences keeps saying it while it is newer.
- **Rows are titled in full ink**, as Mail's messages are; what is new keeps its weight and its marks.
