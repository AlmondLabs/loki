# AGENTS.md

Instructions for coding agents (Claude Code, Codex, Cursor and the like) working in this repository. People read
the same rules in [docs/style.md](docs/style.md), which is the source of truth; this file is its short form.

## Before you write

- Read [docs/style.md](docs/style.md) once per session, and [docs/architecture.md](docs/architecture.md) for where
  code lives. Use the words in [glossary.md](glossary.md).
- Match the code around you: its naming and idiom. Leave layout to `bun fmt` (`bun run format`).
- Work in this repository goes through the `ce-*` skills:
  - `ce-brainstorm` to scope an idea
  - `ce-plan` for the plan
  - `ce-doc-review` to review a plan
  - `ce-work` to build it
  - `ce-code-review` to review the change

  If your agent can't see them, they live in `~/.agents/skills` (link them into `~/.claude/skills` for Claude Code).
- New behaviour gets a short dated plan in `docs/plans/` first. The plan ships in the PR that builds it, not in a PR of
  its own. A change to what loki does gets its part in `docs/manual.md` in the same PR.

## The rules that trip agents up

- **No `any`, no `x!`, no floating promises.** Parse `unknown` at the edge; narrow instead of asserting; `await`,
  return, or `void` every promise.
- **Named exports only**, `import type` for types, `.ts` extensions on imports in `core/`, `mod/`, `daemon/` and `desktop/`.
- **Names**: every file kebab-case, components and hooks too (`suggestion-card.tsx`, `use-workspace.ts`); identifiers camelCase,
  types and components PascalCase, acronyms as words (`agentUrl`); data loki owns (frames, saved files, suggestions,
  tool arguments) snake_case, used as-is in its types (`desk.agent_id`).
- **React**: derive values during render; no effect that copies props into state; effects only for the outside
  world, and they clean up.
- **Comments**: explain non-obvious constraints ("why", not "what"); prefer clearer naming/types over comments for obvious code. No `TODO`/`FIXME`, no commented-out code, no `eslint-disable`, and every `oxlint-disable` must give `-- reason`. `bun run lint` checks those automatically.
- **Words on screen**: Apple's (the Human Interface Guidelines): controls in title case (`Mark as Read`), everything else
  a sentence, keys in tooltips and the menu bar rather than on buttons, plain words, no exclamation marks.
- **Styles** stay on the scales in [docs/design.md](docs/design.md) (`test/tokens.test.ts` checks).
- **Tests** inject the clock, the file root, runners and fetch; no real network, home or keychain; no sleeps; paths
  through `node:path` so they pass on Windows.
- **Tests share a process.** Test files run in one worker after another, with the app's modules loaded once, and in a
  random order. `test/fixtures/reset-after-file.ts` puts back mocks, stubbed globals and env, timers, mocked modules,
  the working folder and `process.env` after each file. Anything else a file changes, it undoes in `afterAll`: servers
  closed, children killed, temp folders removed, module-level state (a registry, a cache, a listener) reset through
  the module's own API. A failure that depends on the order is a leak: rerun with the seed vitest printed
  (`bun run test --sequence.seed=<seed>`) and fix the file that leaked, not the one that failed.

## Before you push

`git push` runs a hook (`.githooks/pre-push`, set up by `bun install`) that checks format and lint on the files the
branch changes, and the whole project's types, in a second or two. Don't skip it with `--no-verify`; it is not the
whole list below.

While you work, check with `bun run lint:fast`: it reuses ESLint's earlier results. The cache can miss an error a
type change in another file causes, so before pushing run the uncached `bun run lint` below. `bun run typecheck`
checks the whole project in about a second and keeps no cache.

Run every check, with CI's toolchain (the newest Node 22, the bun in package.json's `packageManager`, `SHELL=/bin/bash`), and push only when all pass (`bun run verify` runs them in parallel, and `bun run verify:pr` scopes lint, tests, and the app build to your branch diff while iterating):

```bash
bun run verify
# or serially:
bun run format:check && bun run lint && bun run typecheck && bun run test && bun run test:node
bun run build:app && bun run build:mod && bun run smoke
```

A failure is reproduced and fixed, never called flaky without evidence. After pushing, read the PR's CI, Windows
included, before saying it is done.

## Commits and pull requests

- [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): what changed`, lowercase, no period,
  72 characters at most (`feat(chat): suggest work for another chat`). The PR title follows the same shape; CI checks
  it.
- **The scope is one of these, or left out**; a folder or topic name that is not here fails CI: `chat`, `history`,
  `acp`, `mcp`, `memory`, `learn`, `phone`, `canvas`, `flow`, `agents`, `settings`, `peers`, `motion`,
  `daemon`, `mod`, `core`, `app`, `shell`, `release`, `deps`, `style`. Check the title before opening the PR:

  ```bash
  PR_TITLE="fix(chat): what changed" node --experimental-strip-types scripts/check-pr-title.ts
  ```
- The PR body: what changed and why, decisions for review, tests, what was checked by hand, the checks run.
  Screenshots for UI changes.
- Commit or push only when asked; work on a branch named `type/what-it-does` (`fix/phone-banner`), never on `main`.
