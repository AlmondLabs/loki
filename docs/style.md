# Style guide

How loki's code, comments, docs, tests, commits and pull requests are written. Every rule here is either checked by
a tool (marked **checked**, with the check named) or is a review matter (marked **review**). A rule that a tool
checks is not argued in review: change the rule here and the tool together, in one PR.

This guide covers how things are written. How loki looks is [design.md](design.md) (tokens, primitives, colour
rules, checked by `test/tokens.test.ts`); what its words mean is [glossary.md](../glossary.md); where code lives is
[architecture.md](architecture.md).

The checks, all in CI and all to run before pushing. A pre-push hook (`scripts/pre-push.ts`) runs the first three on
the files a push changes, so a push never carries a format, lint or type error:

```bash
bun run format:check   # bun fmt; bun run format fixes it
bun run lint           # oxlint (type-aware: typescript-eslint's strict + stylistic rules, React hooks and Compiler rules), ESLint for what it lacks, and the workflow comment check
bun run typecheck      # bun check: TypeScript 7's checker on tsconfig.json, strict; the whole project in about a second
bun run test               # vitest, including the style tests (file names, PR titles, design tokens, pinned actions)
bun run test:node
bun run build:app && bun run build:mod && bun run smoke
```

`.oxlintrc.json` turns on every oxlint category that finds bugs (correctness, suspicious, perf); a rule that is off
there says why, and the ones that still fire somewhere carry their count until a PR fixes them and turns them on.
`eslint.config.mjs` keeps the rules oxlint has no version of: `naming-convention`, `no-restricted-syntax` and loki's own `loki/comments` (§5). `bun run lint:fast` runs the same with ESLint's cache, for while you work;
`bun run lint` never uses the cache, and it is the one to run before pushing.

## 1. Formatting

- **`bun fmt` formats** TypeScript, JavaScript, CSS, JSON, YAML and TOML, with the settings in `.oxfmtrc.json`. Bun reads
  that file as an oxfmt config and builds on oxfmt's defaults, so it keeps its name. Print width 160, double quotes,
  semicolons, trailing commas everywhere. A `prettier-ignore` comment keeps a line as written; Bun reads that name. Nobody formats by hand and nobody argues about it. **checked**: `bun run format:check`.
- **Markdown is hand-written**: wrap prose near 120 characters, keep tables aligned enough to read in a terminal.
  **review**.
- The commit that reformatted the whole tree is listed in `.git-blame-ignore-revs`; run
  `git config blame.ignoreRevsFile .git-blame-ignore-revs` once so `git blame` skips it.

## 2. Files, names and modules

**File names** **checked** (`test/style.test.ts`):

- Every file is kebab-case, components and hooks included: `suggestion-card.tsx` (exports `SuggestionCard`), `use-draft.ts`
  (exports `useDraft`), `peer-state.ts`, `fake-mcp.mjs`. One rule, as the Google TypeScript guide, Angular and most of
  the Node world have it.
- Tools' own config files keep the names their tools look for (`vite.config.ts`, `eslint.config.mjs`).
- Tests are `test/<subject>.test.ts`, their helpers in `test/fixtures/`; Node runner tests are
  `test-node/<subject>.node-test.ts`, beside the helpers they start or import.
- Docs are kebab-case too (`docs/style.md`, `glossary.md`), except the files GitHub and coding agents look for by
  name, which stay in capitals: `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `LICENSE`, `AGENTS.md`,
  `CLAUDE.md`. **review**.

**Names** **checked** (ESLint `naming-convention`) where the case is concerned, **review** for the rest:

- Variables and functions camelCase; types, interfaces, classes and components PascalCase; module-level constants that
  are fixed tables or limits UPPER_SNAKE (`QUOTE_MAX`, `KEYMAP`, `DONE_ASKED`), which the rule allows but does not
  require. No `I` prefix on an interface.
- Acronyms are words: `agentUrl`, `McpTools`, `OauthStore`, `loadHttpUrl`, never `agentURL` or `OAuthStore`.
- Object and type properties are left free, since they carry data in its own names (wire and file fields, headers); a
  name taken apart from data keeps it (`const { agent_id } = runtime`).
- Name things by the UI's words (glossary.md): a chat, a suggestion, an agent. Where the code keeps an older name (a chat
  is a _desk_ on the wire), say so where it matters, once.
- A boolean reads as a fact: `ready`, `waiting`, `canAdd`, `isWaiting(t)`. A function that returns something is named
  for what it returns (`targetOf(s)`), one that acts is named for the act (`requestReveal`).
- No abbreviations a newcomer would have to guess. Short names are fine for short scopes (`s` for the suggestion in a
  three-line arrow, `e` for an event).

**Data** **review** (the types make most of it checked):

- Data loki owns is snake_case: bridge frame fields and the request envelope (`request_id`), chat events, the files
  loki writes under `~/.loki`, suggestions on a chat and tool arguments. Frame and event names are
  snake_case (`chat_create`, `suggestion_made`).
- Its TypeScript types use those names directly (`desk.agent_id`, `row.last_message_at`); there is no conversion layer.
  Identifiers stay camelCase: `const { agent_id: agentId } = desk`, `{ agent_id: agentId }`.
- State that never leaves the app (React state, view models, `AttentionItem`'s own fields) is camelCase like any
  identifier.
- Formats loki does not own keep their names: `mcp.json` (`mcpServers`, `alwaysLoad`), pi-durable's
  documents, provider APIs, the browser's `dataset`.
- A field renamed in saved data or a frame ships with a one-time migration that rewrites what was saved, renaming only
  listed names, since a map's keys may be ids. It stays until every install loki has shipped to has run a release
  containing it. loki updates itself straight to its channel's latest release, so the release that removes it names, in
  its notes, the release an older install must open first.

**Modules**:

- **Named exports only**; no `export default`. Excepted: tools' config files,
  which the mod loader imports by default. **checked**: oxlint (`no-restricted-exports`).
- **`import type`** for types. **checked**: `verbatimModuleSyntax` and `consistent-type-imports`.
- `core/`, `mod/`, `daemon/` and `desktop/` import each other with the `.ts` extension (Node runs the first three unbundled); `app/` imports
  `core/` with it too, and its own files without. **review**: tsc accepts either form (`allowImportingTsExtensions`
  with `bundler` resolution); only Node, running `daemon/` and `mod/` unbundled, fails on a missing extension.
- `core/` never touches the browser, the desktop shell (Electron, `window.lokiDesktop`) or `app/`. **checked**:
  `test/core-portability.test.ts`.
- One concern per file. When a file passes ~600 lines, look for the second concern inside it. **review**.

**Agent tools** **checked** (`test/extensions.test.ts`, `test/tools.test.ts`):

- A tool's name and its arguments are snake_case: `background_watch`, `suggestion_create { target }`. A name of two
  words is `<subject>_<verb>`, the thing then what is done to it (`memory_read`, `suggestion_create`, `user_ask`), so tools of
  one family share its prefix (`memory_`, `schedule_`, `background_`, `suggestion_`). One tool per action, not
  one tool with an `action` argument. The exception is a tool whose calls all answer with the same thing and differ
  only in what they do first: `background_watch` reads a task's output, and may type into it or stop it before it does
  (plan 095). Its approval kind then follows its arguments (`callKind` in `daemon/approvals.ts`).
- Every built-in tool declares its kind (read, edit or command) on its definition with `withKind`
  (`daemon/tool-kinds.ts`); a mod's tools say so in their annotations. A tool with no kind is a command.
- Names loki does not choose stay as their owners write them: pi-durable's `read`, `write`, `edit` and `bash`, and MCP's
  `mcp__<server>__<tool>`.
- A rename is a hard rename: the old name goes everywhere. The stored "always allow" list and every store's saved calls
  and results are renamed by a one-time migration, kept as above, so no code that reads history knows an old name. A
  chat on an ACP agent keeps its agent's own names.

## 3. TypeScript

**checked** by `bun check`, TypeScript 7 (strict, `erasableSyntaxOnly`, `verbatimModuleSyntax`) and oxlint, type-aware
(typescript-eslint's `strictTypeChecked` and `stylisticTypeChecked` rules, tuned as below). The `typescript` package
stays on 5.x for the parser in `eslint.config.mjs`, which needs its API; TypeScript 7 has none yet.

- **No `any`**, explicit or leaked (`no-explicit-any`, `no-unsafe-*`). Data from outside (a frame, a file, JSON,
  a tool's arguments) comes in as `unknown` and is parsed into a type at the edge, the way `core/frames.ts` parses
  frames.
- **No non-null assertions (`x!`)**. Narrow instead: an early return, a guard, `?.` with a fallback, or a parse that
  returns the narrowed value.
- **No needless code**: no always-true or always-false conditions, no assertions that change nothing, no `async`
  without an `await`, no conversions of a value already that type.
- **Promises are awaited, returned, or marked with `void`** when the result truly does not matter (`void refresh()`).
  A rejected promise nobody handles is a bug (`no-floating-promises`, `no-misused-promises`).
- **Errors are `Error`s**, thrown with a message a person can read: `throw new Error("a suggestion needs a title")`.
  `catch (err)` treats `err` as `unknown`.
- **`interface` for object shapes**, `type` for unions, functions and mapped types (`consistent-type-definitions`).
  `T[]` for simple arrays, `Array<T>` when the element type is complex (`array-type: array-simple`).
- **No TypeScript-only runtime syntax**: no enums, namespaces or parameter properties (`erasableSyntaxOnly`); use a
  union of string literals and plain fields.
- `??` over `||` for defaults, `?.` over `&&` chains, `.includes`, `.startsWith` and `RegExp#exec` where they say it
  (`prefer-*`).

Tuned on purpose (allowed, and why):

- `() => void send()` arrow shorthand: it says "fire and forget" in one place (`no-confusing-void-expression` off).
- Numbers and booleans in template strings (`restrict-template-expressions` allows them): `${count} suggestions` is clear.
- Empty arrow functions as deliberate no-ops (`no-empty-function` allows arrows): `const noop = () => {};`.
- `||` with a string or boolean (`prefer-nullish-coalescing` ignores them): `name || "untitled"` treats an empty string
  as missing on purpose, which `??` would not.
- A test reaching a private member with brackets, `runner["deps"]` (`dot-notation` allows it; TypeScript allows only
  that form).

Patterns the rules lead to:

- A shape that must also be pi-durable's `JsonObject` (or any index-signature type) stays a `type` alias, since an
  interface with optional fields cannot extend one; the reason goes on an
  `oxlint-disable-next-line typescript/consistent-type-definitions` comment above it (`ChatInfo` in
  `daemon/kernel/index.ts`). That is the one disable comment the guide allows.
- A parse function that returns literal types gets an annotated return type rather than `as` casts on its fields:
  TypeScript widens a narrowed literal back to `string` inside an object literal, and the cast hides that.
- In tests, `must(value, "what")` (`test/fixtures/must.ts`) stands in for `value!` and fails with what was missing.

## 4. React

**checked** by oxlint's `react` plugin: the hooks rules and the React Compiler's rules are errors, except
`incompatible-library` and `unsupported-syntax`, which stay warnings. React Doctor posts an advisory comment on a PR
that touches `app/` (new findings against `main`); it does not fail CI, so it is **review**:

- Function components only, one main component per file, named after the file.
- **Derive, don't sync**: a value computed from props or state is computed during render (or `useMemo`), never copied
  into state by an effect (`set-state-in-effect`). An event that should change state changes it in the handler; a
  component that must start over for a new subject gets a `key`.
- **Effects are for the outside world**: subscriptions, timers, the DOM, the network. Each effect cleans up what it
  starts.
- Stable handlers where children are memoised (the transcript's rows are; see `chat/transcript.tsx`): `useCallback`,
  or a ref read inside a stable callback.
- State that outlives a component and is shared goes in a small store read with `useSyncExternalStore`
  (`shared/session-value.ts` is the pattern), not in context threaded through ten components.
- Browser storage only for per-viewer conveniences, every read and write in `try`/`catch`, and the page must work
  without it.

**review**:

- Styles: tokens and primitives first (design.md). Fixed layout is Tailwind classes on the spacing scale
  (`flex items-center gap-2`); inline `style` is for one-off padding, sizes and colour, and for values computed from
  state or props, and is checked against the scales. Mono and an ellipsis are `loki-mono` and `loki-truncate`. Anything
  shared or stateful (`:hover`, `[data-state]`) is a class in the area's CSS file.
- Accessibility: every control has a name (`aria-label` where there is no visible text), lists are lists, a custom
  widget has its role, and everything works from the keyboard. Shortcuts go in `shell/keymap.ts`, nowhere else.

## 5. Comments

- **Explain the non-obvious *why*, not the obvious *what*.** Prefer clear naming, types, and extracted helpers first; keep comments concise and current with the code beside them. **review**.
- **Rules enforced by `loki/comments` (`checked`: `bun run lint`)**:
  - `oxlint-disable` directives must explain why after ` -- `;
  - no `eslint-disable` directives (configured rules are fixed or updated in config);
  - no `TODO` or `FIXME` markers;
  - no commented-out code (and keep JSDoc `/** ... */` focused on contracts across process, storage, or API boundaries).
- **Workflow YAML comments (`scripts/workflow-comments.ts`, checked by `bun run lint`)** also reject `TODO` and `FIXME`.

## 6. Words on screen

**review**, with design.md's rules for colour and badges:

- **Words follow Apple's Human Interface Guidelines** (plan 2026-11-12-1505, R7). **Controls take title case**, on the
  desktop and the phone: buttons, menu items, toolbar items and segmented controls (`Mark as Read`, `Always Allow…`,
  `Reply All`, `New Chat`), with Apple's words for common commands (`Archive`, `Discard`, `Cancel`). `Button` capitalises
  the first letter of a label written in lowercase, so a new label is written in title case rather than left to it.
  **Everything else is a sentence**: headings, field labels, placeholders, help, tooltips, notices and errors
  (`Reply, or allow or deny the step`). Titles of sections are the names in the sidebar (`Chats`, `Flow`), and tabs,
  page titles and fold titles read the same way (`Profile`, `MCP servers`). loki's own name stays lowercase.
- **A decision is a question**: an approval asks `Allow friday to run “edit”?` with Deny, Always Allow… and Allow, the
  default last, as a Mac alert's.
- **Keys are not on a control's face**: they are in its tooltip (`Archive (⌘E)`), in the menu bar and in the keys sheet.
- Plain words, no jargon: "the agent is waiting for you", not "pending HITL approval". Name what the person sees,
  never an internal id or a stack trace (those go behind a "details" disclosure).
- Errors say what happened and what to do: "the chat this was for is gone: pick another chat", "needs a sign-in: Preferences › MCP servers".
- No exclamation marks, no "please", no "simply" or "just". Numbers as digits.
- Keys are written the Mac's way in docs (⌘, ⌥, ⇧); the app formats them for the viewer's system (`formatKeys`).

## 7. Docs

**review**:

- `docs/manual.md` is for the person using loki: what it does and how, present tense, second person. Every new
  feature or setting gets its part in the same PR.
- `docs/architecture.md` is for whoever changes the code; `docs/SECURITY.md` says what reaches the network, what
  runs, and where secrets live, and changes with anything that touches those.
- `docs/plans/` holds dated design notes for new behaviour; they record the decision, and are not kept up to date
  afterwards. A plan ships in the PR that builds it, not in a PR of its own.
- Agents work through the `ce-*` skills:
  - `ce-brainstorm` to scope an idea
  - `ce-plan` to write the plan
  - `ce-doc-review` to review the plan
  - `ce-work` to build it
  - `ce-code-review` to review the change
- Links over repetition: say a thing once and link to it.

## 8. Tests

- **Names read as behaviour**, in sentences: `describe("the chip on the message")`, `test("open: the agent's newest
  note; done?: Confirm and Reopen; done: ticked")`. **review**.
- **Inject the outside world**: the clock, runners, the file root, the keychain, fetch. Fake servers live in
  `test/fixtures/`. No real network, no real home directory, no real keychain. **review**.
- **No sleeps for timing**: wait on a condition with a deadline (each file
  that needs one keeps a small `until`). **review**.
- **Portable**: paths through `node:path`, never a hard-coded `/`; tests pass on macOS, Linux and Windows (CI runs
  all three). **checked**: CI.
- **Leave nothing behind**: test files share a worker's process and loaded modules, and run in a random order.
  `test/fixtures/reset-after-file.ts` puts back mocks, stubbed globals and env, timers, mocked modules, the working
  folder and `process.env` after each file; a file undoes anything else it changes in `afterAll` (servers, children,
  temp folders, module-level state through the module's own API). An order-dependent failure is a leak in the file
  that ran before: rerun with the printed seed (`bun run test --sequence.seed=<seed>`). **checked**: the random order.
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
- Scopes are loki's areas: `chat`, `history` (a chat's history pages and their rows), `acp` (chats on an ACP agent
  such as Claude Code), `mcp`, `memory` (an agent's memory and its notes), `learn`, `phone`, `canvas`, `flow`,
  `agents`, `settings`, `peers` (paired Macs), `motion` (animation and gestures), `daemon`, `mod`, `core`, `app`,
  `shell`, `release`, `deps`, `style` (this guide and its tooling). The scope may be left out for changes across the
  tree. The list lives in `scripts/check-pr-title.ts`; a new area adds its scope there, here and in AGENTS.md.
- What changed starts lowercase (names inside it keep their capitals: `fix(phone): pair over Tailscale`). GitHub's own
  `Revert "…"` titles pass as they are.
- The subject fits in 72 characters. The body says why, in sentences, wrapped near 72.
- Examples: `feat(chat): suggest work for another chat`, `fix(mcp): retry sign-in after a refused state`,
  `ci: pin the windows runner`.

**Branches** **review**: `type/what-it-does`, the commit types as prefixes, kebab-case after:
`feat/chat-suggestions`, `fix/phone-banner`, `chore/tool-cleanup`.

**A pull request** **review**:

- Its body says what changed and why, then **decisions for review** (anything a reviewer might choose differently),
  **tests** (what they cover), **checked by hand** (what was run and seen), and the **checks** run locally.
- UI changes include a screenshot.
- It is merged only when every CI check is green, Windows included.

## 10. For coding agents

[AGENTS.md](../AGENTS.md) is the short version of this guide for Claude, Codex, Cursor and the like; CLAUDE.md points
to it. Agents follow this guide exactly, run every check above before pushing, and never push a failing check.
