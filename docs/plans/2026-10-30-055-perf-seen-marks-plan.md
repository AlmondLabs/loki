---
title: A mark sends only its own chat's marks
date: 2026-10-30
status: active
---

# A mark sends only its own chat's marks

## Why

Every mark sends the whole `seen` frame, with all four maps: done, viewed, focus and rests. That covers a done or
not-done mark, a look at a chat, an answer or a decision, a rest from Next, and every message the person sends. The
frame goes to every window, every phone and every paired Mac.

Measured on one person's real marks, read-only from the running daemon:

1. **The frame is 64 KB.**
   - Done: 161 chats, 17.2 KB.
   - Viewed: 56 chats, 6.1 KB.
   - Focus: 19 chats, 2.8 KB.
   - Rests: 53 chats, 37.9 KB.
2. **One chat's marks alone are about 290 bytes.**
3. **How often:** the person sent about 110 messages a day on 2026-10-27 and 2026-10-28, and each one marks its chat.
   Every chat opened marks a look too. At a few hundred marks a day, each phone receives several MB a day of marks it
   already had, over Tailscale when away from home.
4. **A paired Mac also re-reads the whole chat list on every mark.**
   - `seen` is marked as changing the lists (`lists` in `core/frames.ts`), so a paired Mac that hears one fetches this
     Mac's chats again (`RemoteChats.heard`): the desks and the Inbox, about 108 KB here.
   - A Mac's chat list carries no marks. Marks reach a paired Mac through the state sync (`PeerState`, `applyRemote`),
     which a mark already starts.
   - The mark was inherited, not chosen. The first multi-Mac code (plan 023) listed `seen` among the pushes that change
     the lists, and the frame-table refactor copied that list across.

## What changes

1. **`seen_chat`**, a new push carrying one chat's marks as they now stand: `key`, and `seen`, `viewed`, `focus` and
   `rest`, each null when the chat has none. `SeenStore.chat()` builds it.
2. **A mark on one chat sends `seen_chat`, not `seen`.**
   - That covers `seen_mark`, `seen_unmark`, `viewed_mark`, `focus_add`, `card_rest` and the message a person sends.
   - The full `seen` frame stays for `seen_list` (every client asks on connect) and for marks taken from a paired Mac,
     which can move many chats at once.
3. **The app sets or clears that one key** in each of its four maps, and keeps a map's object when its value did not
   move, as `keepSame` does for the full frame.
4. **Neither push makes a paired Mac re-read the lists.**
   - `seen` loses its `lists` mark, and `seen_chat` has none.
   - `seen_chat` still starts the state sync, as `seen` does (`STATE_PUSHES` in `mod/peering.ts`).

## Left as it is

1. **Pruned entries linger on clients.** Setting a focus weight or a rest also drops other chats' faded weights and
   rests more than 30 days old (`pruneFocus`, `REST_FORGET_MS`). A one-chat push does not say so, so clients keep those
   entries until the next full frame (the next connect).
   - A faded weight counts for nothing, and an old rest has already ended, so nothing shows differently.
2. **Rests are over half the frame,** at about 700 bytes a chat, mostly the card's stamp. With one chat per push that no
   longer travels, so their size is left alone.
3. **The state sync itself** (a paired Mac pulls this Mac's whole state after a mark) is unchanged and is not measured
   here.

## Checked

1. **Tests:**
   - A chat's own push says what the whole frame says of that chat, null where it says nothing; a "not done" after a
     done gives null.
   - `seen_mark`, `seen_unmark`, `viewed_mark`, `focus_add` and `card_rest` each send `seen_chat` for their chat, and
     `seen_list` still sends the whole frame.
   - The frame table no longer lists `seen` among the pushes that change the lists.
   - `withMark` keeps a map's object when nothing moved, sets one key, and clears one.
2. **By hand**, with the bundled daemon and made-up chats (100 of them marked done and looked at):
   - A second socket received 235 to 270 bytes for each mark, where the whole frame is 39 KB there (64 KB with the real
     marks above).
   - In the built-in browser, a focus change and a "not done" made from another socket reached the app's maps: the
     chat's focus weight set, its done mark cleared, and the other 99 chats' marks kept. No unknown-frame warning.
3. **Not checked by hand:** a paired Mac, which needs a second daemon paired with the first. Its marks still arrive
   through the state sync, which `seen_chat` starts as `seen` did.
