---
title: One way per job: listeners, serial work and bursts
date: 2026-10-30
status: active
---

# One way per job: listeners, serial work and bursts

## Why

loki's patterns are small and each does one job, so their number is not what slows a reader down. What does is two
ways to do the same job, because the reader then asks whether the difference means something. Three jobs had grown
copies, each correct, each a little different:

1. **Telling listeners something changed:** about 20 hand-kept `Set`s of callbacks, with an add that returned the
   delete in three shapes (a boolean, `void`, or a setter instead).
2. **Running async work one piece at a time:** `serial()` for memory repos, two more keyed versions (credentials,
   suggestions) and six promise chains by hand (peer state and agents, the phone listener, the widget scans, the
   usage ledger, the task move).
3. **Turning a burst of calls into one run:** six timers kept by hand (the chat store's redraw, the MCP install, the
   seen marks' write, peer state's tell, the usage push, the widget scan).

## What changes

1. **`core/listeners.ts`**: `Listeners<A>`, with `add` (which returns the way to stop), `emit`, `size` and `clear`.
   Every listener set in `core/`, `daemon/`, `mod/` and `app/src/` uses it.
2. **`core/serial.ts`**: `serialQueue()` and `keyedQueue(settled?)`. Each piece runs once every earlier one has
   settled, failed or not, and settles as its own work does. The keyed form lets an idle key go.
   `daemon/repo-queue.ts`'s `serial` and `onRepoSettled` keep their names over it.
3. **`core/timers.ts`**: `coalesce(fn, ms)` (the first call starts the clock) and `debounce(fn, ms)` (each call
   starts it again), each with `schedule`, `flush` and `cancel`, and `unref` for a daemon's timers. The per-desk
   `ScopeDebouncer` stays as the keyed debounce.
4. **`docs/architecture.md`** gains "One way per job", naming each.

Nothing changes in behaviour, with one exception: the credentials queue now lets an idle provider's entry go, as the
other keyed queues did.

## Left as it is

1. **`daemon/background.ts`'s `waiters`** are promises waiting to resolve, not listeners.
2. **`app/src/shared/drafts.ts`** keeps a set of listeners per chat key, a different shape.

## Checked

1. `test/one-way.test.ts`:
   - listeners until taken back
   - a serial queue's order, and how it carries on after a failure
   - a keyed queue that holds per key only
   - coalesce against debounce
   - flush and cancel
2. The whole suite runs unchanged, since every copy's callers kept their interface.
