# Contributing

Thanks for looking. loki is a small personal project that went public; issues and pull requests are
welcome, and so is a fork that takes it somewhere else.

## Setup

macOS 13.3+, Node 22.19 or newer (it runs Vite, the tests and loki's daemon), bun (it installs the packages and runs package.json's scripts on Node; `brew install oven-sh/bun/bun`) and Xcode's command line tools (for git). There is nothing to compile: `bun install` brings Electron, and the shell is TypeScript that esbuild bundles in well under a second each time the window starts.

```bash
bun install
bun run start              # the Electron window (which starts the daemon) on the built page; code changes wait for update in the window (Ctrl-C stops all)
bun run dev            # the same window on Vite with hot reload (a Vite already running is reused), and app/dist rebuilt for the phone as you edit
bun run dev:vite       # Vite alone, for a browser tab
```

A change under `desktop/` (the shell) shows the next time you start the window; a change to the page, the daemon or
the mod arrives as the manual's [Install (development)](manual.md#install-development) describes.

A browser tab shows Preferences as a sheet. To check the Mac app's Settings window instead, open the Vite tab with
`&window=settings` after its `?t=` token, and `&page=<id>` (an id from `app/src/settings/pages.ts`) to open on a page.

**The phone, in a browser.** `bun run phone-preview` shows the phone's real screens with made-up data, with no phone, no Simulator, and nothing of `~/.loki` or your running daemon touched:

- It starts a throwaway daemon on a scratch folder, with its own ports, no keychain and no provider keys, and switches its phone listener on. It builds `app/dist` first if there is none.
- It seeds three made-up agents and seven chats through `test/fixtures/fake-acp.mjs`. One chat is long, so threads scroll under the floating bars, and two wait on an approval, so Flow has cards and a conversation shows its dock.
- It also seeds a made-up Gmail, Slack and Jira account, owned by Juniper, each with one card in Flow. It sets `LOKI_PREVIEW_ACCOUNTS=1`, so the mod never syncs them: they stay connected, a card reads its own saved lines, and Read, Later and Archive change loki's records alone. Writing them needs the agent first, so the daemon starts once more after the chats are seeded.
- It then prints a `localhost` link that pairs a browser as a phone. A link pairs once within ten minutes; press Enter for another. A paired browser stays paired for the run.

Open the link at 390 × 844 (Chromium's device toolbar, or the in-app browser's mobile size). Switch day and night with the browser's colour-scheme emulation, and Increase Contrast with DevTools › Rendering › `prefers-contrast: more`.

- An edit under `app/` rebuilds the page; reload to see it.
- An edit under `core/`, `daemon/` or `mod/` is picked up as under `bun run start`. A daemon change waits while a chat is busy, and the seeded approvals keep two busy. Once the daemon does restart, the script starts it again and re-seeds the approvals.
- Ctrl-C stops it and deletes the scratch folder; `--keep` leaves the folder.

It is Chromium, not Safari: blur, safe areas and text size are near, not exact. Replying from a Gmail, Slack or Jira card does not send.

**Windows and Linux** (the preview builds): Node, bun (bun.sh has the one-line install for both) and git; Electron
brings its own Chromium, so there are no compilers or WebView packages to install. On Windows run the commands from
Git Bash, as CI does; `~` is `%USERPROFILE%`. `.gitattributes` keeps every checkout LF, so the tests that read source
files pass there. The test in `test/agents.test.ts` that makes file symlinks needs Developer Mode or an administrator
shell on Windows (CI's runner is one).

To make the release's files for your own system: `bun run build:app && bun run build:mod`, then
`node --experimental-strip-types scripts/build-desktop.ts --stage`, then `bunx electron-builder` with `--mac`, `--win`
or `--linux`; they land in `desktop/release/` (`electron-builder.yml` says what each system gets). A build made this
way is not signed with loki's update key.

The window starts loki's daemon on your Node (`desktop/daemon.ts`), running the checkout's `daemon/main.ts`, which hosts the mod; when the daemon does not come up, the script says so and names its log, `~/.loki/logs/daemon.log`. `bun run start --check` reports the preflight without starting anything.

## Checks

How code, comments, docs, tests and commits are written is [style.md](style.md); agents read the short form in
[AGENTS.md](../AGENTS.md). `bun install` sets git's hooks folder to `.githooks/`, whose `pre-push` checks format and lint
on the files your branch changes and the whole project's types (`scripts/pre-push.ts`, a second or two). Before pushing, run:

```bash
bun run test                                          # mod, shared, app logic, and the style tests: file names, design tokens (vitest, on Node)
bun run test:node                                 # the tests that need Node's own runner: SQLite stores, a crash and resume
bun run typecheck                                 # bun check: TypeScript 7's checker, the whole project in about a second
bun run format:check                              # bun fmt; bun run format fixes it
bun run lint                                      # uncached; bun run lint:fast caches results while you work
bun run build:app && bun run build:mod            # the canvas build and the daemon and mod bundles the app ships
bun run smoke                                     # the bundle build:mod made, started in a scratch home: sign-in, agents across a restart
bun run doctor                                    # optional: react-doctor's report on the React code (not in CI)
```

CI runs these on a PR (a newer push cancels the run before it) and again in the merge queue, each check where it can
say something. On a PR the suite runs only what the diff reaches (`bun run test:pr`, `scripts/select-tests.ts`): the
tests the module graph links to the changed TypeScript, plus every test that reads the tree from disk; any other change
(a stylesheet, a config, the lockfile, a workflow, a doc, a deletion) runs it all. The lint is narrowed the same way
(`bun run lint:pr`, `scripts/lint-pr.ts`): the changed code and the files that import it directly, or everything when
the lint's setup, a tsconfig, package.json or the lockfile changes. A type-aware rule can still fail two imports away
from a change; the PR's lint misses that and the queue's does not. The merge queue always runs it all,
so nothing reaches main on a narrowed run. `.github/workflows/ci.yml` runs types, formatting, lint, the suite, the Node runner's tests, both bundles and the
smoke test on Ubuntu 22.04, each in a job of its own so they run side by side, and the suite, the Node runner's tests, the mod bundle and the smoke test again on
macOS 15 and Windows, where paths, shells and processes differ. Each check has a time budget in `scripts/budget.ts`, and a check that passes but runs past it fails its job: to slow one down on purpose, raise its budget in the same PR and say why. Windows runs the suite in two shards, and its required check, `tests (windows-latest)`, passes when both do. GitHub's Mac runners can queue for minutes, so on a PR the Mac job runs only when the diff can reach what differs there (`scripts/mac-scope.ts`: anything but the app, the site, docs and tests of the app); skipped, it counts as passed, and the merge queue always runs it;
the shell's tests (`test/desktop-*.test.ts`) run in that suite like any other; `react-doctor.yml` comments on a PR that touches
`app/` (advisory); `pr-title.yml` checks every PR's title against Conventional Commits (docs/style.md §9). On a PR of docs alone each `ci` job passes after its checkout without installing anything: the checks are required, and a PR reaches main through the merge queue only once they pass. A change to the shell or the mod that works on the Mac
should be read for the other two, since nobody on the project runs them. `test/tokens.test.ts` fails when an inline style leaves the design scales in
`docs/design.md`; if you need a new value, add it to the scale and the doc, not to the component.

Workflow actions are pinned to a commit with the tag in a comment (`test/workflows.test.ts` checks it); to move one,
look up the new tag's commit (`gh api repos/<owner>/<action>/commits/<tag> --jq .sha`) and change both. CI installs
with `bun install --frozen-lockfile` at the bun version in package.json's `packageManager`; a `bun.lock` written by
another bun version may not match, so upgrade bun there and in `devDependencies` together.

## Where things are

- `daemon/` loki's daemon, on Earendil's Pi libraries: agents, chats, tools, approvals, MCP, background passes.
  `scripts/build-mod.ts` bundles it for the app.
- `mod/` the canvas mod the daemon hosts: widgets, gestures, suggestions, Learn, the phone and
  Mac listener and `/ws`. Plain
  TypeScript, no build step in development; `scripts/build-mod.ts` bundles it too.
- `core/` types, the pure gesture reducer, harness parsing and the attention model all three clients use; no browser or desktop shell imports.
- `app/` the React canvas: `app/src/shell/` and the section folders are the desktop, `app/src/phone/` the
  phone, `app/src/shared/` what both use, `app/src/components/` the chrome primitives
  ([architecture](architecture.md#where-the-code-lives) has the full map). Every desktop shortcut lives in
  `app/src/shell/keymap.ts`.
- `desktop/` the shell, on Electron: finding (`node-search.ts`) and installing (`node-install.ts`) Node, starting, supervising and stopping the daemon (`daemon.ts`), installing the bundled daemon, mod and skill into `~/.loki` (`install.ts`), the `loki://` scheme and widget compiling (`scheme.ts`), the page's bridge (`preload.ts`, `ipc.ts`), the windows, tray, menus and updates. Mac-only parts (tray, badge, global key, menu bar) are set up only on the Mac. `scripts/build-desktop.ts` bundles it into `desktop/dist`.
- `skills/loki/SKILL.md` what the agent reads; keep it in step with `mod/tools.ts`.
- `test/` the vitest suite, `test-node/` the tests that need Node's own runner, `test/fixtures/` fake servers and logs.
- `docs/plans/` design history, dated. New behaviour gets a short plan there first.

## Rules of the house

- No real money amounts on screen, in the repo, or in recordings, but for the agents' estimated spend on the usage
  page. Fixtures and screenshots use made-up numbers.
- The red attention badge is spent only on things that need the human; blue is for what is interactive, green for the one affirmative button (see `docs/design.md`).
- Everything else about how things are written, from file names to commit messages, is in [style.md](style.md).

## Dependencies

The Pi libraries (`@earendil-works/pi-ai`, `pi-durable`, `chord`), the MCP client and the keychain binding are
pinned to exact versions in `package.json`: the daemon is built on their APIs, so an upgrade is its own PR, with
the full checks and a run of the app. New dependencies are pinned exactly too, at a version at least two weeks old.

Electron and electron-builder are pinned exactly too. An Electron upgrade changes the Chromium the window renders
on and the Node its main process runs (not the daemon's, which is the machine's), so it is its own PR, with the full
checks and a run of the packaged app on each system; keep it at 43 or later.
