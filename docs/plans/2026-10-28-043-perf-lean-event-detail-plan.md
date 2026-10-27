---
title: A history page without long event results
date: 2026-10-28
status: active
---

# A history page without long event results

## Why

Plan 041 sent tool rows lean and left event rows whole: the line loki shows when a background task finishes or a
skill loads, whose `detail` is the task's whole result or the skill's text. It measured one page at 506 KB with 374 KB
of it event detail and called that the next step. Measured across every chat on 2026-10-28, it is more than one page:

1. 784 event rows in the newest page of 183 chats carry a detail. The median is about 2,000 characters, the longest
   102,000, and 525 are longer than 1,000.
2. In the pages heaviest in events, event detail is 50–87% of the page as it travels today.
3. The window draws none of it until the line is opened, and draws the closed `<details>` with it inside all the same.

## What changes

1. **A page sends long event details lean.** `leanPage` leaves out an event's `detail` when it is longer than
   `LEAN_DETAIL_MAX` (1,000 characters) and sets the row's `row`, its position in the chat's log, as it does on a tool
   step. A shorter detail travels with its page, since it costs less than the round trip that would fetch it.
2. **The step request answers it.** `history_step_get` now answers `{ step, detail }`: a tool row's step, or an event's
   detail, each null when the row is not that. The daemon hands the frame the whole row (`ChatSource.row`, which
   replaces `step`), so one request serves both and no second mechanism is added.
3. **Opening the line fetches it.** The window's one fetch hook (`useWhole` in `app/src/chat/tool-steps.tsx`) fills a
   lean tool step or a lean event: in a stretch of steps (desktop and phone sheet) and on an event's own line in the
   thread, which now draws its detail only once opened. "Loading…" until it comes, "could not load this step" with
   try again when it does not.
4. **Live rows are untouched.** Events that arrive during a turn carry their detail, as before; only pages are lean.

## Decisions

1. One threshold, `LEAN_DETAIL_MAX` = 1,000 characters, next to `LEAN_LINE_MAX` in `core/attention/transcript.ts`.
2. **The trade, named.** A page is smaller and opens faster with less memory held for lines never opened; an opened
   long result costs one round trip: 0–4 ms on this Mac and 8–19 ms to the Mac mini over Tailscale, measured below.
3. **What is lost:** find in a chat (`findStart`) no longer searches a lean event's result until it is opened, as it
   already did not search a lean tool step's output since plan 041.
4. A Mac on a loki from before this plan sends events whole and answers `history_step_get` without `detail`, which the
   window reads as none; it never sends an event lean, so it is never asked for one.

## Measure

Read-only, with scripts in the scratchpad that ask `history_get` as the window does and apply this branch's
`leanPage` to the same reply. Before is the page as this Mac's daemon sends it today, with plan 041's lean tool rows.

Measured on 2026-10-28 on the MacBook Pro, the pages heaviest in event detail:

| Where    | Rows | Before | After  | Saved | Page time |
| -------- | ---- | ------ | ------ | ----- | --------- |
| this Mac | 400  | 506 KB | 132 KB | 74%   | 9 ms      |
| this Mac | 349  | 390 KB | 107 KB | 72%   | 9 ms      |
| this Mac | 133  | 382 KB | 49 KB  | 87%   | 6 ms      |
| this Mac | 400  | 307 KB | 144 KB | 53%   | 5 ms      |
| this Mac | 400  | 301 KB | 147 KB | 51%   | 7 ms      |
| this Mac | 228  | 230 KB | 71 KB  | 69%   | 7 ms      |
| this Mac | 81   | 188 KB | 32 KB  | 83%   | 3 ms      |

The Mac mini still runs a loki from before plan 041, so its pages travel with whole tool rows. With plan 041 applied
to the same reply and then this plan:

| Where    | Rows | As sent | Plan 041 | Plan 041 + 043 | Saved by 043 | Page time |
| -------- | ---- | ------- | -------- | -------------- | ------------ | --------- |
| Mac mini | 305  | 618 KB  | 246 KB   | 93 KB          | 62%          | 232 ms    |
| Mac mini | 400  | 418 KB  | 258 KB   | 112 KB         | 57%          | 91 ms     |
| Mac mini | 104  | 194 KB  | 143 KB   | 39 KB          | 72%          | 128 ms    |
| Mac mini | 314  | 514 KB  | 166 KB   | 114 KB         | 31%          | 116 ms    |

Across the newest page of all 183 chats, 13,416 KB as sent today becomes 5,472 KB. A step request takes 0–4 ms on
this Mac and 8–19 ms to the Mac mini.

## Tests

1. `leanPage` sends an event's long detail lean with its position, and a short one, or none, whole
   (`test/thread-model.test.ts`).
2. `history_get` sends a long event lean; `history_step_get` answers a tool row's step, an event's detail, and nulls
   for any other row or none (`test/bridge.test.ts`).
3. The window: a lean event waits for its detail in a stretch of steps and on its own line, and a whole one shows its
   own (`test/thread-load.test.ts`).

## Not in this plan

1. Searching the text of rows a page left out.
2. Events that stream in live stay whole, as tool rows do.
