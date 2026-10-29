---
title: A renamed or archived chat shows the change on every client
date: 2026-10-29
status: active
---

# A renamed or archived chat shows the change on every client

## Why

Renaming, archiving, hiding or labelling a chat (`chat_update`) is saved by the daemon (`DaemonChats.update`) and
answered to the client that asked, but nothing tells anyone else. Found while measuring plan 049: a rename made in one
window reached the other only at its next list poll, up to a minute later, and never while that page was hidden.

1. **Another window or a paired phone** keeps the old row until its poll.
2. **The header of a chat open elsewhere** keeps the old title even after its list is read again: it prefers the title
   the last `desk_title` push gave, and that push is sent only at the end of a turn.
3. **A paired Mac** lists this Mac's chats from what it last fetched, and fetches again only on a push marked as changing
   the lists (`lists` in `core/frames.ts`). `lists_changed` is not one, on purpose: a Mac sends it after fetching another
   Mac's chats, so if it were, two Macs would fetch each other's chats back and forth for ever.

An agent change had the same gap and was closed by `agents_changed` (`mod/frames/chat.ts`, `agentsChange`).

## What changes

1. **`chat_changed`**, a new push with no payload: "a chat on this Mac was renamed, archived, hidden or relabelled". It
   is marked as changing the lists, so a paired Mac fetches this Mac's chats again and then tells its own clients with
   `lists_changed`. It cannot loop: what the paired Mac sends back is `lists_changed`.
2. **The `chat_update` handler** sends `chat_changed` to every client once the update succeeds, and the chat's
   `desk_title` to the tabs showing it, the way `agentsChange` does for agents. A failed update tells no one.
3. **The app** treats `chat_changed` like `lists_changed`: it asks for its lists again.

A rename made on a paired Mac's client is sent to the Mac the chat lives on, so it is handled there and told from there
too. That Mac's chats are then fetched twice by the asking Mac: once by the router before it answers (`relists`), and
once, 400 ms later, on hearing `chat_changed`. A rename is rare; the second fetch was left rather than adding a rule to
skip it.

## Checked

1. A test: `chat_update` tells every client and the tabs showing the chat once it succeeds, and no one when it fails.
2. The frame table test lists `chat_changed` among the pushes that change the lists.
3. By hand, with the bundled daemon and made-up chats: a second socket heard `desk_title` and `chat_changed` after a
   rename and after an archive, and nothing after a failed update; its next list had the change. In the built-in
   browser, with the chat open, a rename from another socket showed in the header, the tab title and the sidebar row
   within half a second, and an archive moved the row out of the open chats.
4. Not checked by hand: a paired Mac. That path is the frame table's `lists` mark, which `RemoteChats.heard` already
   follows for `agents_changed` and `seen`.
