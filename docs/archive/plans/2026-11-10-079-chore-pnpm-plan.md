---
title: Building loki with pnpm instead of npm
date: 2026-11-10
status: active
---

# Building loki with pnpm

## Why

loki is built, tested and released with npm. Three things make pnpm the better tool for it:

1. **Supply-chain defaults.** pnpm 11 and later hold back versions published less than a day ago
   (`minimumReleaseAge`). They also run no package's install script unless the project allows it by name
   (`allowBuilds`, with `strictDepBuilds` on). With npm, every install script runs.
2. **Strictness.** A package can only import what it declares, so an undeclared dependency fails while we develop
   instead of after some other package changes.
3. **npm 10's resolver.** Upgrading vitest to 4.1.12 crashed npm 10.9.8 and 10.9.9 in arborist's peer handling
   (`reading 'edgesOut'`), and that one install had to run on npm 11. pnpm resolved the same tree without trouble.
   Installs are also faster, and the many worktrees under `.claude/worktrees/` share one store instead of each holding
   a full `node_modules`.

None of this changes what users get. They install the .dmg (or the Windows and Linux builds), which carry the bundled
daemon and mod, and never run a package manager.

## What a trial found

pnpm 12.18 was run on main at ec3574a6: `pnpm import` from `package-lock.json`, an install, then every check.

1. **The import kept every version.** The resolved versions match the npm lockfile.
2. **Four packages ask to run install scripts.** These are `esbuild` (twice, 0.25 and 0.28), `@google/genai` and
   `protobufjs`. Only esbuild's does real work: it checks its native binary. @google/genai's is a no-op `echo`, and
   protobufjs's only matters for its command-line tool, which loki does not use.
3. **Nothing imports what it does not declare.** Lint, typecheck, the tests, the node tests, both builds and smoke all
   passed.
4. **`pnpm-lock.yaml` fails `format:check`.** Prettier reformats it, so it must be ignored as `package-lock.json` is.
5. **`build:mod` copies an incomplete keychain module, and nothing notices.** `scripts/build-mod.ts` copies
   `@napi-rs/keyring` and every `keyring-*` folder from `node_modules/@napi-rs` into the daemon's resources. With npm,
   the platform package (`keyring-darwin-arm64` and its siblings) sits there. With pnpm it stays beside `keyring` in
   the store (`node_modules/.pnpm/@napi-rs+keyring@…/node_modules/@napi-rs/`). So the build copied only the
   JavaScript, not the binary it loads. Smoke still passed, because it does not load the keychain module.

## What changes

1. **pnpm, pinned.** `package.json` gets `"packageManager": "pnpm@12.18.0"`, so corepack and CI run the same pnpm.
   `pnpm-lock.yaml` replaces `package-lock.json`.
2. **`pnpm-workspace.yaml`** holds pnpm's settings, since pnpm 11 reads only auth and registries from `.npmrc`:
   1. `allowBuilds`: `esbuild: true`, `"@google/genai": false`, `protobufjs: false`. A new package with an install
      script then fails the install until someone decides about it.
   2. `minimumReleaseAge` stays at pnpm's default of one day. A fix that cannot wait a day is added to
      `minimumReleaseAgeExclude` in the same PR, with the reason.
3. **The keychain copy finds the platform package wherever it lives.** `build-mod.ts` starts from the real path of
   `node_modules/@napi-rs/keyring` and copies `keyring` and its `keyring-*` siblings from that folder. That is the
   store under pnpm and `node_modules/@napi-rs` under npm.
4. **The copy is checked.** `build-mod.ts` fails when it copies no `keyring-<platform>` package with a `.node` file
   for the system it builds on. Smoke also loads the keychain module from the bundle (`new Entry(…)`, without reading
   or writing a secret), so a missing binary fails on every system in CI.
5. **CI and release.** `ci.yml`, `release.yml` and `site.yml` add `pnpm/action-setup` (pinned by commit like the
   other actions), set `actions/setup-node`'s `cache` to `pnpm`, and run `pnpm install --frozen-lockfile` and
   `pnpm run …` / `pnpm test`. This covers every job, Windows and Linux included. `test/workflows.test.ts` checks
   the pnpm commands instead of the npm ones.
6. **The build commands.** `tauri.conf.json`'s `beforeDevCommand` and `beforeBuildCommand` call `pnpm run`.
   `scripts/dev.ts` names `pnpm start` / `pnpm dev` in its messages. Its `node_modules/.bin` paths and Windows entry
   scripts work unchanged, because pnpm links direct dependencies there.
7. **`.prettierignore`** adds `pnpm-lock.yaml`.
8. **Words.** AGENTS.md, `docs/CONTRIBUTING.md`, `docs/style.md`, `docs/releasing.md`, `docs/architecture.md`,
   `docs/SECURITY.md`, README.md, `native/listen/README.md`, the usage lines in `scripts/release.ts`, and the
   developer parts of `docs/manual.md` say pnpm. The check list in AGENTS.md becomes
   `pnpm format:check && pnpm lint && …`, and "CI's toolchain" becomes the newest Node 22 with the pinned pnpm.

## What stays

1. **npm and npx on the user's machine.** loki starts some ACP adapters with `npx` (`daemon/acp/agents.ts`,
   `daemon/acp/process.ts`), finds programs through npm's shims (`mod/programs.ts`) and looks for Node in npm's
   global folder (`src-tauri/src/node.rs`). Those are about the person's computer, not how loki is built.
2. **The versions.** The switch changes no dependency version. Upgrades stay separate PRs.
3. **The release artifacts.** The .dmg, .exe and Linux packages carry the same files. The keychain check in "What
   changes" item 4 makes sure of that.

## Decisions for review

1. **pnpm 12, not 10.** 10.33 is what corepack offers this Mac today. 11 brought the supply-chain defaults and
   `allowBuilds`, and 12 rejects a misspelled setting in `pnpm-workspace.yaml` instead of ignoring it. Both need Node
   22, which loki already requires.
2. **No hoisting.** `nodeLinker: hoisted` would keep the npm layout, and build-mod's copy would work unchanged. But it
   gives up the strictness that is half the reason to switch. The trial found no import that needed it.
3. **A day's wait on new versions.** A security fix released today waits a day unless it is excluded by name. That
   is the trade for not installing a compromised release in its first hours.
4. **One PR.** Lockfile, workflows, build script and words change together. A half switch leaves CI and the docs
   disagreeing about which lockfile is real.

## Tests

1. `test/workflows.test.ts`: every job installs with `pnpm install --frozen-lockfile` and runs the checks with pnpm,
   and no job runs `npm ci`.
2. `scripts/build-mod.ts`'s keychain check, plus the keychain load in `scripts/smoke.ts`, which runs on macOS,
   Windows and Linux in CI. Removing the platform package from the bundle has to fail smoke; this is tried by hand
   once.
3. Every check under pnpm on this Mac, then CI on all three systems. A nightly .dmg from the PR's merge, opened and
   signed in to a provider whose key lives in the keychain.

## After it lands

Each worktree needs `pnpm install` once. Its old `node_modules`, laid out by npm, is replaced. The main checkout,
where the daemon runs from, too.
