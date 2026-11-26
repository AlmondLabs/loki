# Suggestions in a bigger modal, their text as markdown

2026-10-30 · follows plan 052 (suggestions behind a chip in the message box)

## Why

Plan 052's popover above the box is 460 px wide and 420 px tall, and its rows are one line each: on the phone a
title and its target were both cut to a few words. A suggestion's message is often several sentences, a list, or a
path, and it showed as plain text. The person asked for a bigger modal and the text rendered as markdown.

## What

1. **A modal, not a popover.** The chip, ⌘⇧S, `/suggestions` and the Inbox card's mark open the suggestions in a
   modal sheet centred over the window on the desktop (720 px wide, up to 84vh tall, the list scrolling inside it),
   and in a bottom sheet up to 92vh on the phone. A header names it: "Suggestions", how many wait, and "esc closes".
   Esc, a click on the veil, or close shuts it; focus goes back to what opened it.
2. **Rows that read whole.** Each row is the title on its own line, wrapping, and where it goes on a line under it,
   never cut short. The newest opens by default, so the modal shows a message at once; opening another closes it.
3. **Markdown.** A suggestion's message renders as the transcript renders an agent's reply (react-markdown with GFM,
   the `loki-md` styles): lists, code, links and emphasis. The title stays plain text.

The chip, its place in the box, the four actions, the Inbox mark and the ticks stay as plan 052 made them.

## How

`app/src/chat/suggestion-card.tsx`: `SuggestionPanel` draws a `Sheet` on both (centred on the desktop, portalled to
the body as the rename dialog is; bottom on the phone) with a header; the popover and its own outside-click and focus
code go, since the Sheet does both. The card's text becomes `loki-md` markdown. CSS in `chat.css` and `phone.css`.
The manual's suggestions section says modal instead of popover.

## Checks

Unit tests: the modal and its header draw on the tick, the newest opens by default, the text renders markdown (a list
becomes `<ul>`), the title stays text. Seen by eye on the desktop and the phone with made-up demo data.
