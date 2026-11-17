---
title: Plain code after the comment purge - Plan
type: refactor
date: 2026-11-16
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Plain code after the comment purge - Plan

---

## Goal Capsule

- **Objective:** someone reading loki's code can tell what the main chat is, what an empty value means and which timeouts must agree, without a comment to explain it. Nothing a person sees, saves or sends changes.
- **Means:** fifteen MUST KILL flags from the comment purge (AlmondLabs/loki#308) that only need a name, a shared constant, a tagged state or a deletion (KTD1–KTD6), shipped as four pull requests (KTD7).
- **Authority:** the owner chose low-risk themes first and one theme per pull request (2026-11-16, "Start the batch"), and confirmed this scope. AGENTS.md and `docs/style.md` govern code style; this plan does not change them.
- **Stop conditions:** stop and ask if a change would alter a value saved under `~/.loki`, a frame between processes or Macs, the order of steps, or words on screen.
- **Execution profile:** behaviour-neutral refactors. Existing tests must pass unchanged, except where a unit names a test edit. New tests only cover behaviour that is untested today.
- **Finishes and ships:** an agent through `ce-work`, one pull request per phase, opened only when the owner asks.

---

## Product Contract

### Summary

Four small pull requests, each removing one kind of surprise the purge left in the code. The first deletes dead code and names three leftovers, and it carries this plan. The second gives the main chat one name. The third moves timeouts and permission-mode defaults that two sides must agree on into `core/`. The fourth replaces null-or-undefined pairs with explicit states.

### Problem Frame

The comment purge deleted every comment that explained a surprise in loki's own code, and it flagged each surprise for a reshape. Fifteen of those surprises need no change to data, ordering or concurrency, only clearer code. Until they are reshaped, the next person to touch them has neither the comment nor the clarity: a bare `"default"` in thirty places, a `null` that means "deleted" next to an `undefined` that means "never picked", an 11-minute wait that silently depends on a 10-minute limit in another process.

### Requirements

**Leftovers**

- R1. Code with no production caller is deleted with its tests: `buildUserContent` and `UserContent` (`core/attention/content.ts`), and the refill functions in `core/account-refill.ts` except `PAST_CAP`.
- R2. The `--loki-daemon` marker in the daemon's arguments is a named value whose meaning the code states, and it is still accepted, because the shell passes it on every start.
- R3. The nightly release title is built by a named helper that keeps today's exact string.
- R4. `ChatProjection.folded` has no branch for a case its input type rules out.
- R12. Two leftovers the research found read plainly too: `daemon/chats.ts` uses pi-steps' compaction constant, and the comment the purge cut mid-sentence in `daemon/passes.ts` gives way to a name that says what it explained.

**The main chat**

- R5. Every place that treats a conversation id of `"default"` as an agent's main chat uses one shared name or predicate, and the stored and sent value stays `"default"`.

**Values two sides must agree on**

- R6. The pass run limit and the `/doctor` wait come from one constant, and the wait is written as the limit plus a margin.
- R7. The mail-reply hold and the reply wait come from one constant each, in `core/`, and the wait is visibly longer than the hold. The hand-off's 60 s wait, which holds no mail, gets a name of its own.
- R8. The permission modes and their default are defined once, in `core/`.
- R9. Each quoted-mail opener in `core/mail-quote.ts` is reached by name, not by position.

**Explicit states**

- R10. The agents page's selection, the reflection page's settings and the suggestion card's open card each use a tagged state, not `null` versus `undefined`.
- R11. `looserThan` and `stricterMode` in `core/chat-links.ts` name what a `null` mode means (a mode loki does not know), and `null` on the wire stays as it is.

### Scope Boundaries

- No change to saved files, frames, ordering, concurrency or how tools are classified for approvals.
- No change to words on screen. The main chat's title is spelled four ways, and unifying them would change what people read.
- The two hand-kept copies of the Rust widget-import rewriter (`app/src/frame/rewrite.ts` and the Vite plugin's `widgetModule`) stay as they are.

### Deferred to Follow-Up Work

- The ten MUST KILL themes that change data, ordering, concurrency or tool kinds, each with its own plan.
- The same loading tri-state in `app/src/agents/use-agent-details.ts`, `app/src/phone/agents.tsx` and `app/src/phone/agent-page.tsx`, once R10's shape has settled.
- The resend frame's router wait (30 s) against the client's 60 s, a real mismatch that R7 does not fix.
- The `chat_command` frame description in `core/frames.ts` that leaves out `/doctor`.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Shared values live in `core/`.** `core/` imports nothing from `daemon/` or `mod/`, and both import `core/` (`docs/architecture.md`), so a constant both sides need moves to `core/` and the daemon and mod import it. `MOVE_TIMEOUT_MS` in `core/frames.ts` is the precedent.
- KTD2. **The main chat's name sits beside `SHARED_SCOPE` in `core/desk-core.ts`:** an id constant, an `isMainChat` predicate, and helpers for the `default-<agent>` scope and the `default:<agent>` folder key. Every value they produce is byte-identical to today's, because those strings are in SQLite, widget folders and frames. The ACP mode called `"default"` and the UI variant names are different concepts and are left alone.
- KTD3. **The daemon marker stays a declared option.** `parseArgs` rejects unknown options, so deleting it would stop every start. It becomes a named constant with a doc comment stating that the shell's `is_own_daemon` (`src-tauri/src/procs.rs`) recognises a leftover daemon by it. That is a contract across a process boundary, which the comment keep list allows.
- KTD4. **Tagged states follow `ThreadState` in `app/src/chat/outside-card.tsx`:** a `kind` field per state. In `AgentsSelectionState`, "deleted" still turns into "never picked" after a reload, because sessionStorage keeps only the id; that is today's behaviour and stays.
- KTD5. **`looserThan` and `stricterMode` change only inside the functions.** The `cap: LokiMode | null` in `chat_send` crosses Macs (`core/frames.ts`), so the null stays on the wire and the functions name what it means at the point of use. In both, null is a mode loki does not know: `looserThan` ranks an unknown ACP mode above every loki mode, and `stricterMode` treats an unknown cap as strict, as `core/frames.ts` describes the cap.
- KTD6. **The stored-steps type rules out chunks.** Stored steps come only from `entrySteps`, which never emits a chunk; giving them a type without `chunk` lets `folded` lose its `streaming` ternary without a runtime check.
- KTD7. **One theme per pull request, low risk first.** (session-settled: user-approved — chosen over one pull request for the whole batch: smaller reviews, and a later theme can stop without undoing an earlier one.) The order is leftovers, then the main chat, then shared values, then explicit states. U4 (permission modes) lands before U8 (`looserThan`), because both edit `core/chat-links.ts` and its callers in `daemon/chat-backend.ts`.

### Sequencing

| Pull request | Units | Carries |
|---|---|---|
| 1. Leftovers | U1, U2 | this plan |
| 2. The main chat | U3 | |
| 3. Shared values | U4, U5, U6 | |
| 4. Explicit states | U7, U8 | |

---

## Implementation Units

### U1. Delete code with no production caller

- **Goal:** remove `buildUserContent`, `UserContent` and the refill functions, keeping `PAST_CAP`.
- **Requirements:** R1.
- **Dependencies:** none.
- **Files:** `core/attention/content.ts`, `core/account-refill.ts`, `test/content.test.ts`, the refill tests that import the removed functions, `docs/architecture.md`.
- **Approach:**
  1. Delete `buildUserContent` and `UserContent` and the tests that call only them.
  2. Delete `firstRefill`, `refillWindow`, `advanceRefill`, `parseRefill` and their types. Keep `PAST_CAP` where the Gmail, Slack and Jira syncs import it, either in the same file or in a small file of its own.
  3. Update the line in `docs/architecture.md` that describes the refill.
- **Patterns to follow:** the removals in eb82f6e0 and c4760c6a that left these behind.
- **Test scenarios:** Test expectation: none -- pure deletion; the remaining tests passing unchanged is the proof.
- **Verification:** nothing in `core/`, `daemon/`, `mod/` or `app/` references the removed names, and `PAST_CAP` users still build.

### U2. Name the leftovers

- **Goal:** the daemon marker, the nightly title and the folded steps read plainly.
- **Requirements:** R2, R3, R4, R12.
- **Dependencies:** none.
- **Files:** `daemon/main.ts`, `scripts/release.ts`, `test/release.test.ts`, `core/attention/pi-steps.ts`, `daemon/chats.ts`, `daemon/passes.ts`, `test/chat-projection.test.ts`.
- **Approach:**
  1. Per KTD3, declare the marker through a named constant with its contract doc comment.
  2. Extract the nightly title into a named helper built from the stable part and a named older `<stable>-nightly.<sha>` part. The string stays identical.
  3. Per KTD6, give stored steps a type without chunks and drop the `streaming` ternary in `folded`.
  4. While in `daemon/chats.ts`, use pi-steps' `COMPACTION` constant instead of the spelled `"pi.compaction"`.
  5. In `daemon/passes.ts`, delete the comment the purge cut mid-sentence and rename `before` to say that only this run's new entries are read back, because a pass chat's reset keeps its old ones.
- **Patterns to follow:** `nightlyVersion` and `isNightlyVersion` in `scripts/release.ts`.
- **Test scenarios:**
  - The release title for version `2026.1011.1-nightly.4821` and sha `a96ee85…` is still `loki 2026.1011.1-nightly.4821 (2026.1011.1-nightly.a96ee85)`, as `test/release.test.ts` pins.
  - A thread read between turns still equals one folded whole at the end (`test/chat-projection.test.ts`).
- **Verification:** `npm run smoke` starts the daemon with `--loki-daemon` and passes, and typecheck shows no stored step can be a chunk.

### U3. One name for the main chat

- **Goal:** every same-concept `"default"` goes through KTD2's name.
- **Requirements:** R5.
- **Dependencies:** none.
- **Files:**
  - core: `core/desk-core.ts`, `core/attention/model.ts`, `core/attention/chat-store.ts`
  - daemon: `daemon/chats.ts`, `daemon/chat-backend.ts`
  - mod: `mod/desks.ts`
  - app: `app/src/desk/use-desk.ts`, `app/src/desk/desk-pane.tsx`, `app/src/desk/deck-moves.ts`, `app/src/desk/catch-up-parts.tsx`, `app/src/shell/shell.tsx`, `app/src/shell/sidebar-model.ts`, `app/src/shell/search-model.ts`, `app/src/phone/home.tsx`, `app/src/phone/agent-page.tsx`, `app/src/phone/model.ts`, `app/src/phone/phone.tsx`, `app/src/agents/profile-page.tsx`, `app/src/chat/suggestion-card.tsx`
  - tests: `test/desk-core.test.ts` (or wherever `scopeFor` is tested)
- **Approach:**
  1. Add the id, the predicate and the scope and folder-key helpers to `core/desk-core.ts` (KTD2).
  2. Replace every same-concept site in the files above, including `find()` and the title fallback in `daemon/chats.ts`, the store's `createChat` in `daemon/chat-backend.ts`, the two parsers of the `default-` scope prefix in `mod/desks.ts` and `app/src/desk/use-desk.ts`, and the bare `"shared"` in `mod/desks.ts` with `SHARED_SCOPE`. Where a title is built for the main chat, only the `=== "default"` test changes, never the words. The ACP mode `"default"` in `daemon/chats.ts` stays.
  3. In `chat-store.ts`, keep the `this.client &&` guard first, because `test/chat-store.test.ts` pins the "not connected" answer.
  4. Leave the copy of `canArchive` in `app/src/phone/home.tsx`, unless both copies can import one shared helper without the phone importing desktop shell code.
- **Patterns to follow:** `SHARED_SCOPE` and `scopeFor` in `core/desk-core.ts`.
- **Test scenarios:**
  - The scope helper turns agent `a1` into `default-a1`, and parsing `default-a1` gives back agent `a1` with conversation id `"default"`.
  - The folder-key helper gives the same `backendName` input as today for the main chat and for an ordinary conversation.
  - `isMainChat` is true for `"default"` and false for an ordinary id and for an outside item.
- **Verification:** a search for a quoted `"default"` used as a conversation id finds only the new helpers; the remaining `"default"` strings are ACP modes, models or UI variants. Every existing test passes unchanged.

### U4. Permission modes in core

- **Goal:** the four modes and their default are defined once.
- **Requirements:** R8.
- **Dependencies:** none.
- **Files:** a module in `core/` (alongside `core/chat-links.ts` or in it), `core/frames.ts`, `daemon/approvals.ts`, `mod/chat-listing.ts`, `app/src/chat/permission-mode.tsx`, `test/engine-rules.test.ts`.
- **Approach:**
  1. Move `PermissionMode`, `DEFAULT_MODE`, `isPermissionMode` and `modeOf` into `core/` (KTD1).
  2. Point the five spellings of the mode list and of `"unrestricted"` at them. The values stay the same.
  3. Use `modeOf` only where the mode is a loki chat's. Where a mode can be an ACP id (`mod/chat-listing.ts`) or must stay null when unknown (`lokiMode` in `core/frames.ts`), replace only the literal, so an ACP chat's mode still passes through.
- **Test scenarios:**
  - `modeOf` of `undefined`, of `null` and of an unknown string is the default, and of each known mode is that mode.
  - `test/engine-rules.test.ts` imports `DEFAULT_MODE` from its new home.
  - An ACP chat whose mode is `plan` is listed with mode `plan`, not the default.
- **Verification:** the daemon, mod and app build. No file outside the new module spells the four modes as a list.

### U5. Timeouts that must agree

- **Goal:** the `/doctor` wait and the reply wait are derived from the limits they must outlast.
- **Requirements:** R6, R7.
- **Dependencies:** none.
- **Files:** `core/frames.ts` (or a small timing module in `core/`), `core/attention/chat-client.ts`, `daemon/passes.ts`, `mod/mail-outbox.ts`, a new or existing test in `test/`.
- **Approach:**
  1. Move the pass run limit (10 min) into `core/`, import it in `daemon/passes.ts`, and write the `/doctor` wait as that limit plus one minute.
  2. Move the mail hold (`HOLD_MS`, 10 s) into `core/` and define one reply wait (60 s) for the reply and resend client calls and the reply frame row.
  3. Give the hand-off's client call and frame row their own named 60 s wait, since a hand-off holds no mail.
  4. Do not route the client through the frame table's `timeout_ms`, which would change the resend frame's wait.
- **Patterns to follow:** `MOVE_TIMEOUT_MS` in `core/frames.ts`.
- **Test scenarios:**
  - The `/doctor` wait is longer than the pass run limit.
  - The reply wait is longer than the mail hold.
  - The `/doctor` wait, the reply wait and the hand-off wait equal today's (11 min, 60 s, 60 s), so behaviour does not change.
- **Verification:** no literal `11 * 60_000`, `60_000` reply wait or `10_000` hold remains outside the shared constants.

### U6. Name the mail openers

- **Goal:** each quoted-mail opener is a named pattern.
- **Requirements:** R9.
- **Dependencies:** none.
- **Files:** `core/mail-quote.ts`, `test/outside-threads.test.ts`.
- **Approach:** name the three opener patterns, and give Outlook's its own helper where it is read today by index.
- **Test scenarios:**
  - A reply with a "-----Original Message-----" line is cut at that line. This is untested today.
  - A reply with a `From:` line followed by `Sent:` or `Date:` (Outlook's header block) is cut there, and a lone `From:` line is not.
  - The existing opener cases in `test/outside-threads.test.ts` pass unchanged.
- **Verification:** no `OPENERS[` index remains.

### U7. Explicit states in the app

- **Goal:** three app states say which case they are in.
- **Requirements:** R10.
- **Dependencies:** none.
- **Files:** `app/src/agents/selection.ts`, `app/src/agents/agents.tsx`, `app/src/agents/reflection-page.tsx`, `app/src/chat/suggestion-card.tsx`, `test/agents-pages.test.ts`, a suggestion-card test in `test/`.
- **Approach:** per KTD4, a `kind` union for the selection (never picked, picked, deleted), the reflection settings (reading, unanswered, read) and the suggestion card's open card (newest shown, one picked, all closed).
- **Patterns to follow:** `ThreadState` in `app/src/chat/outside-card.tsx`.
- **Test scenarios:**
  - The agents page with nothing picked shows the first agent. After the picked agent is deleted, it shows the "deleted" state. After a reload, it shows the first agent again (`test/agents-pages.test.ts` pins these today).
  - The suggestion card with several suggestions opens the newest one. Picking another opens that one. Closing all leaves none open. This is untested today.
  - The reflection page shows its reading state, then its settings, and an unanswered read shows its unanswered state.
- **Verification:** none of the three states uses `null` and `undefined` to mean different things. Screens look the same.

### U8. Name the unknown mode in `looserThan`

- **Goal:** `looserThan` and `stricterMode` say what an unknown or missing mode means.
- **Requirements:** R11.
- **Dependencies:** U4.
- **Files:** `core/chat-links.ts`, `daemon/chat-backend.ts`, its existing test in `test/`.
- **Approach:** per KTD5, name what null means at the point of use: a mode loki does not know, ranked loosest in `looserThan` and strict as a cap in `stricterMode`. Keep `power()`'s return type and the null in frames.
- **Test scenarios:**
  - A cap of `null` (unknown, treated as strict) with an unrestricted chat mode gives strict.
  - An unknown ACP mode counts as looser than every loki mode.
  - Each pair of known modes compares as it does today.
- **Verification:** `chat_send` frames are unchanged, and existing tests pass.

---

## Verification Contract

| Check | When |
|---|---|
| `npm run lint:fast` and `npm run typecheck` | while working |
| `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:node` | before each push |
| `npm run build:app && npm run build:mod && npm run smoke` | before each push; smoke proves U2's daemon marker |
| CI on the pull request, Windows included | after each push |

Every check runs on CI's toolchain (the newest Node 22, npm 10, `SHELL=/bin/bash`). None of these units touches `src-tauri/`.

---

## Definition of Done

- Each pull request's units meet their Verification lines, and every check above passes locally and in CI.
- Existing tests pass unchanged, except the edits named in U1, U4 and U7.
- No new comment explains what the code now says itself; the only new comment is KTD3's contract doc comment.
- No value saved under `~/.loki`, sent in a frame, or shown on screen differs from before.
- No experiment or abandoned approach is left in the diff.
