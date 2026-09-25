# Contributing

Thanks for looking. loki is a small personal project that went public; issues and pull requests are
welcome, and so is a fork that takes it somewhere else.

## Setup

macOS 13+, [Bun](https://bun.sh), Rust (stable, via rustup — `bun start` looks in `~/.cargo/bin` too, and says what to install when there is none) and Xcode's command line tools. Letta Code is not a prerequisite: the shell uses the `letta` on the Mac or installs it with `npm install -g` on first launch (which needs a Node 22+ somewhere), and `LOKI_LETTA_BIN` points a dev build at a checkout instead. On a Mac that has never run loki, `bun start` also writes the development shim and skill symlink described in the manual's [Install (development)](manual.md#install-development).

```bash
bun install
bun start              # Vite on 127.0.0.1:5173 plus the Tauri window in one terminal (Ctrl-C stops both)
bun run dev            # Vite alone, for a browser tab
bun run desktop:dev    # the Tauri window against a Vite already running (in a second terminal)
```

**Windows and Linux** (the preview builds): Bun and Rust as above; in place of Xcode's tools, Windows needs the
Microsoft C++ Build Tools ("Desktop development with C++") and the WebView2 runtime (Windows 11 ships it), and
Linux needs Tauri's WebKitGTK build packages; the Ubuntu 22.04 list is the `apt-get install` line in
`.github/workflows/ci.yml`. On Windows run the commands from Git Bash, as CI does; `~` is `%USERPROFILE%`.
`.gitattributes` keeps every checkout LF, so the tests that read source files pass there. The test in
`test/agents.test.ts` that makes file symlinks needs Developer Mode or an administrator shell on Windows (CI's
runner is one). `bun run tauri build --bundles nsis` on Windows, or `--bundles appimage,deb` on Linux, makes the
release's files.

For the mod, point Letta at your checkout instead of the installed copy: write the shim from the manual's
"Install (development)" section (`docs/manual.md`) to `~/.letta/mods/loki.ts`. A shim that does not start with the managed
marker is never overwritten by the app.

## Checks

```bash
bun test                                          # mod, shared, app logic, design tokens
bun run typecheck
bun run lint
bun run build:app && bun run build:mod            # the canvas build and the mod bundle (cargo test needs both)
cargo test --manifest-path src-tauri/Cargo.toml   # shell
bun run doctor                                    # optional: react-doctor's report on the React code (not in CI)
```

CI runs all of these but the doctor, on macOS 14, Ubuntu 22.04 and Windows (`.github/workflows/ci.yml`), each
system as its own leg; a change to the shell or the mod that works on the Mac should be read for the other two,
since nobody on the project runs them. `test/tokens.test.ts` fails when an inline style leaves the design scales in
`docs/design.md`; if you need a new value, add it to the scale and the doc, not to the component.

## Where things are

- `mod/` the Letta mod. Plain TypeScript, no build step in development; `scripts/build-mod.ts` bundles it
  for the app.
- `core/` types, the pure gesture reducer, harness parsing and the attention model all three clients use; no browser or Tauri imports.
- `app/` the React canvas: `app/src/shell/` and the section folders are the desktop, `app/src/phone/` the
  phone, `app/src/shared/` what both use, `app/src/components/` the chrome primitives
  ([architecture](architecture.md#where-the-code-lives) has the full map). Every desktop shortcut lives in
  `app/src/shell/keymap.ts`.
- `src-tauri/` the shell: finding or installing Letta Code, attaching to or launching the harness, the app-server link, widget transpiling, the install step. Mac-only parts (tray, badge, global key, menu bar) are behind `cfg(target_os = "macos")`; the Windows and Linux harness lookup sits beside the Mac's in `appserver.rs`.
- `skills/loki/SKILL.md` what the agent reads; keep it in step with `mod/tools.ts`.
- `docs/plans/` design history, dated. New behaviour gets a short plan there first.

## Rules of the house

- No real money amounts on screen, in the repo, or in recordings. Fixtures use made-up numbers.
- The red attention badge is spent only on things that need the human; blue is for what is interactive, green for the one affirmative button (see `docs/design.md`).
- Tests for the mod are pure where possible: inject the `bd` runner, the clock, the file root.
- Commit messages say what changed and why in one line; the plan doc carries the reasoning.

## Compatibility

Letta Code's mod API and app-server protocol are undocumented for third parties; `core/compat.ts`
records the oldest version loki accepts and the one it was last tested with (`MIN_LETTA_CODE`,
`TESTED_LETTA_CODE`). If you upgrade Letta and things break, that constant is the
first thing to check and the first thing to update in your pull request.
