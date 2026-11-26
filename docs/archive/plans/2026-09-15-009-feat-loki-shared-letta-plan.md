# loki · one Letta Code per Mac: the machine's own, installed with npm (2026-09-15)

Raised 2026-09-15, after a week of first-run failures on a new MacBook: "I am now rethinking the whole
decision of the private letta copy." Then, as the requirement: "they use homebrew to ensure that nodejs
is installed … ensure letta-code is installed using npm … then use the default letta-code as the harness.
If the default letta-code is already running, then loki should use it instead of running its own
process." And on the Homebrew `letta-code` formula: "homebrew version of letta-code can be old. Can we
instead resolve letta-code directly from npm?" → "plan and implement".

This reverses the 2026-09-09 decision (plan 006): loki no longer keeps a private copy of Letta Code under
`~/.letta/loki/runtime/`.

## Why

1. Almost every first-run failure this month was the private install: sharp compiling against a Homebrew
   libvips, node-pty's helper permissions, sixty npm warnings in Welcome, a thirty-minute wait, a 559 MB
   download. A Mac that already has Letta Code needs none of it.
2. Letta users are the likeliest first adopters, and for them the private copy was a *second* Letta, at a
   different version, sharing `~/.letta` and the local backend with the first. Two versions writing one
   backend is a bigger hazard than two harnesses of one version.
3. The adoption code, the disabled update button, the "reload in Desktop" note and the mod leaking into
   Desktop all existed to paper over there being two Lettas on the machine.

## The shape

1. **Node comes with the cask.** `depends_on formula: "node"` in `Casks/loki.rb`. Homebrew installs Node
   (currently 26) and npm into a prefix the user owns. Bun is not needed at runtime and is not a dependency.
2. **Letta Code comes from npm, at first launch.** The shell looks for `letta` where installers put it:
   `LOKI_LETTA_BIN`, then PATH, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.volta/bin`, `~/.bun/bin`,
   `~/.npm-global/bin`, `~/.local/bin`, the newest nvm and fnm Node. When none is found it runs
   `npm install -g @letta-ai/letta-code@latest` with the npm that goes with the first Node it finds (the
   same order: PATH first, so a volta or nvm user's terminal `letta` and loki's are the same file), showing
   the progress in Welcome as before. Every mitigation from the private install stays, because they were
   npm's problems and not the private copy's: `SHARP_IGNORE_GLOBAL_LIBVIPS`, the telling error line, the
   npm warning summary, `~/.letta/loki/logs/install.log`, node-pty's spawn-helper on Intel. New: a
   permissions failure (a root-owned global folder from the nodejs.org installer) names the `sudo` line
   to run, since loki cannot.
3. **Attach when an app-server is running, launch otherwise.** Letta opens its app-server socket in three
   cases only: `letta server`, the channel gateway, and Letta Desktop. A terminal `letta` session opens none,
   so it can never be loki's harness (chat, the model picker, permissions, the reflection page, Catch Up and
   the card writer all go through that socket). The shell probes Desktop's ports (`lsof -c Letta`), then
   every `letta server --listen …` and `channel-gateway --app-server-url …` address in `ps`, without auth
   and then with loki's own token. One answers: loki links to it and launches nothing. None: loki launches
   `letta server` from the machine's Letta with its own environment (autoupdater off, the scratch folder).
4. **One mod, and it knows where it is.** Letta has one shared mods folder, `~/.letta/mods`, and every
   harness loads it; `LETTA_MODS_DIR` turned out to reach `letta install` but not the loader (tested on
   0.32.10: a shim in a private folder never loaded, the same shim in the shared folder did). So the shim
   stays where it was, and the mod decides at activation whether to serve (`mod/gate.ts`): Letta hands an
   interactive or headless session lifecycle events (`TUI_MOD_CAPABILITIES`, `HEADLESS_MOD_CAPABILITIES`)
   and the listener that hosts an app-server — `letta server`, Desktop, the channel gateway — none
   (`LISTENER_MOD_CAPABILITIES`). Lifecycle on: log one line and stand down. Off: serve. A terminal `letta`
   therefore never takes the desk's port or runs a second card writer, and the skill in
   `~/.agents/skills/loki` stays shared as before. `LOKI_MOD_SERVE=1|0` overrides for debugging.
5. **A version range, not a pin.** `core/compat.ts` carries `MIN_LETTA_CODE` (below it loki refuses with
   the upgrade command) and `TESTED_LETTA_CODE` (above it Settings says "newer than tested"). The shell no
   longer pins a release; `bootstrap.rs` installs `latest`. `check` and `update` in Settings stay: `update`
   runs the same npm command and restarts the harness when loki launched it. Letta's own autoupdater still
   runs in the user's terminal sessions and keeps the global install fresh; loki's harness keeps
   `DISABLE_AUTOUPDATER=1` so nothing changes under a running session.
6. **Gone.** `~/.letta/loki/runtime/`, the Node download from nodejs.org, `LOKI_NO_SYSTEM_NODE`,
   `LOKI_NO_BOOTSTRAP`, `Runtime.private`, `Status.private`, the Files page's runtime line.
7. **Found on the way: the release bundle's `ws` fails under Bun.** Letta Code's launcher prefers Bun when
   one is on PATH, and the `ws` esbuild inlines into `loki-mod.mjs` cannot finish a handshake there (the 101
   arrives as an "unexpected response"), so the mod never found the app-server on any Mac with Bun: Catch
   Up, the card writer and lessons were dark, silently. `mod/ws.ts` asks Bun for its own `ws` at runtime and
   keeps the inlined copy for Node. The development bundle never had the problem (packages stay external).
8. **Found on the way, worse: the release bundle never imported under Node at all.** The bundle is ESM
   and the inlined `ws` reaches Node's builtins with `require()`; without a `require` in scope esbuild's
   shim throws "Dynamic require of "events" is not supported" on import, so on a Mac without Bun the mod
   never activated and the desk never linked — the v0.1.0 release included. Bun tolerated it, and every
   checkout runs `mod/boot.ts` instead of the bundle, which is how it went unnoticed. `scripts/build-mod.ts`
   now gives the bundle a `createRequire` banner; `test/build-mod.test.ts` pins both fixes.

## Decisions

- **npm over the Homebrew formula.** homebrew-core has `letta-code` (bottled, 0.32.3 today against 0.32.10
  on npm). The user wants the newest: "homebrew version of letta-code can be old". The formula would have
  spared the npm install entirely; the cost of npm is the install step and its known failure modes, all
  of which loki already handles.
- **loki runs the install, not the cask.** A `postflight` could run npm during `brew install`, but it runs
  blind, a failing native build aborts the cask with Homebrew's error text, and the package sits outside
  Homebrew's tracking anyway. At first launch the progress is visible and the retry is loki's.
- **Attach only where an app-server exists.** The user's words were "if the default letta-code is already
  running"; a plain terminal session is running but has no socket to attach to. Attaching to a harness
  that has one (Desktop, `letta server`, the gateway) is kept and generalised.
- **A mod that stands down, by capability, not by port.** The first cut was a private mods folder via
  `LETTA_MODS_DIR`; Letta's loader ignores it (the plan's step 4). Yielding on a busy port was the other
  option and was rejected: it leaves the desk with whichever harness came first, which for a terminal
  session means no app-server behind it. The capability profile is synchronous, needs no probing, and
  names the exact thing that matters — does this harness host an app-server. What terminal users lose is
  the mod's slash commands and tools in their own sessions; the skill they keep.
- **Two harnesses on one backend is Letta's normal case.** Every terminal session is a harness on the
  local backend. The "never two harnesses" rule from plan 006 came from a stale in-memory conversation
  cache we saw once; that is cosmetic, and one Letta version now writes the backend instead of two.
- **`update` stays a button, `brew`/`sudo` stay commands.** loki runs npm for the user because they asked
  by pressing a button and because it is the same command loki ran to install; it never runs `brew` or
  anything with `sudo`, and prints those lines instead.

## What can go wrong, and what loki does

1. **No version pin.** loki tracks Letta releases instead of choosing when to move. `MIN_LETTA_CODE` /
   `TESTED_LETTA_CODE` in Settings; RELEASING.md's step "retest against npm latest, move TESTED".
2. **Two Nodes, two Lettas** (volta, nvm, fnm beside Homebrew). PATH first, then the usual folders, and
   Settings shows the path chosen. Installing uses the npm beside the Node that would be used.
3. **A root-owned global folder** (nodejs.org installer). The install fails with EACCES; loki shows
   `sudo npm install -g @letta-ai/letta-code@latest` and the retry button.
4. **Node major bumps under Homebrew.** Native modules in the global folder may stop loading until the
   package is reinstalled; the harness log shows the module-version error and Settings' `update` (a
   reinstall) is the fix. Not automated in this cut.
5. **Terminal autoupdate under a running harness.** Node has the bundle loaded; the running harness
   survives. The next launch runs the new version; `check` shows it against the tested one.
6. **Offline first launch.** The telling error names the registry; retry when the network is back.
7. **Letta Desktop users**: loki attaches to Desktop's harness, and Settings says so (which harness, its
   version against the range, "/reload in it, or restart Letta Desktop" until the mod is loaded there).
   Desktop's harness runs with the listener profile, so the mod serves the desk from it; the person's
   terminal sessions load the same shim and stand down.

## Files

- `src-tauri/src/bootstrap.rs` — discovery and the npm install; `harness.rs` — the launch environment;
  `appserver.rs` — `find_app_server`; `lib.rs` — setup. `mod/gate.ts` — who serves; `mod/ws.ts` — the
  runtime's `ws`.
- `app/src/shell/bootstrap.ts`, `Welcome.tsx`, `settings/Settings.tsx`, `core/compat.ts`, tests.
- `scripts/dev.ts`, `scripts/cask.ts`, `test/cask.test.ts`.
- `README.md`, `docs/manual.md`, `docs/CONTRIBUTING.md`, `docs/RELEASING.md`.
