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

For the mod, point Letta at your checkout instead of the installed copy: write the shim from the manual's
"Install (development)" section (`docs/manual.md`) to `~/.letta/mods/loki.ts`. A shim that does not start with the managed
marker is never overwritten by the app.

## Checks

```bash
bun test                                          # mod, shared, app logic, design tokens
bun run typecheck
bun run lint
cargo test --manifest-path src-tauri/Cargo.toml   # shell
```

CI runs the same three. `test/tokens.test.ts` fails when an inline style leaves the design scales in
`docs/design.md`; if you need a new value, add it to the scale and the doc, not to the component.

## Where things are

- `mod/` the Letta mod. Plain TypeScript, no build step in development; `scripts/build-mod.ts` bundles it
  for the app.
- `core/` types, the pure gesture reducer, harness parsing and the attention model all three clients use; no browser or Tauri imports.
- `app/` the React canvas and shell. Every shortcut lives in `app/src/shell/keymap.ts`.
- `src-tauri/` the shell: finding or installing Letta Code, attaching to or launching the harness, the app-server link, widget transpiling, the install step.
- `skills/loki/SKILL.md` what the agent reads; keep it in step with `mod/tools.ts`.
- `docs/plans/` design history, dated. New behaviour gets a short plan there first.

## Rules of the house

- No real money amounts on screen, in the repo, or in recordings. Fixtures use made-up numbers.
- Brass is spent only on things that need the human (see `docs/design.md`).
- Tests for the mod are pure where possible: inject the `bd` runner, the clock, the file root.
- Commit messages say what changed and why in one line; the plan doc carries the reasoning.

## Compatibility

Letta Code's mod API and app-server protocol are undocumented for third parties; `core/compat.ts`
records the version loki was last tested with. If you upgrade Letta and things break, that constant is the
first thing to check and the first thing to update in your pull request.
