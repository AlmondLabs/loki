---
title: Smaller images in tool results, and pasted images on every window
date: 2026-10-20
status: active
---

# Smaller images in tool results, and pasted images on every window

## Why

1. **The chat stores grow on images the agent looks at.** Friday's store was 443 MB on 2026-10-20; 157 MB of it
   was tool results carrying images, 144 MB of those from loki's own `view_image` (`daemon/tools.ts`), which hands the
   model the file as it is on disk: about 500 KB of base64 each, kept in the history for good. Images the person
   pastes are shrunk to 1600px first (`app/src/chat/attachments.ts`), and all of theirs came to 2.3 MB.
2. **A pasted image shows only in the window it was sent from.** Every other window (the chat's home Mac when it was
   sent from another, the phone, and the sending window itself after a reload) reads the message through
   `contentText` (`core/harness.ts`), which turns each image part into a bare "[image]" line. The image is in the
   chat's store, and the model saw it; no window but the sender's ever gets it back.

## What changes

1. **`view_image` shrinks before it answers**, as pasted images are: a file over 300 KB is resized to 1600px on its
   long edge and sent as JPEG at quality 85, by macOS's `sips`. A GIF, a small file, a failed resize, and Windows and
   Linux (no `sips`) keep the file as it is. The model sees what the person's own pasted images give it. Images
   already in a store stay; nothing rewrites history.
2. **Each image in a user message gets a name**: the first 32 hex digits of its SHA-256, with its type's extension.
   The daemon writes it once to `~/.loki/chat-images/<name>` as it turns the message into thread steps (the history
   pages, `daemon/chats.ts`; the live events, `daemon/chat-events.ts`), and the user step carries the names
   (`images` on the `user` step, core/attention/thread.ts). The cache can be rebuilt from the stores at any time.
3. **The thread puts the pictures on the person's row** (`TranscriptRow.images`), as the sending window's own row
   already has them; the row draws a name as the mod's URL for it, and keeps a `data:` URL (the sender's own copy)
   as it is.
4. **The mod serves the cache**: `GET /chat-images/<name>` on the loopback server (the token) and the phone listener
   (the device cookie). A name this Mac does not hold is asked of each paired Mac in reach (`GET
   /peer/chat-images/<name>`, the Mac's bearer token), saved here and served: a picture sent to a chat on the mini
   shows on the MacBook and on the phone paired with it. The name is the content, so any Mac holding it answers right.

## Tests

1. `view_image`: a large PNG goes through the shrink and comes back as JPEG; a small one, a GIF, and a failed shrink
   come back as they were (the runner injected).
2. Steps: a user message with image parts carries their names, and the cache holds each file once.
3. The thread: a user step's images reach its row; the sender's echo keeps its own row.
4. The route: a name held here is served; one not held is fetched from a paired Mac and kept; a name that is not a
   name (`../`, another shape) is refused.
5. By hand: on the demo Macs, an image pasted on the MacBook into a chat on the mini, then the mini's window and the
   phone, after a reload.
