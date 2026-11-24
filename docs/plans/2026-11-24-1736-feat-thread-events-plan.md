---
title: Events in the thread, each where it belongs - Plan
type: feat
date: 2026-11-24
topic: thread-events
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Events in the thread, each where it belongs - Plan

## Goal Capsule

- **Objective:** a chat reads as the conversation between you and the agent: what was said, what you did shown as yours, and everything loki fed the agent or noted about the chat reduced to a line or folded into the work that used it.
- **Means:**
  - Event rows that change say what kind they are, and core writes their words.
  - Rows from one message are placed by who they are for.
  - Each changed kind gets its own drawing on the Mac and the phone.
  - (KTD1–KTD3.)
- **Product authority:** the owner, who called the advisor's answer card unnecessary in the chat, accepted the five proposals ("Plan all of it"), and moved skill loads to the read steps they are.
- **Stop conditions:** stop and ask if a Claude Code Skill call doesn't reach loki with a title that names the skill. The adapter is expected to send `Load skill: ⟨name⟩`; if it doesn't, R5 can't hold on Claude Code.
- **Execution profile:**
  - The row model: `core/harness.ts`, `core/attention/thread.ts`, `core/attention/transcript.ts`.
  - The Mac thread: `app/src/item/`, `app/src/shared/tool-steps.ts`.
  - The phone thread and shared work block: `app/src/chat/transcript.tsx`, `app/src/chat/tool-steps.tsx`.
  - Tests and `docs/manual.md`.
  - Branch `feat/thread-events`, commit scope `chat`. Two PRs; this plan ships in the first (Sequencing).
- **Open blockers:** none.

---

## Product Contract

### Summary

- The advisor's answer becomes one line, "Advisor answered", with its verdict. It opens the Advisor tab, which holds the whole answer.
- A skill load is drawn as the read step it is.
- A message from another chat becomes a one-line marker heading the turn it starts.
- Your slash and `!` commands sit on your side with their result.
- Your canvas gestures read like the widget lines ("You moved 3 widgets").
- A model that couldn't be reached leaves no row once the agent carries on.
- Moving the chat to another Mac becomes a separator.
- Background task notices stay as steps in the work block, as today. So do suggestion chips, widget lines, the agent's plan, thinking and the compaction checkpoint.

### Problem Frame

Loki tells the agent about things by adding tagged context to the message the agent receives, and the thread turns each tag into an event row. Loki also writes rows of its own: your commands, compaction, an unreachable model.

Background task notices and skill loads already draw as steps in the work block (`isWorkRow`). Everything else draws as a free-standing row, and the advisor's answer as a full card with a preview, **Show More** and **Open Advisor**.

Two placement problems add to the noise:
- Rows from one message are placed before that message (`ThreadModel.user`), so they land in the previous agent turn.
- A skill load hides the step that caused it and shows as an outside event (`withoutSkillCalls`).

The `<skill_content>` tag behind "skill loaded" comes only from imported Letta history. Claude Code chats send a Skill call whose title names the skill, and loki's own engine reads `SKILL.md` with `read`.

### Requirements

**Agent-facing events**

- R1. An advisor answer shows as one line:
  - The line reads "Advisor answered · you asked" or "· the agent asked", then the answer's first line as plain text, cut to one line with an ellipsis. An answer with no usable first line shows the words alone.
  - A failure reads "Advisor couldn't answer · ⟨who asked⟩ · ⟨why⟩".
  - The whole line is a button: it opens the Advisor tab on the Mac and the advisor page on the phone. There is no **Show More**.
- R2. A message from another chat shows as one line, "From ⟨chat⟩ · ⟨its first line⟩". The line opens to the message. Inside the opened message, an **Open Chat** button opens that chat; the button is not part of the line.
- R3. On the Mac, a message that carries only an advisor answer or a message from another chat starts a new agent turn, headed by its lines. When you also wrote something, the lines follow your message at the start of the agent's turn. Several such lines from one message head one turn.

**Skills**

- R4. A skill load is a step in the work block titled "Read skill ⟨name⟩", never a row of its own.
  - On loki's engine, it is the `read` of `…/⟨name⟩/SKILL.md`, with the skill's text as its result.
  - On Claude Code, it is the Skill call, with the result the adapter returns.
  - In imported history, the `<skill_content>` text becomes the result of the Skill call it answers, kept whole.

**Your actions**

- R5. A slash or `!` command you ran shows on your side of the thread, outside the agent's turns, with a result line under it:

  | State | Result line | Mark |
  |---|---|---|
  | running | Running | a spinner |
  | done | its one-line output, or "Done" | none |
  | failed | "Failed", or "Failed: ⟨one line⟩" | the negative colour |

  Longer output opens from a disclosure button with `aria-expanded`. An empty result has nothing to open. On the phone the row is right-aligned like your messages. Command rows are live only and are not in history, as today.
- R6. Your canvas gestures show as one widget-style line just before the message they came with.
  - Wording: "You moved 3 widgets" when every gesture is a move; "You changed 3 widgets" when any gesture is something else.
  - The count is the distinct widgets touched, and one widget reads "1 widget".
  - "on ⟨canvas⟩" is added only when the canvas is not this chat's.
  - The line opens to the list of gestures.

**Chat status**

- R7. "The model could not be reached" leaves no row once the agent goes on, whether with text or with a step. While loki retries, the row shows the number of tries, as today.
- R8. A move between Macs shows as a separator, like the day line: "Moved to ⟨Mac⟩ · from ⟨Mac⟩". It is not interactive, and its `role="separator"` carries the same words in `aria-label`, on the Mac and the phone.

**Unchanged**

- R9. These draw as today:
  - background task notices, as steps in the work block;
  - "Suggested in another chat";
  - widget lines;
  - the agent's plan;
  - thinking;
  - compaction (a running line replaced by the checkpoint or the failure).

### Key Decisions

- **The advisor line shows the answer's first line, not a count of points.** Counting would mean guessing at the advisor's markdown, and its first line is its verdict. Governs R1.
- **A skill load is a read, not an event.** It is the agent's own step, and on loki's engine it already is a `read`; the owner chose this. Governs R4.
- **Background task notices stay in the work block.** Loki steers each notice into the running turn (`daemon/main.ts` delivers it with `"steer"`), and it already draws there as a step, which is what the owner's proposal asked for. Governs R9.

### Scope Boundaries

- What the agent receives, what loki stores and what loki tells the agent are unchanged. Only how rows are built for display and how they are drawn changes. Old chats show the new way, because the daemon builds history rows with the same `ThreadModel`.
- The phone has no turn blocks, so R3's placement there means order only.
- Considered and not built:
  - **A header badge for an unreachable model while it retries.** The header has no slot for chat status, and the retrying row sits at the bottom of the thread. Evidence that would change this: retries that leave the row scrolled out of view.
  - **The advisor's full answer behind Show More in the chat.** The Advisor tab and the phone's advisor page hold it.
  - **Event kinds for the unchanged rows** (suggested, compaction, task). They draw as today, so moving their word matching onto a field would widen the history-frame contract for no visible change.
  - **The skill's text on a Claude Code skill step.** The adapter returns only a confirmation, so showing it would mean loki reading `SKILL.md` itself. Evidence that would change this: the owner wanting the text there.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Changed rows say what they are, and core writes their words.**
  - `TranscriptRow` and `HarnessEvent` gain an optional `event` naming the kind: `advisor`, `chat_message`, `canvas`, `moved` or `command`.
  - The field is set where the row is built (`extractHarnessEvents`, and `ThreadModel`'s command rows).
  - It carries a doc comment, since history rows cross from the daemon to the Mac and the phone in history frames.
  - Core also writes each kind's on-screen words, in sentence case, into `text` and `summary`, so a lean history page keeps them. The renderers choose only how to draw from `event`.
  - A row without the field (an older daemon's page) draws as a plain event, as today.
  - Governs R1, R2, R5, R6, R8.
- KTD2. **Rows from one message are placed by who they are for.** `ThreadModel.user` places canvas rows, then your message, then the agent-facing rows. When the message is the echo of a row already shown (your own send, or a queued one), the canvas rows go in just before that row in the tail, and the agent-facing rows after it. Live and history then agree. Governs R3, R6.
- KTD3. **An advisor or chat-message row can open a turn.** In `threadTurns`, an `advisor` or `chat_message` row starts a new turn unless it directly follows your message or another such row. Both kinds reach the agent as follow-ups, never steered into a running turn. Governs R3.
- KTD4. **Skill steps are titled from what each engine sends.**
  - `stepTitle` and `stepTarget` read three things as "Read skill ⟨name⟩":
    - a call titled `Load skill: ⟨name⟩` (Claude Code over ACP);
    - a `Skill` or `skill` call (imported history);
    - a `read` of `…/⟨name⟩/SKILL.md` (loki's engine).
  - For imported history, `ThreadModel.user` hands a `<skill_content name=…>` to the latest Skill call for that name with no result yet, or with only a launch notice. It sets that step's output to the whole text, without `withResult`'s cap, and pushes no event.
  - An unmatched one stays a work row as today.
  - `withoutSkillCalls` goes.
  - Governs R4.
- KTD5. **Your commands are drawn as yours, built as events.** Command rows stay events (`event: "command"`), so they never count as your words for attention or turn state. On the Mac, `threadTurns` treats a command row as a turn boundary, as your message is, because R5 puts it outside the agent's turns. The phone right-aligns it. Governs R5.
- KTD6. **An unreachable model's row goes once anything follows in the turn.** `ThreadModel` already drops it when text follows; it also drops it when a call follows. Governs R7.

### Sequencing

- **PR 1** (carries this plan): U1, U2, U3 and the manual's advisor lines. It fixes the card the owner flagged, on the new placement.
- **PR 2**, stacked on PR 1: U4, U5, U6, U7 and the rest of the manual.

---

## Implementation Units

### U1. Event kinds, words and placement in core

- **Goal:** changed rows carry their kind and their words, and come in KTD2's order, live and in history.
- **Requirements:** R1, R2, R3, R6, R8.
- **Dependencies:** none.
- **Files:** `core/attention/transcript.ts`, `core/harness.ts`, `core/attention/thread.ts`, `test/harness.test.ts`, `test/thread-model.test.ts`.
- **Approach:**
  1. Add `event` to `TranscriptRow` and `HarnessEvent`, with its doc comment (KTD1).
  2. In `extractHarnessEvents`, set the kind and write the words for each changed kind:
     - Advisor: "Advisor answered · ⟨who⟩" or "Advisor couldn't answer · ⟨who⟩", with `summary` the first non-empty line of the answer, markdown marks removed and capped as today's preview is (or the failure reason). The whole answer stays in `detail`.
     - Chat message: "From ⟨chat⟩", with its first line in `summary`.
     - Canvas: "You moved/changed N widget(s)", with the verb and the count of distinct widgets read from the gesture lines; "on ⟨canvas⟩" only when the tag's scope is not this chat's. The lines stay in `detail`.
     - Moved: "Moved to ⟨Mac⟩", with "from ⟨Mac⟩" in `summary`.
  3. Reorder `ThreadModel.user` per KTD2, including the echo case.
- **Patterns to follow:** the existing `advisor_chat` and `link` fields on the same path; `mod/gestures.ts` for the gesture-line shapes.
- **Test scenarios:**
  - An advisor answer whose first line is `**The runner follows the plan.**` yields `event: "advisor"`, "Advisor answered · the agent asked" and the summary "The runner follows the plan.".
  - A failed consult yields "Advisor couldn't answer" with its reason.
  - Three `moved` lines for two widgets read "You moved 2 widgets"; a move and a `resized` line read "You changed 2 widgets"; one widget reads "1 widget".
  - A message with canvas gestures, words and an advisor answer builds canvas, your message, advisor.
  - `own()` and then the echo of that send carrying canvas gestures and an advisor answer gives canvas, your message, advisor, with no second user row.
  - An event-only message builds its rows with no user row, as today.
- **Verification:** the tests pass, and existing thread and harness tests pass, with an order expectation updated only where KTD2 changes it.

### U2. Advisor and chat-message rows open turns (Mac)

- **Goal:** R3.
- **Requirements:** R3.
- **Dependencies:** U1.
- **Files:** `app/src/item/entries.ts`, `test/item-entries.test.ts`.
- **Approach:** in `threadTurns`, apply KTD3. Turn state and the "Worked" time read each turn's own rows.
- **Patterns to follow:** how `threadTurns` closes a turn at your message.
- **Test scenarios:**
  - Agent turn, then an advisor-only message, then agent work: two turns, the second opening with the advisor line.
  - Your message, then an advisor row, then agent work: one turn, opening with the advisor line.
  - An event-only message with an advisor row and a chat-message row: one new turn opening with both.
  - A background task notice mid-turn stays a step in that turn (R9).
  - A suggested-chat or widget line does not start a turn.
- **Verification:** the tests pass.

### U3. The advisor's answer as one line (Mac and phone)

- **Goal:** R1.
- **Requirements:** R1.
- **Dependencies:** U1.
- **Files:** `app/src/item/event-entry.tsx`, `app/src/chat/transcript.tsx`, `test/advisor-answer-row.test.ts`.
- **Approach:**
  1. One line component, used by `EventEntry` and the phone's `EventRow`, draws the row's `text` and `summary` on one line, cut with an ellipsis.
  2. The line is a button that calls `OpenAdvisor` when it is provided, and plain text otherwise.
  3. Remove `AdvisorAnswerWhole` and **Show More**.
- **Patterns to follow:** the suggested-chat marker in `EventEntry` (an icon, words, the line as a button).
- **Test scenarios:**
  - The line shows "Advisor answered · the agent asked · The runner follows the plan." and is a button labelled to open the advisor chat.
  - Without `OpenAdvisor`, it is not a button.
  - A failure shows its reason.
  - There is no **Show More**.
- **Verification:** the tests pass. In the Mac app on the regular daemon, an answer reads as one line and opens the Advisor tab.

### U4. Skill loads as read steps

- **Goal:** R4.
- **Requirements:** R4.
- **Dependencies:** U1.
- **Files:**
  - Code: `core/attention/thread.ts`, `app/src/shared/tool-steps.ts`, `app/src/item/work.tsx`, `app/src/chat/tool-steps.tsx`.
  - Tests: `test/thread-model.test.ts`, `test/tool-steps.test.ts`.
- **Approach:**
  1. Title skill steps per KTD4.
  2. For imported history, hand `<skill_content>` to its Skill call per KTD4.
  3. Remove `withoutSkillCalls` and its uses in `work.tsx` and `chat/tool-steps.tsx`.
- **Patterns to follow:** how `result()` finds a step by id (not its capped output path).
- **Test scenarios:**
  - A call titled `Load skill: ce-plan` is titled "Read skill ce-plan".
  - A `read` of `/x/skills/apple-hig/SKILL.md` is titled "Read skill apple-hig"; a `read` of another file is titled as today.
  - A `Skill` call for `ce-plan` and then a `<skill_content name="ce-plan">` 6,000 characters long gives one step whose output is all 6,000 characters, and no event row.
  - A `<skill_content>` with no matching call stays a work row, its text intact.
- **Verification:** the tests pass. In the Mac app, a Claude Code chat that loads a skill and a loki chat that reads one each show a "Read skill ⟨name⟩" step and no event row. If the Claude Code title isn't `Load skill: ⟨name⟩`, that is the stop condition.

### U5. Your commands and canvas gestures as yours

- **Goal:** R5 and R6.
- **Requirements:** R5, R6.
- **Dependencies:** U1, U2.
- **Files:** `app/src/item/event-entry.tsx`, `app/src/item/entries.ts`, `app/src/item/timeline.tsx`, `app/src/chat/transcript.tsx`, `test/item-entries.test.ts`.
- **Approach:**
  1. A `command` row draws on your side per R5's table, on the Mac and the phone.
  2. On the Mac, `threadTurns` closes the open turn at it (KTD5).
  3. A `canvas` row draws like `ChangeEntry`, with the widget icon and its words, as a disclosure that opens to the list.
- **Patterns to follow:** `MessageEntry`'s alignment for your side; `ChangeEntry` for the widget-style line; the `Trace` collapsible for disclosure.
- **Test scenarios:**
  - A command row between two agent runs ends the first turn; the next agent work starts a new one below it.
  - A running command shows "Running".
  - A failed command shows "Failed: ⟨line⟩".
  - A command with no output has no disclosure.
- **Verification:** the tests pass. On the desktop and phone pages of the preview daemon, `/compact` and `!ls` sit on your side.

### U6. Lighter chat status

- **Goal:** R7 and R8.
- **Requirements:** R7, R8.
- **Dependencies:** U1.
- **Files:** `core/attention/thread.ts`, `app/src/item/event-entry.tsx`, `app/src/chat/transcript.tsx`, `test/thread-model.test.ts`, `test/item-entries.test.ts`.
- **Approach:**
  1. KTD6 in `ThreadModel.call`.
  2. A `moved` row draws as a separator with `DayMarker`'s look on the Mac and a centred separator on the phone, per R8.
- **Patterns to follow:** `written()`'s existing drop of the model-error row; `DayMarker`.
- **Test scenarios:**
  - Model error, then a call: no error row.
  - Model error, twice, then nothing: one row, "2 tries".
  - Model error, then text: no error row (as today).
  - A `moved` row draws a separator labelled "Moved to Studio · from MacBook Pro".
- **Verification:** the tests pass.

### U7. Chat-message line

- **Goal:** R2.
- **Requirements:** R2.
- **Dependencies:** U1, U2.
- **Files:** `app/src/item/event-entry.tsx`, `app/src/chat/transcript.tsx`, `test/item-entries.test.ts`.
- **Approach:** a `chat_message` row is a `Trace` disclosure line ("From ⟨chat⟩ · ⟨first line⟩"). Its opened content is the message, plus a separate **Open Chat** button through `OpenChat` when that is provided.
- **Patterns to follow:** `EventEntry`'s `Trace` branch; the suggested-chat marker's use of `OpenChat`.
- **Test scenarios:**
  - The line opens to the message and offers **Open Chat** when `OpenChat` is provided.
  - **Open Chat** is not inside the line's trigger.
- **Verification:** the tests pass.

### U8. The manual

- **Goal:** `docs/manual.md` describes the thread as built.
- **Requirements:** R1–R9.
- **Dependencies:** each PR's units.
- **Files:** `docs/manual.md`.
- **Approach:**
  1. PR 1 rewrites **The answer** paragraph under Advisor (one line, which opens the Advisor tab).
  2. PR 2 rewrites the lines on commands, skills, canvas activity, messages from other chats and moves.
- **Test expectation:** none -- documentation.

---

## Verification Contract

| Gate | Command or check | Applies to |
|---|---|---|
| Format, lint, types | `bun run format:check && bun run lint && bun run typecheck` | every PR |
| Tests | `bun run test && bun run test:node` | every PR |
| Builds and smoke | `bun run build:app && bun run build:mod && bun run smoke` | every PR |
| CI toolchain | Newest Node 22, the bun in `package.json`'s `packageManager`, `SHELL=/bin/bash` | before push |
| By hand: thread | Desktop and phone pages on `npm run phone-preview`'s daemon, via its `?t=` link. Check that a message from another chat (send one with the suggestion tools), a background task, `/compact` and `!ls` draw as R2, R9 and R5 say. The stored kinds (chat message, task, compaction) draw the same after a reload; commands are live only. | U2, U5, U7 |
| By hand: advisor | The Mac app on the regular daemon (the preview daemon can't make an advisor): the line, opening the Advisor tab; on the phone, opening the advisor page | U3 |
| By hand: skills | The Mac app: a Claude Code chat that loads a skill and a loki chat that reads one | U4 |
| By hand: move | A chat moved between the two Macs shows the separator (R8) | U6 |
| PR titles | `PR_TITLE="feat(chat): …" node --experimental-strip-types scripts/check-pr-title.ts` | every PR |

## Definition of Done

- R1–R9 each have a passing test or a by-hand check above.
- All checks pass with CI's toolchain, and each PR's CI, Windows included, is green.
- `withoutSkillCalls` and `AdvisorAnswerWhole` are gone.
- Screenshots of the advisor line and the command row are in the PRs.
- No comment outside the kinds AGENTS.md allows; the new `event` field carries its contract doc comment.
- This plan ships in PR 1.
