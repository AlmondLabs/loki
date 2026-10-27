---
title: A history page without tool output, and a chat that says it is loading
date: 2026-10-27
status: active
---

# A history page without tool output, and a chat that says it is loading

## Why

Opening a chat that lives on another Mac showed "nothing here yet" for a chat with hundreds of messages. Two causes,
measured on 2026-10-27 between a MacBook Pro and a Mac mini over Tailscale:

1. **A history page is mostly tool output.** A page is the newest 400 rows (`HISTORY_PAGE`), and every tool row
   carries its call's input and output, up to 4,000 characters each (`TOOL_TEXT_MAX`). In a Claude Code chat the
   command is there three times: the row's label, the step's name and its input. One page of ira's
   "townhall.ai -> v0" was 1,390 KB, 1,341 KB of it tool rows (label 304 KB, name 285 KB, input 244 KB, output
   420 KB); "[CC] - townhall.ai -> design iterations" was 914 KB. The window draws none of that until a step is opened.
2. **The window gives up on a page after 8 seconds and draws it as empty.** `loadHistory` answers `{ rows: [] }` on a
   timeout, which the thread shows as a chat with nothing in it. The first pages from the Mac mini took 5 to 22
   seconds, so they read as empty chats. The desk view also turns "not loaded yet" into an empty list, so even a load
   in flight says "nothing here yet".

## What changes

1. **A page sends tool rows lean.** `history_get` keeps a tool row's label and its step's name to one line of at most
   200 characters, and leaves out the input and output. Its step gets `row`, the row's position in the chat's log;
   the description, `failed` and `error` stay, so the closed line and a failed step's red line are as before.
2. **Opening a step fetches it.** `history_step_get { conversation_id, row }` answers with that row's whole step, from
   the Mac the chat lives on (routed like `history_get`). The step shows "loading…" until it comes, and "could not
   load this step" with a way to try again if it does not.
3. **Live rows are untouched.** Rows that stream in during a turn carry their input and output as they do now; only
   pages are lean. Code that looks for a call still waiting for its result counts a lean row as finished.
4. **The window waits, then says so.** A page waits 30 seconds, not 8. Until it arrives the thread says "loading the
   thread…" ("loading from <Mac>…" for a chat on another Mac). When it does not arrive, it says "could not load this
   chat" (from <Mac>) with "try again", and an empty chat is only one whose page came back empty.

## Measure

Page size before and after, for the same chats on this Mac's daemon and through the link from the Mac mini, with a
script in the scratchpad that asks `history_get` as the window does and applies `leanPage` to the same reply.

Measured on 2026-10-27, the four largest pages on the MacBook Pro and three of ira's chats on the Mac mini:

| Where    | Rows | Before   | After  | Saved | Page time |
| -------- | ---- | -------- | ------ | ----- | --------- |
| this Mac | 400  | 1,084 KB | 143 KB | 87%   | 21 ms     |
| this Mac | 400  | 1,045 KB | 506 KB | 52%   | 35 ms     |
| this Mac | 400  | 981 KB   | 175 KB | 82%   | 9 ms      |
| this Mac | 400  | 976 KB   | 182 KB | 81%   | 6 ms      |
| Mac mini | 400  | 1,392 KB | 161 KB | 88%   | 8.0 s     |
| Mac mini | 400  | 917 KB   | 149 KB | 84%   | 6.5 s     |
| Mac mini | 196  | 227 KB   | 119 KB | 48%   | 2.4 s     |

The page that stays at 506 KB is mostly event rows' `detail` (374 KB), the results of background tasks.

## Tests

1. A page's tool rows are lean, with their position; `history_step_get` answers the whole step at that position; an
   event or message row is sent whole.
2. A lean row in a loaded page does not take a live approval or result meant for a newer call.
3. The window: a page that fails leaves the chat unloaded with a retry, not empty; a lean step fetches on open.

## Not in this plan

1. Event rows with a long `detail` (a background task's result) stay whole. They are few in most chats, but one
   measured page keeps 374 KB of them; sending them lean the same way is the next step if that chat is slow to open.
2. A Mac on an older loki still sends whole rows, which the window draws as before.
