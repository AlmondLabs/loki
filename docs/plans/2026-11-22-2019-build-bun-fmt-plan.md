---
title: Format with bun fmt, keep oxlint and ESLint - Plan
type: build
date: 2026-11-22
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Format with bun fmt, keep oxlint and ESLint - Plan

## Goal Capsule

- **Objective:** a contributor formats and checks loki's code with the Bun the repo already pins, and every file comes out exactly as it does today. The lint keeps every rule it has.
- **Means:** swap oxfmt for `bun fmt` everywhere oxfmt runs: the format scripts, the pre-push hook and the springs writer. `.oxfmtrc.json` stays as the settings file (KTD1–KTD3). Lint stays on oxlint and ESLint (KTD4).
- **Authority:** the owner asked whether lint and format can move onto Bun's own tooling, and for the move to be built if it can. AGENTS.md and `docs/style.md` govern style.
- **Stop conditions:** stop and ask if `bun fmt`, with oxfmt uninstalled, formats a different set of files than oxfmt or formats any file differently, or if a check passes locally but `format` fails in CI.
- **Execution profile:** tooling change with no change to any formatted file. Proof is a no-diff format run plus the existing tests.
- **Finishes and ships:** an agent through `ce-work`; one pull request, opened when the owner asks.

## Product Contract

### Summary

`bun run format` and `format:check`, the pre-push hook and `scripts/springs.ts` run Bun 1.4.4's built-in formatter instead of oxfmt. The oxfmt package goes. `.oxfmtrc.json` stays, minus the `$schema` line that pointed into that package, because it is how Bun knows to format like oxfmt. Lint is not moved: `bun lint` exists only in Bun canary builds.

### Problem Frame

The owner believed loki had moved lint and format onto Bun along with the package manager, scripts and type checker. It had not. Format is oxfmt 0.75 (`.oxfmtrc.json`). Lint is oxlint 1.90, type-aware through tsgolint, beside ESLint 10 for `naming-convention` and two `no-restricted-syntax` patterns (`scripts/lint.ts`). Bun is already a devDependency at 1.4.4, so one more tool can come from it for free if it does the same job.

Evidence gathered on 2026-11-22 against Bun 1.4.4 (the `packageManager` pin), 1.4.5 (latest) and 1.4.6-canary.1:

| Question | Finding |
|---|---|
| Does Bun ship a formatter? | Yes. `bun fmt` arrived in 1.4.4 ("a formatter built into Bun"): Bun's own port of Prettier, with oxc_formatter's printer for JS/TS. |
| Does it read our config? | Yes. `bun fmt --doctor` reports "Using .oxfmtrc.json (oxfmt config)" and "965 files are formatted natively". It honours `ignorePatterns`. |
| Same files? | Yes, 965 each: 728 `.ts`, 205 `.tsx`, 9 `.json`, 8 `.yml`, 8 `.css`, 3 `.mjs`, 2 `.toml`, 1 `.webmanifest`, 1 `.mts`. `*.md` and `*.html` stay ignored, as today. |
| Same output? | Yes. Both pass `--check` on `main`. Every file was mangled (width 40, tabs, single quotes, no semicolons, no trailing commas), then one copy was reformatted with oxfmt and another with `bun fmt`. The two copies came out byte-identical across all 963 files the mangle changed. |
| Which settings file? | `.oxfmtrc.json`. Bun's oxfmt migration guide keeps it ("bun fmt reads your `.oxfmtrc.json`"), and says that without a config file the oxfmt dependency "is how Bun knows to format like oxfmt and not like Prettier". With oxfmt uninstalled, a `bunfig.toml` `[fmt]` section holding the same keys builds "on top of Prettier's defaults" and rewraps object unions in 7 files. A `.oxfmtrc.json` without its `$schema` line gives zero differences and the same 965 files. |
| Ignore comments? | `/* prettier-ignore */` in CSS keeps the next declaration as written in both tools. Bun documents `prettier-ignore` for JS, JSX, CSS, HTML, Markdown and YAML. |
| Speed of `format:check` | `bun fmt --check`: 27 ms median. `oxfmt --check`: 114 ms median (15 runs each, this Mac). |
| Does Bun ship a linter? | Not in 1.4.4 or 1.4.5. `bun lint` ("Lint JavaScript and TypeScript, like ESLint") is in 1.4.6-canary.1 and Bun's docs, not in any release. |
| Could canary `bun lint` cover our rules? | Nearly. With `.oxlintrc.json` it runs 255 rules natively, type-aware ones included. The one rule set it can't run is `jsdoc/*`. With `eslint.config.mjs` it runs both rules natively. On a file seeded with known violations it reported the same 6 findings as oxlint (react purity, floating promise, non-null assertion, type definitions) and the same 4 as ESLint (naming twice, both restricted patterns). It honours `oxlint-disable-next-line` and `eslint-disable-next-line`. A whole-repo run took 1.1 s, against 5.7 s for `bun run lint`. |

### Requirements

**Format**

- R1. `bun run format:check` passes or fails on exactly the files oxfmt does today, and `bun run format` writes the same bytes.
- R2. The pre-push hook's format check runs `bun fmt` on the changed files it formats today.
- R3. `scripts/springs.ts` writes `app/src/kit/tokens.css` formatted as `bun run format` would leave it.
- R4. Nothing installs or runs oxfmt.

**Lint**

- R5. Lint stays as it is: oxlint plus ESLint, with every rule, `lint:fast`, `lint:pr` and the hook unchanged (KTD4).

**Docs**

- R6. AGENTS.md, `docs/style.md` and `docs/CONTRIBUTING.md` name `bun fmt` where they name oxfmt as the formatter.

### Scope Boundaries

- No change to any formatting setting or to which files are formatted. Markdown and HTML stay unformatted, as today.
- No change to `docs/manual.md`: this changes nothing loki does.
- Considered and not built: a fallback to oxfmt. The output is byte-identical (Problem Frame), so a second formatter would only bring the dependency back.

#### Deferred to Follow-Up Work

- Moving lint to `bun lint` once a Bun release ships it. Then it can replace oxlint, tsgolint and ESLint in one config. It loses `jsdoc/*` unless Bun adds those rules. oxlint itself stays while `react-doctor` needs it.
- The comment rule (fail on a comment outside the keep list in `docs/style.md` §5), the `eslint-disable` → `oxlint-disable` rename and clearing the plain comments that reached `main` since 2026-11-16. Written as an ESLint-API rule in `eslint.config.mjs`, it runs under ESLint today and under `bun lint` later, which loads ESLint plugins.

## Planning Contract

### Key Technical Decisions

- KTD1. **`.oxfmtrc.json` stays as the settings file, with only its `$schema` line removed.** Bun reads it as an oxfmt config and builds on oxfmt's defaults. A `bunfig.toml` `[fmt]` section would build on Prettier's once oxfmt is uninstalled, which breaks R1 (Problem Frame). Bun's own oxfmt migration guide takes the same route. The `$schema` line goes because it points into the package U1 removes. No `bunfig.toml` is added.
- KTD2. **Every call passes `--no-script`, as `bun check` already does.** `bun fmt` runs a package's `fmt` script instead of formatting when one exists, and `typecheck` already guards `bun check` the same way.
- KTD3. **Code that runs the formatter spawns the pinned binary, `bun/bin/bun.exe`, resolved from the `bun` devDependency.** The pre-push hook already finds `bun check` this way (`scripts/pre-push.ts`, the `types` check). `scripts/springs.ts` pipes the CSS it builds through `bun fmt --stdin-filepath app/src/kit/tokens.css`, which finds `.oxfmtrc.json` itself. That drops its own config parsing and the oxfmt JS API.
- KTD4. **Lint stays on oxlint and ESLint.** No released Bun has a linter. Canary `bun lint` matched every finding on the probe and runs about 5× faster. Moving to a canary build would still put a pre-release binary into CI and the hook, against the pinned-toolchain rule in AGENTS.md.

### Risks

- An editor set to format on save with the oxc extension loses its config. The repo ships no editor settings (`.vscode/` is absent), and `bun fmt --lsp` is "Not supported" in 1.4.4, so the PR body says so.
- The formatter's version now moves with the Bun pin, which also sets the package manager and `bun check`. A Bun bump made for another reason can change formatting, and `format:check` would then fail across the tree. Before, oxfmt had its own pin. A Bun bump therefore runs `bun run format` and commits any change it makes on its own.
- CI's `format` job runs on Ubuntu and keeps its command (`bun run format:check`) and its 5 s budget (`scripts/budget.ts`). Windows runs only the pre-push test, which checks argument lists.

## Implementation Units

### U1. Format scripts and settings

- **Goal:** `format` and `format:check` run `bun fmt`, and oxfmt is uninstalled.
- **Requirements:** R1, R4.
- **Dependencies:** none.
- **Files:** modify `.oxfmtrc.json`, `package.json`, `bun.lock`.
- **Approach:**
  1. Drop the `$schema` line from `.oxfmtrc.json` (KTD1).
  2. Point `format` and `format:check` at `bun fmt --no-script`, the second with `--check` (KTD2).
  3. Remove the `oxfmt` devDependency with Bun 1.4.4, so `bun.lock` changes with it.
- **Execution note:** prove this with the formatter itself, not unit tests. The file list and a check run must match what oxfmt gave on `main`, measured after oxfmt is gone from `package.json`, since its presence changes Bun's defaults.
- **Test expectation:** none -- configuration. The proof is under Verification.
- **Verification:** `bun fmt --doctor` reports "Using .oxfmtrc.json (oxfmt config)". `--list-files` gives the same 965 paths as on `main`. `bun run format` leaves the tree unchanged.

### U2. Pre-push format check

- **Goal:** the hook checks a push's formatted files with `bun fmt`.
- **Requirements:** R2.
- **Dependencies:** U1.
- **Files:** modify `scripts/pre-push.ts`, `test/pre-push.test.ts`.
- **Approach:** the `format` check runs the pinned Bun binary (KTD3) with `fmt --no-script --check --no-error-on-unmatched-pattern` and the files, as a non-Node program. The file filter (`FORMATTED`) stays.
- **Patterns to follow:** the `types` check in `checksFor`.
- **Test scenarios:**
  - A push changing `core/x.ts` and `app/src/y.tsx` gets a `format` check whose program is the Bun binary, `node` false, and arguments `fmt --no-script --check --no-error-on-unmatched-pattern core/x.ts app/src/y.tsx`.
  - A push of `app/src/kit/tokens.css` and `.github/workflows/ci.yml` still gets only the `format` check.
- **Verification:** the hook passes on a branch whose changes are formatted, and fails on one with a misformatted `.ts` file.

### U3. Springs writer

- **Goal:** `scripts/springs.ts` formats the tokens it writes with `bun fmt`.
- **Requirements:** R3, R4.
- **Dependencies:** U1.
- **Files:** modify `scripts/springs.ts`.
- **Approach:** pipe the built CSS through the pinned binary with `--stdin-filepath app/src/kit/tokens.css` (KTD3), and write what it prints. A non-zero exit throws with its error output, as a format error does today.
- **Test expectation:** none -- a script a person runs by hand. `test/spring.test.ts` already checks that `tokens.css` holds what `kit/spring.ts` computes.
- **Verification:** running the script on `main`'s tokens leaves `app/src/kit/tokens.css` unchanged, and `test/spring.test.ts` passes.

### U4. Docs

- **Goal:** the docs say how loki formats now.
- **Requirements:** R6.
- **Dependencies:** U1.
- **Files:** modify `AGENTS.md`, `docs/style.md`, `docs/CONTRIBUTING.md`.
- **Approach:**
  1. In each of the three files, name `bun fmt` where it names oxfmt.
  2. In `docs/style.md`, add TOML to the formatted languages, say `.oxfmtrc.json` keeps its name because Bun reads it as an oxfmt config (KTD1), and say Bun reads the `prettier-ignore` spelling.
- **Test expectation:** none -- prose.
- **Verification:** `git grep -i oxfmt` finds only `.oxfmtrc.json`'s own name, its mention in `docs/style.md`, `CHANGELOG.md` and `docs/plans/`.

## Verification Contract

| Gate | Command | Proves |
|---|---|---|
| Same output | `bun run format`, then `git status` | R1: no formatted file changes |
| Same files | `bun fmt --no-script --list-files` against `main`'s list | R1 |
| Unit tests | `bun run test` (pre-push, spring) | R2, R3 |
| Full checks | AGENTS.md "Before you push": `format:check`, `lint`, `typecheck`, `test`, `test:node`, `build:app`, `build:mod`, `smoke`, with Node 22, Bun 1.4.4 and `SHELL=/bin/bash` | nothing else broke |
| PR title | `PR_TITLE="build: format with bun fmt instead of oxfmt" node --experimental-strip-types scripts/check-pr-title.ts` | title shape; no scope, since none on the list fits tooling |

## Definition of Done

- R1–R6 hold, and every gate above passes.
- No oxfmt package in `package.json` or `bun.lock`, and no oxfmt call in `scripts/`.
- No probe files, scratch copies or leftover experiments in the diff.
