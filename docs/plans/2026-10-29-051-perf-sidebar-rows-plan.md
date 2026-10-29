---
title: A chat's row redraws only when it changes
date: 2026-10-29
status: active
---

# A chat's row redraws only when it changes

## Why

Plan 047 found that a running agent changes the chat list on each tool round (the row's time and its preview), so the
list must render then. But the list redrew every row, not just the one that changed. `DeskSidebar` built each `ListRow`
with new handlers and new elements (`onOpen`, `onMenu`, `actions`, `flags`) on every render, so React could not skip
any of them.

Measured in the dev build, in the built-in browser, with a demo daemon of 105 chats over three agents (108 rows), while
another client toggled one chat's done mark ten times, a second apart:

| | rows drawn per change | sidebar render, median |
| --- | --- | --- |
| before | 108 | 33.3 ms |
| after | 0 | 3.7 ms |

The done mark of an empty chat leaves its row as it was, so after the change no row draws. Pinning a chat draws the one
row that moved, and opening one draws the row that becomes current.

## What changes

1. **`ChatRow`**, a memoised row in `desk-sidebar.tsx`, takes only plain values (title, time, badge, marks, whether it
   can be pinned or archived, where it lives) and handlers that take the chat's scope.
2. **The handlers stay the same functions** from render to render: they read the latest desks and callbacks from a ref
   and look the chat up by its scope when called.

## Left as it is

The pills' measure stays in a layout effect. It reads the boxes of the rows waiting on you, which are few, and the
browser lays the list out before painting anyway; moving it to the next frame would draw the pills a frame late. That is
a judgement from reading the code, not a measurement.

## Checked

1. The table above: a counter in `ListRow` and React's own render times, removed afterwards.
2. By hand, in the same page: pin and unpin act on the right chat, the row's menu opens at the row with its actions,
   and opening a chat makes it the current row.
3. There is no component test: the repo's tests run without a DOM.
