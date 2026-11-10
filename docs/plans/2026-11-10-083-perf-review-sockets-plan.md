# Plan 083: sockets, from the November review

2026-11-10

## Why

The review's speed and memory findings, checked against this Mac before anything was changed. Two were worth doing
without the app in hand; the others are measured below and left.

## What changes

1. **A request made before the socket is open goes out as it opens.** `request()` retried on a 250 ms timer, so a
   chat's history was asked for up to 250 ms after the socket was ready, and each waiting request ran a timer of its
   own. `RequestWaiters.hold` keeps the frame and `flush`, called in the socket's `onopen`, sends it. Not measured in
   the app: the saving is the timer's wait, 125 ms on average, on each chat opened on the desktop.
2. **A socket has limits** (`mod/server.ts`): a frame of at most 32 MB (the library allows 100 MB, and a frame is
   parsed whole on the daemon's one thread); a ping every 30 seconds, ending a socket that did not answer the one
   before; and at most 16 MB waiting unsent on one socket. Before, a phone that left the Wi-Fi stayed in the list of
   sockets until TCP gave up, and every push meanwhile was kept in memory for it.

## Measured and left

1. **The widget frame's script is 852 KB, 620 KB of it recharts and what recharts needs** (d3, redux toolkit, immer,
   es-toolkit); react-dom is 210 KB and loki's own code 8 KB. Each `.tsx` widget loads all of it. A second frame
   document without recharts, picked for a widget that imports no chart, would bring that to about 230 KB with no
   change to the sandbox; it needs trying in the shell, the browser tab and the phone, so it is not in this change.
2. **The state files are small.** After a month of use on this Mac the largest are `inbox-ledger.jsonl` (436 KB,
   appended), `usage.json` (383 KB) and `attention.json` (119 KB); account threads are 804 KB in all. Nothing here is
   megabytes rewritten per mail. What is large is `stores/` (2.1 GB), `tool-results/` (116 MB in 367 files) and
   `logs/events.jsonl` (10.6 MB, never rotated). Pruning any of them deletes something a chat may point at, which is
   the person's decision.
3. **What the page holds for chats no longer open** was not measured: it needs a heap snapshot of the running app.
4. **The peer link has no heartbeat of its own.** It is ended from the other Mac's side by the ping above; noticing a
   sleeping Mac from this side needs both Macs to ping, and a Mac on an older build would not.

## Tests

`request-waiters` (held frames go out once, at the open) and `server` (a frame past the limit, a socket that stops
answering pings, a socket with too much unsent).
