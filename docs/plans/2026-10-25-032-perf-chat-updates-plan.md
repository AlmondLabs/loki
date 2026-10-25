---
title: A streaming chat updates its own thread, not the whole app
date: 2026-10-25
status: active
---

# A streaming chat updates its own thread, not the whole app

## Why

A read-only audit of the app on 2026-10-25 (no symptom reported; the person asked for the likeliest costs) found that
while any chat streams a reply, the whole app redraws up to seven times a second:

1. **Every event from any chat wakes everything.** `useAttention`'s `bump` (`core/attention/use-attention.ts`) copies
   the map of every chat's live state on each flush (150 ms). That makes `items` and `conversation` new, so the object
   the shell hands everywhere is new, and the sidebar, the Inbox, the hidden chat pane and the open transcript all
   render again. The sidebar re-sorts and measures its rows each time.
2. **The transcript's memo never holds.** `ThreadModel.rows()` (`core/attention/thread.ts`) builds a new array on
   every call, so the transcript walks the whole thread (timeline, day pills, runs) and its inline widgets are new on
   every render, including every keystroke in the composer.
3. **Each streamed piece moves the chat's last-message time** (`applyChatEvent`, `core/attention/model.ts`), so the
   list really does change on every piece: the sidebar re-sorts, and the open chat sends a `viewed_mark` for each new
   time (`viewStamp`), a frame to the mod several times a second.

## What changes

1. **`rows()` hands back the same array until the thread changes.** It is cached by the thread's `revision`, which
   every change already moves.
2. **A chat's list face and its thread are published apart.** The face is what the list and the chat box read: loop,
   turn, approval, question, error, last role, time, words and asker, mode, folder, engine, whether a reply streams
   (`faceOf`, `core/attention/model.ts`). On each flush `useAttention` compares every chat's face with the one it last
   rendered; only when one moved does it copy the live map (so `items` and `conversation` change). Then it tells the
   thread watchers, and each one whose rows changed renders.
3. **A thread is read where it is drawn.** `useThreadRows(chats, agentId, conversationId)` watches one chat's rows
   (`useSyncExternalStore` on the cached array); `useConversation` adds the face to them. `conversation()` keeps the
   face only, so a caller that skipped the hooks fails to compile rather than showing stale rows. The hook sits as low
   as the rows are needed, since whatever calls it redraws with each piece:
   1. the desk: `DeskMessages` (the Messages tab's thread, its New line and widget rows) and the Canvas tab's inset
      chat (`DeskChat`); `DeskPane` itself, with the header, the tabs and the Canvas, reads only the face;
   2. the desktop Inbox: the card, not the deck around it;
   3. the phone: the conversation page and each card. `ConversationScreen` uses the rows all through, so the page
      still redraws whole with each piece; splitting it is a later change.
4. **The message box no longer redraws with the thread.** Inside `Conversation` the box read `view` itself (for its
   placeholder and send label), so the React Compiler kept the whole box under a memo keyed on `view`, which is new
   with every piece; it reads `status`, `approval` and `question` instead. And `useSlashPalette` answered a draft
   that is not a command with a fresh `[]`, which made its key handler, and so the whole box, new on every render.
5. **The last-message time moves when a reply starts, not with every piece.** A whole message, a call, a result and
   the turn's end move it as before; the turn's end sets it to the end.

Nothing changes on screen except that the time beside a chat in the sidebar shows when its reply started until the
reply ends, instead of ticking with each piece.

## Decisions for review

1. **One watcher set, not one per chat.** Every thread watcher is told on each flush and compares its own rows; with
   the rows cached that is a pointer compare per watcher, and there are a handful on screen. A per-chat registry would
   save nothing measurable.
2. **The face is compared each flush across every chat this client follows** (the 30 newest and any opened), instead
   of having every `bump()` say which chat it was for. Many callers bump with no chat at hand (decide, answer, mode);
   the compare is a few fields each.
3. **A chat the rendered map has never held counts as a face change**, so a chat seen for the first time always
   reaches `items` and `conversation`.

## Tests

1. `test/thread-model.test.ts`: `rows()` is the same array between changes and a new one after each kind of change
   (a streamed piece, a settle, a result onto a page row, a load).
2. `test/attention-model.test.ts`: streamed pieces after the first leave the last-message time alone and the face
   unchanged; the first piece, the turn's end and an approval move it.

## Measured

On a throwaway daemon with made-up chats and a fake provider streaming a 600-word reply over about 15 seconds, the
desktop page counted every component React rendered (a counter on the DevTools hook, React Scan on in both builds):

| while a reply streams…                   | before (25b40c7) | after |
| ---------------------------------------- | ---------------- | ----- |
| in another chat: components rendered     | 4,809            | 510   |
| ↳ the open chat's transcript             | 81               | 8     |
| in the open chat: components rendered    | 5,292            | 1,445 |
| ↳ shell, chat pane, message box (each)   | 81               | 8     |
| ↳ sidebar rows                           | 324              | 32    |
| ↳ thread and the streaming message (each) | 81               | 82    |

What still redraws per piece is the thread and the message being written; everything else redraws only on the
chat's face changing (the turn starting, the reply starting and settling, the turn ending).

## Not in this change

The audit's other findings (history paged by cursor, tool output capped in the daemon, the bundle split, widget frames
mounted lazily, the streaming reply parsed by block) are separate changes.
