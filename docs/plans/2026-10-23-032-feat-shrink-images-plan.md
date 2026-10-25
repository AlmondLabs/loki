---
title: Shrink the pictures already in the chat stores
date: 2026-10-23
status: active
---

# Shrink the pictures already in the chat stores

## Why

Plan 029 made `view_image` shrink a picture before the model gets it, so new ones are small. The ones read before
are in the stores as they were. On 2026-10-22 one agent's store was 443 MB: 166 MB of it pictures in tool results, 151
MB from `view_image`, two of them 39 MB and 19 MB on their own. A dry run with the same shrink on copies found 71
pictures over 300 KB, 116.5 MB of base64, which come to 26.7 MB: about 90 MB back. The person asked for it to be
done on 2026-10-23.

## What changes

1. **`npm run shrink-images`**, a command the person runs (`scripts/shrink-images.ts`). By itself it only reports,
   per store: how many pictures, and the size before and after. `--apply` changes the stores. `--dir` names a loki
   folder other than `~/.loki`.
2. **It refuses while loki runs.** It takes the daemon's own lock (`daemon/lock.ts`); held, it says so and stops. While
   it works, a daemon that starts finds the lock held and stops, as for any second daemon.
3. **What it shrinks**: a picture in a tool result (`pi.tool-result`), over 300 KB, through the shrink `view_image`
   uses (`shrinkImage`, `daemon/image-shrink.ts`): 1600 px on the long edge, JPEG at quality 85, kept only when
   smaller. Pictures the person pasted stay as they are: they are small already, and the window's copies are named
   by their bytes (plan 029). macOS only, as the shrink is; elsewhere it says there is nothing it can do.
4. **Before it changes a store** it copies it whole to `<dir>/stores/backup-<date>/<store>.sqlite` (`VACUUM INTO`, so
   the copy holds what the write-ahead log does too). The copy stays until the person deletes it; the report names it.
5. **Each store changes in one transaction**, then `VACUUM`, so the file gets smaller on disk.

What follows for the chats: an agent reading old history sees those pictures at 1600 px, as it sees new ones; and
each chat with a shrunk picture writes its prompt cache once more, on its next turn.

## Tests

1. A store with a large tool-result picture, a small one, a GIF and a pasted one: the report counts only the large
   one; `--apply` shrinks it and leaves the rest byte for byte (the shrink's runner injected).
2. Without `--apply` the store is unchanged; with it, a backup is written first and holds the old picture.
3. A held lock: nothing is read or written.
