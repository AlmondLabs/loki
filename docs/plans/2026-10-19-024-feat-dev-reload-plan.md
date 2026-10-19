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
- A change under `daemon/` or `core/` makes a restart due, and nothing restarts by itself: the window shows a notice
  naming the file, with **restart** and **later** (2026-10-19: the person chose a button over restarting on its
  own, which could surprise them). **restart** is refused while a chat runs a turn or an approval waits, and the
  notice then offers **restart anyway**, which cuts it off. The restart is the daemon's own clean stop; the shell
  starts it again a second later (its supervisor restarts any daemon that exits), and the window reconnects as after
  any restart. A daemon just started owes no restart.
- Watching is only for a checkout (the daemon runs `mod/boot.ts`). The installed app never watches its files, so no
  restart is ever due there (loki never updates itself); it still answers `daemon_restart`.

## Tests

`daemon/dev-reload.ts` holds the rules, its reload and checks injected: a burst of mod changes is one reload plus one
after it; a daemon change makes a restart due and is heard, and restarts nothing; asked to restart, it does when idle,
refuses while a chat works, and restarts anyway when told.
