# AGENTS.md

Instructions for coding agents (Claude Code, Codex, Cursor and the like) working in this repository. People read
the same rules in [docs/style.md](docs/style.md), which is the source of truth; this file is its short form.

## Before you write

- Read [docs/style.md](docs/style.md) once per session, and [docs/architecture.md](docs/architecture.md) for where
  code lives. Use the words in [glossary.md](glossary.md).
- Match the code around you: its comment density, naming and idiom. Leave layout to Prettier (`npm run format`).
- New behaviour gets a short dated plan in `docs/plans/` first; a change to what loki does gets its part in
  `docs/manual.md` in the same PR.

## The rules that trip agents up

- **No `any`, no `x!`, no floating promises.** Parse `unknown` at the edge; narrow instead of asserting; `await`,
  return, or `void` every promise.
- **Named exports only**, `import type` for types, `.ts` extensions on imports in `core/`, `mod/` and `daemon/`.
- **Names**: every file kebab-case, components and hooks too (`tasks-pane.tsx`, `use-tasks.ts`); identifiers camelCase,
  types and components PascalCase, acronyms as words (`agentUrl`); data loki owns (frames, saved files, task metadata,
  tool arguments) snake_case, used as-is in its types (`desk.agent_id`).
- **React**: derive values during render; no effect that copies props into state; effects only for the outside
  world, and they clean up.
- **Every export outside `test/` has a `/** … */` doc comment.** Comments say why, in full sentences and plain words;
  no commented-out code, no bare `TODO`.
- **Words on screen**: desktop controls lowercase, phone sentence case, plain words, no exclamation marks.
- **Styles** stay on the scales in [docs/design.md](docs/design.md) (`test/tokens.test.ts` checks).
- **Tests** inject the clock, the file root, runners and fetch; no real network, home or keychain; no sleeps; paths
  through `node:path` so they pass on Windows.

## Before you push

Run every check, with CI's toolchain (Node 22.23.3, npm 10.9.9, `SHELL=/bin/bash`), and push only when all pass:

```bash
npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:node
npm run build:app && npm run build:mod && npm run smoke
```

A failure is reproduced and fixed, never called flaky without evidence. After pushing, read the PR's CI, Windows
included, before saying it is done.

## Commits and pull requests

- [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): what changed`, lowercase, no period,
  72 characters at most (`feat(tasks): add task from a chat message`). The PR title follows the same shape; CI checks
  it.
- **The scope is one of these, or left out**; a folder or topic name that is not here fails CI: `chat`, `history`,
  `acp`, `tasks`, `mcp`, `memory`, `learn`, `phone`, `desk`, `inbox`, `agents`, `settings`, `peers`, `motion`,
  `daemon`, `mod`, `core`, `app`, `shell`, `release`, `deps`, `style`. Check the title before opening the PR:

  ```bash
  PR_TITLE="fix(chat): what changed" node --experimental-strip-types scripts/check-pr-title.ts
  ```
- The PR body: what changed and why, decisions for review, tests, what was checked by hand, the checks run.
  Screenshots for UI changes.
- Commit or push only when asked; work on a branch named `type/what-it-does` (`fix/phone-banner`), never on `main`.
