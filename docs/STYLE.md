# Style guide

How loki's code, comments, docs, tests, commits and pull requests are written. Every rule here is either checked by
a tool (marked **checked**, with the check named) or is a review matter (marked **review**). A rule that a tool
checks is not argued in review: change the rule here and the tool together, in one PR.

> **Status**: this guide lands in four PRs: the guide itself, then Prettier (done), then the strict lint (done), then the
> doc-comment, file-name and PR-title checks, each fixing the whole tree as it turns its check on. A rule marked
> **checked** whose check has not landed yet is still the rule.

This guide covers how things are written. How loki looks is [design.md](design.md) (tokens, primitives, colour
rules, checked by `test/tokens.test.ts`); what its words mean is [GLOSSARY.md](../GLOSSARY.md); where code lives is
[architecture.md](architecture.md).

The checks, all in CI and all to run before pushing:

```bash
npm run format:check   # Prettier; npm run format fixes it
npm run lint           # ESLint: typescript-eslint strict + stylistic (type-checked), React hooks and Compiler rules
npm run typecheck      # tsc, strict
npm test               # vitest, including the style tests (file names, design tokens, pinned actions)
npm run test:node
npm run build:app && npm run build:mod && npm run smoke
```

## 1. Formatting

- **Prettier formats** TypeScript, JavaScript, CSS, JSON and YAML. Print width 160, double quotes, semicolons,
  trailing commas everywhere. Nobody formats by hand and nobody argues about it. **checked**: `npm run format:check`.
- **Markdown is hand-written**: wrap prose near 120 characters, keep tables aligned enough to read in a terminal.
  **review**.
- The commit that reformatted the whole tree is listed in `.git-blame-ignore-revs`; run
  `git config blame.ignoreRevsFile .git-blame-ignore-revs` once so `git blame` skips it.

## 2. Files, names and modules

**File names** **checked** (`test/style.test.ts`):

- A React component's file is PascalCase, named after its main export: `TasksPane.tsx`.
- A hook's file is `useX.ts` or `useX.tsx`: `useTasks.ts`.
- Everything else is kebab-case: `task-source.ts`, `session-value.ts`, `fake-mcp.mjs`.
- Tools' own config files keep the names their tools look for (`vite.config.ts`, `eslint.config.mjs`).
- Tests are `test/<subject>.test.ts`; Node runner tests are `test-node/<subject>.node-test.ts`.

**Names** **review**:

- Variables and functions camelCase; types, interfaces and components PascalCase; module-level constants that are
  fixed tables or limits UPPER_SNAKE (`QUOTE_MAX`, `KEYMAP`, `DONE_ASKED`).
- Wire names stay in their own case: bridge frames and analytics events are snake_case (`task_create`,
  `task_added`), metadata keys camelCase (`msgKey`).
- Name things by the UI's words (GLOSSARY.md): a chat, a task, an agent. Where the code keeps an older name (a chat
  is a _desk_ on the wire), say so where it matters, once.
- A boolean reads as a fact: `ready`, `waiting`, `canAdd`, `isWaiting(t)`. A function that returns something is named
  for what it returns (`taskSource(t)`), one that acts is named for the act (`requestReveal`).
- No abbreviations a newcomer would have to guess. Short names are fine for short scopes (`t` for the task in a
  three-line arrow, `e` for an event).

**Modules**:

- **Named exports only**; no `export default`. Excepted: tools' config files, and `mod/index.ts` and `mod/boot.ts`,
  which the mod loader imports by default. **checked**: ESLint (`no-restricted-exports`).
- **`import type`** for types. **checked**: `verbatimModuleSyntax` and `consistent-type-imports`.
- `core/`, `mod/` and `daemon/` import each other with the `.ts` extension (Node runs them unbundled); `app/` imports
  `core/` with it too, and its own files without. **checked**: tsc and the runtime.
- `core/` never touches the browser, Tauri or `app/`. **checked**: `test/core-portability.test.ts`.
- One concern per file. When a file passes ~600 lines, look for the second concern inside it. **review**.

## 3. TypeScript

**checked** by tsc (strict, `erasableSyntaxOnly`, `verbatimModuleSyntax`) and ESLint (`strictTypeChecked` and
`stylisticTypeChecked`, tuned as below):

- **No `any`**, explicit or leaked (`no-explicit-any`, `no-unsafe-*`). Data from outside (a frame, a file, JSON,
  a tool's arguments) comes in as `unknown` and is parsed into a type at the edge, the way `core/frames.ts` parses
  frames.
- **No non-null assertions (`x!`)**. Narrow instead: an early return, a guard, `?.` with a fallback, or a parse that
  returns the narrowed value.
- **No needless code**: no always-true or always-false conditions, no assertions that change nothing, no `async`
  without an `await`, no conversions of a value already that type.
- **Promises are awaited, returned, or marked with `void`** when the result truly does not matter (`void refresh()`).
  A rejected promise nobody handles is a bug (`no-floating-promises`, `no-misused-promises`).
- **Errors are `Error`s**, thrown with a message a person can read: `throw new Error("a task needs a title")`.
  `catch (err)` treats `err` as `unknown`.
- **`interface` for object shapes**, `type` for unions, functions and mapped types (`consistent-type-definitions`).
  `T[]` for simple arrays, `Array<T>` when the element type is complex (`array-type: array-simple`).
- **No TypeScript-only runtime syntax**: no enums, namespaces or parameter properties (`erasableSyntaxOnly`); use a
  union of string literals and plain fields.
- `??` over `||` for defaults, `?.` over `&&` chains, `.includes`, `.startsWith` and `RegExp#exec` where they say it
  (`prefer-*`).

Tuned on purpose (allowed, and why):

- `() => void send()` arrow shorthand: it says "fire and forget" in one place (`no-confusing-void-expression` off).
- Numbers and booleans in template strings (`restrict-template-expressions` allows them): `${count} tasks` is clear.
- Empty arrow functions as deliberate no-ops (`no-empty-function` allows arrows): `const noop = () => {};`.
- `||` with a string or boolean (`prefer-nullish-coalescing` ignores them): `name || "untitled"` treats an empty string
  as missing on purpose, which `??` would not.
- A test reaching a private member with brackets, `runner["deps"]` (`dot-notation` allows it; TypeScript allows only
  that form).

Patterns the rules lead to:

- A shape that must also be pi-durable's `JsonObject` (or any index-signature type) is
  `interface ChatInfo extends JsonObject { … }`, which says so; a `type` alias stays only where that cannot work, with
  the reason on an `eslint-disable-next-line` comment. That is the one disable comment the guide allows.
- A parse function that returns literal types gets an annotated return type rather than `as` casts on its fields:
  TypeScript widens a narrowed literal back to `string` inside an object literal, and the cast hides that.
- In tests, `must(value, "what")` (`test/fixtures/must.ts`) stands in for `value!` and fails with what was missing.

## 4. React

**checked** by `eslint-plugin-react-hooks` (hooks rules and the React Compiler's rules, all errors) and React
Doctor in CI (nothing new against `main`):

- Function components only, one main component per file, named after the file.
- **Derive, don't sync**: a value computed from props or state is computed during render (or `useMemo`), never copied
  into state by an effect (`set-state-in-effect`). An event that should change state changes it in the handler; a
  component that must start over for a new subject gets a `key`.
- **Effects are for the outside world**: subscriptions, timers, the DOM, the network. Each effect cleans up what it
  starts.
- Stable handlers where children are memoised (the transcript's rows are; see `chat/Transcript.tsx`): `useCallback`,
  or a ref read inside a stable callback.
- State that outlives a component and is shared goes in a small store read with `useSyncExternalStore`
  (`shared/sessionValue.ts` is the pattern), not in context threaded through ten components.
- Browser storage only for per-viewer conveniences, every read and write in `try`/`catch`, and the page must work
  without it.

**review**:

- Styles: tokens and primitives first (design.md). Inline `style` is fine for one-off layout and checked against the
  scales; anything shared or stateful (`:hover`, `[data-state]`) is a class in the area's CSS file.
- Accessibility: every control has a name (`aria-label` where there is no visible text), lists are lists, a custom
  widget has its role, and everything works from the keyboard. Shortcuts go in `shell/keymap.ts`, nowhere else.

## 5. Comments and doc comments

- **Every export outside `test/` has a doc comment** (`/** … */`): what it is or does, in terms of loki, and anything
  the caller must know. **checked**: ESLint (`jsdoc/require-jsdoc` on exported functions, classes, interfaces, type
  aliases and components).
- **Comments say why**, or what something means for the person using loki; the code already says what it does.
  Write the reason a reader would otherwise have to rediscover: the bug it avoids, the constraint behind it, the
  decision it records. **review**.
- **Full sentences, plain words**, present tense, about the thing itself ("A task the person filed waits for them to
  confirm it"), not about us ("we", "I") or the history of the edit ("changed to", "now"). **review**.
- No commented-out code; git keeps it. No `TODO` without an issue link or a name and date. **review**.
- Keep comments true: changing behaviour means changing the comment beside it in the same commit. **review**.

## 6. Words on screen

**review**, with design.md's rules for colour and badges:

- **Desktop controls and labels are lowercase** (`add task`, `confirm`, `sign in to cloud tracker`); the phone uses
  **sentence case**, as iOS does (`Add task`, `Mark as read`). Titles of sections are the names in the sidebar
  (`Tasks`, `Chats`).
- Plain words, no jargon: "the agent is waiting for you", not "pending HITL approval". Name what the person sees,
  never an internal id or a stack trace (those go behind a "details" disclosure).
- Errors say what happened and what to do: "Tasks is not available in this mod", "needs a sign-in: Settings › MCP".
- No exclamation marks, no "please", no "simply" or "just". Numbers as digits.
- Keys are written the Mac's way in docs (⌘, ⌥, ⇧); the app formats them for the viewer's system (`formatKeys`).

## 7. Docs

**review**:

- `docs/manual.md` is for the person using loki: what it does and how, present tense, second person. Every new
  feature or setting gets its part in the same PR.
- `docs/architecture.md` is for whoever changes the code; `docs/SECURITY.md` says what reaches the network, what
  runs, and where secrets live, and changes with anything that touches those.
- `docs/plans/` holds dated design notes for new behaviour; they record the decision, and are not kept up to date
  afterwards.
- Links over repetition: say a thing once and link to it.

## 8. Tests

- **Names read as behaviour**, in sentences: `describe("the chip on the message")`, `test("open: the agent's newest
  note; done?: Confirm and Reopen; done: ticked")`. **review**.
- **Inject the outside world**: the clock, the `bd` runner, the file root, the keychain, fetch. Fake servers live in
  `test/fixtures/`. No real network, no real home directory, no real keychain. **review**.
- **No sleeps for timing**: wait on a condition with a deadline (the `until` helper). **review**.
- **Portable**: paths through `node:path`, never a hard-coded `/`; tests pass on macOS, Linux and Windows (CI runs
  all three). **checked**: CI.
- A bug fix comes with the test that would have caught it. **review**.

## 9. Commits and pull requests

**Commit messages and PR titles follow [Conventional Commits](https://www.conventionalcommits.org/)**. **checked**:
the PR title, by `.github/workflows/pr-title.yml` (`scripts/check-pr-title.ts`), since the title becomes the merge
commit.

```
<type>(<scope>): <what changed, lowercase, no period>
```

- Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`; `!` after the
  scope for a breaking change.
- Scopes are loki's areas: `chat`, `tasks`, `mcp`, `learn`, `phone`, `desk`, `inbox`, `agents`, `settings`, `daemon`,
  `mod`, `core`, `shell`, `release`, `deps`. The scope may be left out for changes across the tree.
- The subject fits in 72 characters. The body says why, in sentences, wrapped near 72.
- Examples: `feat(tasks): add task from a chat message`, `fix(mcp): retry sign-in after a refused state`,
  `ci: pin the windows runner`.

**A pull request** **review**:

- Its body says what changed and why, then **decisions for review** (anything a reviewer might choose differently),
  **tests** (what they cover), **checked by hand** (what was run and seen), and the **checks** run locally.
- UI changes include a screenshot.
- It is merged only when every CI check is green, Windows included.

## 10. For coding agents

[AGENTS.md](../AGENTS.md) is the short version of this guide for Claude, Codex, Cursor and the like; CLAUDE.md points
to it. Agents follow this guide exactly, run every check above before pushing, and never push a failing check.
