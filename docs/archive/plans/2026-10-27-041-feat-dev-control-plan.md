---
title: npm start puts the person in control; npm run dev hot-reloads
date: 2026-10-27
status: active
---

# npm start puts the person in control; npm run dev hot-reloads

## Why

`npm start` serves the window from Vite with hot reload and rebuilds the phone's copy (`app/dist`) on every save. Left
running all day, that costs far more than loki itself, measured on 2026-10-27 on the author's Mac:

- The window's web view grew about 25 MB a minute while nearly idle, to 3.5 GB after six hours. React's development
  build records a `performance.measure` entry for every component render (React 19.2 turns this on for every root in
  development), WebKit keeps every entry until the page clears them, and nothing does: the window held 537,038
  entries, about 17,000 more a minute, about 4 KB each. The page's script heap stayed near 43 MB throughout. The
  production build records none.
- `vite build --watch` for the phone held 1.34 GB, and the Vite dev server 174 MB.

The daemon already works the way the person wants (plan 024): a change to `daemon/` makes a restart due, the window
offers it, and the person decides when. The page should work the same way, and hot reload should stay one command
away for sessions spent tuning the UI.

## What changes

- **`npm run dev`** is today's `npm start`: Vite with hot reload, the Tauri window on it, and `app/dist` rebuilt for
  the phone on every save. Nothing about it changes but its name. Vite alone, today's `npm run dev`, becomes
  `npm run dev:vite`.
- **`npm start`** runs the built page:
  - It builds `app/dist` once when it is missing or older than the sources, then runs `tauri dev --port 5173` with no
    `devUrl`. The Tauri CLI then serves `app/dist` itself from its built-in static server, on the same address as
    today, so the window's origin (its saved token), its development content security policy (`devCsp`, which names
    `127.0.0.1:5173`, the widget frame included) and the phone's copy are as they are now. No Vite runs, and no
    server is written.
  - The window gets React's production build, so no timing entries pile up.
  - The built-in server injects a small script that reloads the window when anything under `app/dist` changes
    (debounced one second). That is the reload after **update**, at no cost.
- **Builds land in one move.** The update's build writes to `app/.dist-next` and then swaps it in for `app/dist`, so
  the window's reload sees a whole build. Built in place, Vite empties `app/dist` first, and the reload would come
  while `index.html` is missing: the built-in server answers a 404 with no page, and nothing reloads it again.
- **The daemon watches the page's sources** (`app/`, without `app/dist`), as it watches `daemon/`, and a change makes
  a page update due. `core/` already makes a restart due; it makes a page update due too, since the page imports it.
- **One notice, one button.** The restart notice becomes the update notice: "loki's code changed (file)", with
  **update** and **later**. **update** does what is due, in order: build the page (the daemon runs the checkout's
  `vite build`), then restart the daemon if that is due. The window reloads on the new build; the phone is offered
  its reload as today (the build id changes). A chat working or an approval waiting refuses the restart as today,
  with **update anyway**; a build alone cuts nothing off and needs no refusal. A failed build keeps the notice, says
  it failed and where the output is, and leaves the running page as it was.
- **Mod changes reload in place** as today: they cost nothing at rest.
- The installed app watches nothing and is unchanged.

## Trade-offs

- A page change shows when the person clicks **update**, after a build: 12.7 and 14.2 s on two runs (2026-10-27,
  Apple silicon), peaking at 0.79 and 0.86 GB for those seconds, then released. Today's watch holds 1.34 GB at all
  times, and the web view grows without end.
- The phone gets new code at the same moment as the Mac, not on every save. Under `npm start` the two never differ.
- Undoes two things set up on purpose: hot reload as `npm start`'s default, and the phone bundle following every save
  (2026-09-30). Both stay in `npm run dev`.

## Decisions for review

1. The Tauri CLI's built-in server serves the page, not the daemon and not new code (read in the CLI's source at
   `tauri-cli-v2.11.4`, `crates/tauri-cli/src/dev/builtin_dev_server.rs` and `dev.rs`):
   - The daemon would not do: `tauri dev` waits for the page's address before it opens the window, and the window
     starts the daemon; skipping the wait opens it on a connection error. A daemon restart would also take the page's
     server down with it.
   - The CLI starts the server only when `devUrl` is unset and `frontendDist` is a folder, and sets `devUrl` to it,
     so the shell is built as it is under Vite: the page is not embedded in the binary, and the CLI's Rust watcher
     covers `src-tauri/` only, so a new build of the page rebuilds nothing. To confirm on the first run.
   - `--port 5173` keeps today's address. The port is free under `npm start`, since no Vite runs; the CLI stops with
     an error if something else holds it.
   - Fallback, only if the first run shows otherwise: a static server of a few dozen lines in `scripts/dev.ts`.
2. The daemon runs the build, not `scripts/dev.ts`: the window already talks to the daemon, and the daemon already
   owns the restart.
3. `npm start` builds at startup only when `app/dist` is older than the newest source, so a start after a pull shows
   the pulled code, and an unchanged start opens in seconds.

## Tests

- `daemon/dev-reload.ts`: a page change makes an update due; `core/` makes both due; **update** builds then restarts
  when both are due, builds only when only the page is due, and keeps the notice with the error when the build fails
  (build and restart injected).
- The build swap: a finished build replaces `app/dist` whole; a failed one leaves `app/dist` as it was and removes
  `app/.dist-next` (the file root and the build injected).
- `scripts/dev.ts`: `npm start` builds only when a source is newer than `app/dist`, and passes no `devUrl`;
  `npm run dev` passes Vite's, as today.
- The notice: one notice for both; **update anyway** only when a restart was refused.

## Checked by hand

- `npm start` on the author's Mac: no Vite processes; the web view's footprint and `performance.getEntriesByType
  ("measure").length` sampled every 2 minutes for 30 minutes, against today's 25 MB a minute and 17,000 entries.
- Edit a component, click **update**: the window shows the change; the phone offers its reload.
- `npm run dev`: hot reload and the phone's watch as before.

## Manual

`docs/manual.md` and `README.md` say which command does what, in the same PR.
