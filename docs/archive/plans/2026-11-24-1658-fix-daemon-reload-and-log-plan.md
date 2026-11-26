---
title: A failed mod reload keeps loki serving, and log lines say when and how bad - Plan
type: fix
date: 2026-11-24
topic: daemon-reload-and-log
execution: code
---

# A failed mod reload keeps loki serving, and log lines say when and how bad - Plan

## Problem

In a checkout, opening an agent sometimes shows "No local record" for an agent that is on this Mac. The read
(`agent_get`) is fast and right: on a memory of 1,582 commits its two git logs take 0.02s and 0.11s. It fails because
nothing answers. The server the window talks to (41414) lives inside loki's mod, and the dev daemon reloads the mod on
every change under `mod/` or `core/`:

1. `ModRegistry.loadNow` stops the running mod, then activates the new one. `mod/boot.ts` builds inside that activate.
   Source that does not build, or a mod that throws as it starts, leaves no mod and so no server until the next good
   reload.
2. A reload starts 150ms after the first changed file. A `git pull` or a branch switch rewrites many files, so the
   reload runs on a half-changed tree.
3. One `daemon.log` held 520 "failed to load" lines against 474 good reloads. Its lines carry no time, so a failure
   cannot be matched to the moment the window showed it, and no severity, so failures are found by guessing words.

## Decisions

1. **Build before the swap.** `mod/boot.ts` exports `build`, which bundles and imports the mod and returns its
   activate. `daemon/main.ts` calls it before `mods.load`; a build that fails is reported and nothing is stopped.
2. **A mod that throws as it reloads is put back.** `ModRegistry` activates the mod that was running again, and reports
   both. Only when that fails too is the mod unloaded. This holds for mods in `~/.loki/mods` as well.
3. **Reload once the files are still.** `DevReload` waits `MOD_SETTLE_MS` (300) after the last change before it
   reloads, so a burst is one reload. A change during a reload is one more reload, after the same wait.
4. **One line shape for both logs**: `<time, UTC ISO> <severity> <message>` (`core/log-line.ts`). Severities are the
   mod API's own: `info`, `warning`, `error`.
   - a. The daemon's `report(message, severity = "error")` (`daemon/report.ts`): nearly every report is a failure, so
     that is the default, and the lifecycle lines say `info`. Lines name the process, `loki-daemon[<pid>]:`.
   - b. A mod's `diagnostics.report` severity is passed through rather than written into the message.
   - c. The mod's `log(event, detail)` is `info`; `log.warning` and `log.error` mark the rest. Events that name a
     failure (`…-failed`, `…-unreadable`, `server:error`, `…not-sent`) are errors; rate limits, timeouts, held moves and
     sign-outs are warnings.

## Scope boundaries

- The agent page still calls every failed read "No local record" and does not retry. That is the page's own fix.
- A mod that throws partway through activate has no dispose to call, so what it started before throwing stays. As before.
- Two daemons on one checkout share `.loki-build` and can delete each other's bundle. Not changed here.
- No log levels to filter by, no JSON lines, no new log file.

## Tests

- `test/dev-reload.test.ts`: a burst is one reload after the wait; a change during a reload is one more; a failed
  reload is an error.
- `test/mod-registry.test.ts`: a mod that throws while reloading leaves the running one in place; diagnostics keep
  their severity.
- `test/log.test.ts`: the line shape of `mod.log` and of the daemon's report.
