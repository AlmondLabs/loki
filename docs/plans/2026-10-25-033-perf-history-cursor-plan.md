---
title: History in pages by position, folded once
date: 2026-10-25
status: active
---

# History in pages by position, folded once

## Why

The audit of 2026-10-25 (plan 032 has the first part of it) found that reading back through a long chat gets slower
the further you go, and that opening a chat again costs as much as the first time:

1. **Each older page resends everything loaded.** `loadOlder` (`core/attention/use-attention.ts`) asks `history_get`
   for a limit 400 larger each time (400, 800, 1,200 …), and the daemon answers with all of them in one frame. The rows
   sent grow with the square of the pages read, and a row carries a tool's input and output (up to 4,000 characters
   each), so a deep scroll is a frame of many megabytes.
2. **Every page folds the whole chat from its first entry.** `ChatProjection.page()` (`daemon/chats.ts`) runs
   `foldSteps` over every step of every entry, then keeps the last `limit` rows: a synchronous walk of the whole log on
   the daemon's one thread, for every open and every page.
3. **Opening a chat again replaces every row.** The app fetches the chat's whole loaded window again and
   `ThreadModel.load` builds new row objects for all of it, so every row's memo misses and its markdown is parsed again.

## What changes

1. **The daemon folds each chat once, as it grows.** A chat keeps one `ThreadModel` and how many entries it has folded;
   a page folds only the entries since. Entries only ever arrive at the end (a reopened store builds the chat anew), and
   entry steps never stream, so this is the same fold `foldSteps` does, done once. Only chats someone reads are folded.
2. **A page is asked for by position.** A row's position is its index in the chat's whole thread, stable since rows
   are only added at the end. `history_get` takes `before` (the position of the oldest row the reader has) beside
   `limit`; the reply carries `start`, the position of its first row. Without `before` it is the newest `limit` rows, as
   now.
3. **The app pages by position.** An older page asks for the 400 rows before the oldest loaded and puts them in front
   (`ThreadModel.prepend`). Opening a chat again asks for the newest 400 only: the rows loaded before it are kept in
   front of them, and a row that has not changed keeps its object, so its memo holds.
4. **A Mac that does not send `start`** (one paired Mac on an older loki answers for its chats) gets today's behaviour:
   the window asked for whole, replacing what was loaded.

## Decisions for review

1. **Position, not an id.** Rows have no ids of their own (several come from one entry, and a tool's row takes its
   result from a later one), and the position is what the fold already knows. It holds as long as rows are only added
   at the end, which the projection guarantees until a store is reopened; a page then may repeat or skip a row at the
   seam until the chat is opened again.
2. **The folded rows stay in memory** for every chat that was read since the daemon started, beside the steps the
   projection keeps already. They are smaller than the steps (a tool's output is cut to 4,000 characters), and nothing
   is folded for a chat nobody opens. Dropping them for chats nobody follows belongs with the audit's memory finding.
3. **Unchanged rows are found by value** when a chat is opened again: same position and the same fields, the tool step
   compared as JSON. That is a few hundred comparisons per open, against a markdown parse per row.

## Measured

A throwaway daemon with a chat of 3,001 rows (1,500 turns with short made-up answers, no tool output), read over
the socket as the app reads it: the newest 400 rows, then older pages until the first row, then the chat opened again.

|                                   | before (grow the limit) | after (by position) |
| --------------------------------- | ----------------------- | ------------------- |
| rows sent reading back to the top | 14,201                  | 3,001               |
| bytes sent reading back to the top | 3.3 MB                 | 0.7 MB              |
| daemon time reading back          | 40–49 ms                | 10–15 ms            |
| opening the chat again            | 698 KB, 5 ms            | 93 KB, 1 ms         |

The time after is mostly the first read folding the chat once (10 ms); each page after it takes about 1 ms. The rows
sent before grow with the square of the pages, so a chat with tool output, or twice as long, widens the gap. A reader
of this version talking to the old daemon gets no `start` back, falls back to the growing limit and still reaches the
top.

## Tests

1. `test/chat-projection.test.ts`: a page by position returns the rows before it and where they start; pages put
   together equal the whole fold; folding as entries arrive equals folding them all at once.
2. `test/bridge.test.ts`: `history_get` passes `before` on and answers with `start`.
3. `test/thread-model.test.ts`: `prepend` puts older rows in front and leaves the rows since alone; `load` with a
   position keeps the older rows in front and the objects of rows that did not change.
