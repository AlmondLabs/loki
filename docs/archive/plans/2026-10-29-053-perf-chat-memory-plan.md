---
title: What the app keeps of the chats it has opened
date: 2026-10-29
status: dropped
---

# What the app keeps of the chats it has opened

## Why

The scan on 2026-10-28 listed "chats the app never closes, and widget iframes" as a memory cost. The app keeps a live
record for every chat it opens or follows, and lets none of them go until the window reloads. On the daemon, the newest
30 chats and every chat shown are opened and never closed.

This plan records what that costs, measured on one person's real chats. The measuring scripts read the running daemon
with `inbox_list`, `history_get` and `history_step_get` only, and printed sizes and timings, never content. Nothing was
changed: the cost was judged too small for the risk of the fix.

## Measured

1. **Loaded threads: about 6 MB.**
   - The real `ChatStore` and `ThreadModel` (`core/attention/`) were run in Node, each of the 39 open chats was shown
     once, and the heap was compared before and after, with garbage collection forced.
   - It held 5.9 MB, 0.15 MB a chat, and 5.7 MB came back when the store was dropped.
   - The newest page of those chats came to 3.2 MB as JSON: median 79 KB, largest 268 KB.
   - Threads stay small because a page is lean: a tool row's input and output come only when opened (plans 041 and 043).
2. **Live tails: about 2 MB of JSON a day.**
   - Rows that stream in while a window is open keep the tool's whole output (`ThreadModel.result` in
     `core/attention/thread.ts`), and nothing trims them until the window reloads.
   - A whole tool row averaged 2.7 KB against 0.3 KB lean, over 5,207 tool rows. That is about 17 KB of tool rows per
     message the person sends.
   - The person sent 106 messages on 2026-10-27 and 119 on 2026-10-28. At that pace a window grows by about 2 MB of
     JSON a day; in memory that is a few MB.
   - This is the only part that keeps growing. It applies to every chat the app follows, the newest 30 included, even
     those never shown.
3. **The daemon: nothing worth closing.** Opening a chat on loki's own engine follows its store commits
   (`LokiEngine.watch`); an ACP chat's `open` only reads its state. Neither starts a process.
4. **Widget iframes: no build-up.** A chat's canvas stays mounted behind its Messages tab (hidden, not removed), but
   switching chats replaces it, so iframes do not gather across chats.
5. **Fetching a thread again takes 2 ms.** That was the median for the five biggest chats' newest page, 7 ms at most,
   on the same Mac. Letting go of a thread would cost that on the way back to it.

## The fix considered, and why not

1. **The fix:** keep the threads of the last five chats shown, and let go of any other chat's thread once it is idle
   (no turn running, nothing queued).
   - That would cap the loaded threads at a few hundred KB and stop the tails growing.
   - Showing a chat already fetches its newest page again (`use-desk-chat.ts`), so a thread let go would cost only that
     fetch.
2. **Why not:**
   - The saving is a few MB, plus a few MB a day for a window left open.
   - The risk sits in the thread model's edge cases: a reply still streaming, the echo of a message just sent, a
     command left running.

## If it comes back

Do it if a window open for days is seen to grow by tens of MB, or if a lean live row becomes possible (a tool result
that carries its row number, so its output can be fetched when opened like a page's).
