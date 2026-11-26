---
title: loki's mod takes the daemon's memory repo queue from its host
date: 2026-10-28
status: active
---

# loki's mod takes the daemon's memory repo queue from its host

## Why

`daemon/repo-queue.ts` runs one git sequence at a time per memory repo, so two commits never meet on its
`index.lock`. It keeps its queue, and the listeners told when a sequence settles, in module state. loki's mod imports
it (`mod/skill-sources.ts`, and `mod/peer-memory.ts` through `daemon/memory-sync.ts`), but the mod is bundled apart
from the daemon: `scripts/build-mod.ts` makes `loki-mod.mjs` for the installed app, and `mod/boot.ts` bundles a
checkout's mod, with only packages left external. Each bundle carries its own copy of the module, so there are two
queues:

1. **Commits can still race.** A skill refresh, or a memory merge from a paired Mac, takes the mod's queue, while
   `memory_write`, reflection and Doctor take the daemon's. Two at once in one repo, and the loser's change is on disk
   but never committed. That is the race the queue was written to prevent (plan 023, U7).
2. **Paired Macs miss most commits.** `PeerMemory` hears only the mod's queue, so a commit by the memory tools,
   reflection or Doctor never sends `memory_changed`. Paired Macs catch up only when their link next opens.

The tests never saw it, because Vitest and `node --test` load one module graph for both.

## What changes

1. **The host hands the mod the memory repos.** `daemon/memory-sync.ts` exports `memoryRepos`: `serial`, `onSettled`,
   `head`, `bundle` and `apply`, the daemon's own functions. `Host.memory` carries it, and `daemon/main.ts` passes it.
2. **The mod uses only that.** `PeerMemory` and `SkillSources` take it in their options, and import only its type from
   the daemon. Nothing in the mod imports `repo-queue.ts` or `memory-sync.ts` for a value.
3. **A test bundles the mod as the release does** and checks the queue's code is not in it, so a new import, direct or
   through another daemon file, fails CI instead of quietly making a second queue.

The other daemon modules the mod imports for values (`config-sync`, `awake`, `passes-state`, `store/agent-sync`,
`chat-images`) keep no state of their own at module level, so their copies are harmless. Moving them behind the host
is the larger layering change, left for its own plan.

## Checked

1. The release bundles: the queue's code is in `daemon.mjs` once and not in `loki-mod.mjs`.
2. The guard test fails when a mod file imports the queue, directly or through `daemon/memory.ts`.
3. A skill refresh's commit goes through the queue it was handed (`test/skill-sources.test.ts`).

Not yet checked by hand: a `memory_write` on one Mac reaching a paired Mac without the link reopening.
