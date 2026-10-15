# Contributing

Thanks for looking. loki is a small personal project that went public; issues and pull requests are
welcome, and so is a fork that takes it somewhere else.

## Setup

macOS 13+, Node 22.19 or newer (it runs npm, Vite, the Tauri CLI, the tests and loki's daemon), Rust (stable, via rustup — `npm start` looks in `~/.cargo/bin` too, and says what to install when there is none) and Xcode's command line tools.

```bash
npm install
npm start              # Vite on 127.0.0.1:5173, the Tauri window (which starts the daemon), and app/dist rebuilt for the phone as you edit (Ctrl-C stops all)
npm run dev            # Vite alone, for a browser tab
npm run desktop:dev    # the Tauri window against a Vite already running (in a second terminal)
```

**Windows and Linux** (the preview builds): Node and Rust as above; in place of Xcode's tools, Windows needs the
Microsoft C++ Build Tools ("Desktop development with C++") and the WebView2 runtime (Windows 11 ships it), and
Linux needs Tauri's WebKitGTK build packages; the Ubuntu 22.04 list is the `apt-get install` line in
`.github/workflows/shell.yml`. On Windows run the commands from Git Bash, as CI does; `~` is `%USERPROFILE%`.
`.gitattributes` keeps every checkout LF, so the tests that read source files pass there. The test in
`test/agents.test.ts` that makes file symlinks needs Developer Mode or an administrator shell on Windows (CI's
runner is one). `npm run tauri -- build --bundles nsis` on Windows, or `--bundles appimage,deb` on Linux, makes the
release's files.

`npm start` bundles the mod before the window opens, and the window starts loki's daemon (`src-tauri/src/harness.rs`), which hosts it; when the daemon does not come up, the script says so and names its log, `~/.loki/logs/daemon.log`. `npm start --check` reports the preflight without starting anything.

## Checks

How code, comments, docs, tests and commits are written is [style.md](style.md); agents read the short form in
[AGENTS.md](../AGENTS.md). Before pushing, run:

```bash
npm test                                          # mod, shared, app logic, and the style tests: file names, design tokens (vitest, on Node)
npm run test:node                                 # the tests that need Node's own runner: SQLite stores, a crash and resume
npm run typecheck
npm run format:check                              # Prettier; npm run format fixes it
npm run lint
npm run build:app && npm run build:mod            # the canvas build and the mod bundle (cargo test needs app/dist to exist)
npm run smoke                                     # the bundle build:mod made, started in a scratch home: sign-in, Letta import, restart
cargo test --manifest-path src-tauri/Cargo.toml   # shell
cargo fmt --manifest-path src-tauri/Cargo.toml && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
npm run doctor                                    # optional: react-doctor's report on the React code (not in CI)
```

CI runs these on a PR (not again on its merge; a newer push cancels the run before it), each check where it can
say something: `.github/workflows/ci.yml` runs types, lint, the suite, the Node runner's tests and both bundles once
on Ubuntu 22.04, and the suite again on macOS 14 and Windows, where paths, shells and processes differ;
`shell.yml` runs clippy and `cargo test` on all three (and `cargo fmt --check` once) when `src-tauri/` changes; `react-doctor.yml` comments on a PR that touches
`app/` (advisory); `pr-title.yml` checks every PR's title against Conventional Commits (docs/style.md §9). A PR of docs alone starts only the title check. A change to the shell or the mod that works on the Mac
should be read for the other two, since nobody on the project runs them. `test/tokens.test.ts` fails when an inline style leaves the design scales in
`docs/design.md`; if you need a new value, add it to the scale and the doc, not to the component.

Workflow actions are pinned to a commit with the tag in a comment (`test/workflows.test.ts` checks it); to move one,
look up the new tag's commit (`gh api repos/<owner>/<action>/commits/<tag> --jq .sha`) and change both. CI installs
with npm 10 (Node 22's): if you write `package-lock.json` with npm 11, run `npm install` once with npm 10 after, or
`npm ci` on CI fails on entries npm 11 leaves out.

## Where things are

- `daemon/` loki's daemon, on Earendil's Pi libraries: agents, chats, tools, approvals, MCP, background passes.
  `scripts/build-mod.ts` bundles it for the app.
- `mod/` the canvas mod the daemon hosts: widgets, gestures, Tasks, Learn, the phone listener and `/ws`. Plain
  TypeScript, no build step in development; `scripts/build-mod.ts` bundles it too.
- `core/` types, the pure gesture reducer, harness parsing and the attention model all three clients use; no browser or Tauri imports.
- `app/` the React canvas: `app/src/shell/` and the section folders are the desktop, `app/src/phone/` the
  phone, `app/src/shared/` what both use, `app/src/components/` the chrome primitives
  ([architecture](architecture.md#where-the-code-lives) has the full map). Every desktop shortcut lives in
  `app/src/shell/keymap.ts`.
- `src-tauri/` the shell: finding Node and starting, supervising and stopping the daemon (`node.rs`, `harness.rs`), installing the bundled daemon, mod and skill into `~/.loki` (`install.rs`), widget transpiling, the tray, menu and native parts. Mac-only parts (tray, badge, global key, menu bar) are behind `cfg(target_os = "macos")`.
- `skills/loki/SKILL.md` what the agent reads; keep it in step with `mod/tools.ts`.
- `test/` the vitest suite, `test-node/` the tests that need Node's own runner, `test/fixtures/` fake servers and logs.
- `docs/plans/` design history, dated. New behaviour gets a short plan there first.

## Rules of the house

- No real money amounts on screen, in the repo, or in recordings. Fixtures use made-up numbers.
- The red attention badge is spent only on things that need the human; blue is for what is interactive, green for the one affirmative button (see `docs/design.md`).
- Everything else about how things are written, from file names to commit messages, is in [style.md](style.md).

## Dependencies

The Pi libraries (`@earendil-works/pi-ai`, `pi-durable`, `chord`), the MCP client and the keychain binding are
pinned to exact versions in `package.json`: the daemon is built on their APIs, so an upgrade is its own PR, with
the full checks and a run of the app. New dependencies are pinned exactly too, at a version at least two weeks old.
