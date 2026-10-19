---
title: Dev mode reloads core and restarts its daemon
date: 2026-10-19
status: active
---

# Dev mode reloads core and restarts its daemon

## Why

In a checkout, `npm start` reloads the window (Vite) and the mod (the daemon watches `mod/`), but not what the daemon
runs itself, nor `core/`, which both the mod and the daemon import. So after a pull the person was asked to restart
`npm start` by hand, and could not tell when that was needed.

## What changes

- A change under `mod/` or `core/` reloads the mod in place, as a `mod/` change did. A burst of changes is one reload:
  a reload asked for while one runs runs once more after it.
- A change under `daemon/` or `core/` restarts the daemon once it is idle: no chat with a turn running and no approval
  waiting. Until then it waits, looking every few seconds; after ten minutes it gives up and says in the daemon log
  that a restart is due. The restart is the daemon's own clean stop; the shell starts it again a second later (its
  supervisor restarts any daemon that exits), and the window reconnects as after any restart.
- Only for a checkout (the daemon runs `mod/boot.ts`). The installed app never watches its files and never restarts
  itself (loki never updates itself).

## Tests

`daemon/dev-reload.ts` holds the rules with the clock and the checks injected: a burst of mod changes is one reload
plus one after it; a daemon change restarts at once when idle, waits while busy and restarts when the turn ends, and
gives up after the limit with one line in the log; changes after giving up start the wait again.
