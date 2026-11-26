---
title: Small fixes for work loki does for nothing
date: 2026-10-28
status: active
---

# Small fixes for work loki does for nothing

## Why

A scan of the daemon, the mod and the app (2026-10-28) found work repeated on every model call, every streamed piece,
or every half-minute while nothing changes. Each fix here is small and stands alone.

## What changes

1. **A background pass reads back only what its run added.** `PassRunner` reset the pass's hidden chat, then read its
   every entry before the run and again after it. A reset keeps the old entries, so one agent's reflection chat had
   grown to 1,423 entries (about 25 MB of records), parsed twice a run. Now the run notes the newest entry's id before
   it starts and reads only the entries after it (`AgentStore.newestEntryId`, and `eachEntry` with `after`).
2. **Prompt sections read from disk are kept for a short while** (`daemon/section-cache.ts`). pi-durable renders every
   section before each model call, which is every tool round of a turn. Rendering the memory and skills sections took up
   to 22 ms on this Mac (an agent with a large memory, and 64 global skills), on the daemon's one event loop. They are
   now kept for `SECTION_TTL_MS` (10 s). Any commit to a memory repo clears them at once, so a change made by the memory
   tools, reflection, Doctor or the Agents page is in the next call; a note or skill edited by hand shows within 10 s.
3. **A broadcast is encoded once** (`mod/server.ts`), not once for each window, phone and paired Mac.
4. **The app's idle timers stop while the page is hidden.** The 30 s clock tick and the 60 s list poll redrew the
   whole app in a hidden tab or a phone app in the background. They now skip while hidden (`visibility`, from
   `pageVisibility`); the clock catches up when the page shows again, and coming back already reloads the lists. A
   list answer the same as the last one sets no state, so the poll redraws nothing when nothing changed (`keepSame`,
   moved to `core/same-data.ts`).
5. **The Bonjour name is kept for a minute** (`HOST_TTL_MS` in `mod/lan.ts`). `status()` ran `scutil` (7.5 ms median
   on this Mac, blocking) on every phone socket, upload, pairing and device seen.

## Looked at and left out

Taking `streaming` out of a chat's face, so the whole app does not redraw on each tool round, saves nothing: measured
on a turn of text, tool call, text, tool call, the face still moves twice a round, by `lastMessageAt` when a text
starts and `lastAssistantText` at the call. Both are what the chat list shows (the time, unread, and the preview).
Redrawing less there needs rows that redraw on their own, which is a larger change.

## Checked

1. The kernel test reads only a run's new entries after a reset.
2. The section cache's test: kept within its time, rendered again after it, cleared by a memory commit.
3. The listener's test: the Bonjour host is read once within a minute.
4. The idle-timer change has no hook test (the repo has no harness for `useAttention`); it is checked by typecheck,
   lint and the `keepSame` tests.
