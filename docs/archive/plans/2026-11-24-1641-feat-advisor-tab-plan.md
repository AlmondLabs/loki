---
title: The advisor as a tab beside Messages and Canvas - Plan
type: feat
date: 2026-11-24
topic: advisor-tab
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# The advisor as a tab beside Messages and Canvas - Plan

## Goal Capsule

- **Objective:** on the Mac, a chat's advisor is one click away in the same place as the chat's other views, and going back and forth never loses the chat's header or its place.
- **Means:** the chat pane's switch becomes **Messages | Advisor | Canvas** once the chat has an advisor, and the Advisor tab shows the advisor chat in the pane body (KTD1, KTD2).
- **Product authority:** the owner, who asked for the advisor to sit between Messages and Canvas and confirmed the scope below.
- **Stop conditions:** stop and ask if the third tab doesn't fit the toolbar's middle at the narrowest pane width the app allows (the segmented control would wrap or overlap the title). Stop and ask if any path that opens the advisor chat today (the strip, **Open Advisor** on an answer, Flow's card) can't reach the tab.
- **Execution profile:** the Mac chat pane (`app/src/desk/`), the shell's wiring (`app/src/shell/shell.tsx`, `app/src/shell/keymap.ts`), the tab component (`app/src/components/index.tsx`), tests, and `docs/manual.md`. Branch `feat/advisor-tab`, commit scope `chat`.
- **Open blockers:** none.

---

## Product Contract

### Summary

The Mac chat pane's segmented control gains an **Advisor** tab between **Messages** and **Canvas**, shown once the chat has an advisor. It holds the advisor chat under the chat's own header, replacing today's page that takes over the pane behind a back button. The tab carries the advisor's state, so the advisor strip goes from the Mac pane's header. The floating chat on the Canvas tab, Flow and the phone keep their strip or page; opening the advisor from any of them on the Mac lands on the tab.

### Problem Frame

Today the advisor shows as an **Advisor · model** strip in the chat header. Clicking it, or **Open Advisor** on an answer, swaps the whole pane for an advisor page with its own header and a back control. The chat's header, its views and its tab switch disappear while you read the advisor, and getting back is a separate control in a different place. The advisor is another view of the same chat, so the owner wants it reached the way the chat's other views are.

### Requirements

**The tab**

- R1. Once a chat has an advisor, the Mac chat pane's switch reads **Messages | Advisor | Canvas**; a chat with no advisor keeps **Messages | Canvas**, and the tab appears when the first consult makes the advisor.
- R2. The Advisor tab shows the advisor chat (every consult and answer, and a message box that writes to the advisor, as today) in the pane body under the chat's own header, with no back control.
- R3. The tab shows the advisor's state: a working mark while it answers and a warning mark after a failed consult, with the strip's words (**Advisor is answering · 2 waiting**, **Advisor couldn't answer: why**, **Advisor · model**) in its tooltip and its accessible description, so the state is never carried by a mark alone.
- R4. The chat header on the Mac pane no longer shows the advisor strip; chat links still show there.

**Getting there and back**

- R5. Every Mac path that opens the advisor chat today lands on the Advisor tab of that chat: **Open Advisor** on an answer, the strip in the floating chat on the Canvas tab, and Flow's card.
- R6. Esc (outside a text box) on the Advisor tab goes back to Messages, as it does from Canvas.
- R7. The tab follows the rules Canvas keeps: a switch that isn't an open (the mod's `switch_desk`) keeps a chat's tab, and opening a chat from the list, ⌘[ ⌘], ⌘K or Flow lands on Messages unless the open was to its advisor.
- R8. On the Advisor tab, the chat keys that act on a conversation act on the advisor's: ⌘L focuses its message box, ⌘F finds in it, and the model key opens its model picker.

**Unchanged**

- R9. The floating chat window keeps its advisor strip, and the phone keeps the advisor chat as a page of its own.

### Scope Boundaries

- The phone, and the floating chat window's own header, are not changed (R9).
- How the advisor works, what it reads, its cap and its answer rows are not changed.
- Considered and not built: always showing the Advisor tab with an empty state before the first consult. A tab that opens on nothing is a dead end until the agent or you consult; the tab appearing with the first consult tells you an advisor now exists. Evidence that would change this: the owner wanting to start an advisor chat from the tab.
- Considered and not built: keeping the advisor chat mounted after you leave its tab, as Messages and Canvas stay mounted. It would load the open chat's advisor thread whenever a chat with an advisor opens, even if you never look at it. Leaving it remounts it at its latest message, as the takeover page does today. Evidence that would change this: losing a scroll position in a long advisor chat being a real annoyance.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **`advisor` is a third `DeskTab`, and its own `PaneView`.** `app/src/desk/pane.ts` gains the tab and a view `advisor`, so the existing tick routing (`routeTick`, `tickFor`) sends ⌘L, ⌘F and the model key to the advisor's conversation without a new mechanism, and `escapeTab` handles it beside `desk`. `chatKeyTarget` sends focus, find and model to `advisor` on that tab and nothing else (the advisor has no permission mode or suggestions). Governs R6, R7, R8.
- KTD2. **The advisor chat id comes from the chat's own advisor view, and the shown tab is derived once.** The tab exists when the chat's advisor is set, and its panel reads its `advisor_chat`; each chat has at most one advisor, so `OpenAdvisor`'s argument is the same id. The shell's `advising` state, and the `advisorChat`, `onOpenAdvisor`, `onCloseAdvisor` props on `DeskPane`, go. A stored tab of `advisor` on a chat with no known advisor (just opened, before its state arrives, or its advisor dropped while you were on the tab) shows Messages. A pure helper in `app/src/desk/pane.ts` makes that call; the shell computes it from the current chat's state, which it already holds through catch-up, and passes the result to `DeskPane` as `tab`, to `chatKeyTarget` and to `escapeTab`, so keys and Esc follow what is on screen. `DeskPane` derives no tab of its own. Governs R1, R2, R5, R6, R8.
- KTD3. **The advisor's conversation becomes a panel, not a pane.** `AdvisorPane` in `app/src/desk/advisor-pane.tsx` loses its header and its outer pane and becomes the body of the third tabpanel, mounted only while its tab shows (Scope Boundaries). `AdvisorPaneHeader`, its test and the `.loki-advisor-back` style go. `advisorConversation` and `lokiModels` stay as they are. Governs R2.
- KTD4. **A tab can carry a state.** `Tab` in `app/src/components/index.tsx` gains an optional status: a glyph shown after the label and words given as the trigger's tooltip and accessible description. The advisor tab's glyph and words come from the strip's `stripOf` in `app/src/chat/advisor-header.tsx`, exported rather than copied, so the strip and the tab never disagree. `stripOf` gains a `detail`: its `text`, plus `: <why>` after a failed consult. The tab uses `detail` for its tooltip and accessible description and the strip's glyph for its state; the strip keeps its `label`. The idle state shows no glyph. Governs R3.
- KTD5. **Opening the advisor from outside the pane is an open plus a tab choice.** `useDeskPane` gains a way to choose a tab for a given chat; the shell's `openAdvisor` (Flow's card) opens the chat, which lands on Messages, then chooses `advisor` for it, as the two state updates queue in order. Inside the pane, `OpenAdvisor` chooses the tab directly. Governs R5, R7.

### Sequencing

U1 (the pane's state) first, then U2 (the tab's status), then U3 (the pane uses both), then U4 (the manual and the keymap's words).

---

## Implementation Units

### U1. The advisor tab in the pane's state

- **Goal:** `app/src/desk/pane.ts` and `useDeskPane` know the Advisor tab: its view, its keys, Esc, and choosing it for another chat.
- **Requirements:** R6, R7, R8.
- **Dependencies:** none.
- **Files:** `app/src/desk/pane.ts`, `app/src/desk/use-desk-pane.ts`, `test/desk-pane.test.ts`.
- **Approach:** per KTD1, KTD2 and KTD5. `paneView` maps `advisor` to the `advisor` view; `escapeTab` returns to Messages from `advisor` as from `desk`; `chatKeyTarget` per KTD1; the shown-tab helper per KTD2; `useDeskPane` exposes choosing a tab for a named chat.
- **Patterns to follow:** the existing `desk` cases and their tests in `test/desk-pane.test.ts`.
- **Test scenarios:**
  - Esc on the Advisor tab goes back to Messages; Esc while typing there belongs to the box.
  - Opening a chat left on Advisor lands on Messages; a switch that is not an open reads Advisor.
  - Stored Advisor with no known advisor shows Messages: ⌘⇧P (mode) reaches `messages`, and Esc is not the pane's.
  - The visible view is `advisor` on the Advisor tab, and nothing when another section shows.
  - On the Advisor tab, ⌘L, ⌘F and the model key reach `advisor`; ⌘⇧P (mode), ⌘⇧S (suggestions) and the inset's own keys (⌘/, ⌘W, ⌘← ⌘→) reach nothing.
  - A tick bumped on Advisor reaches `advisor` only, and switching to Messages without a bump delivers nothing.
  - Choosing Advisor for a chat that is not the current one sets that chat's tab and leaves the current one's alone.
- **Verification:** the tests pass, and every existing `desk-pane` test still passes unchanged.

### U2. A tab that carries a state

- **Goal:** the segmented control can show a tab's status as a glyph plus words, and the advisor's state is one function both the strip and the tab read.
- **Requirements:** R3.
- **Dependencies:** none.
- **Files:** `app/src/components/index.tsx`, `app/src/chat/advisor-header.tsx`, `app/src/components/components.css` (only if the glyph needs spacing off the token scale's existing tab gap), `test/advisor-header.test.ts`.
- **Approach:** per KTD4. Export `stripOf` with its new `detail` and the glyph per state; `TabRow` renders a tab's status glyph after its label, drawn as the strip draws it, and puts the words on the trigger's `title` and accessible description. Styles stay on the scales in `docs/design.md`.
- **Patterns to follow:** `count` on `Tab` and its rendering in `TabRow`; the strip's existing tests.
- **Test scenarios:**
  - A tab with no status renders as today (the Messages and Canvas tabs' markup is unchanged).
  - The advisor idle: the tab reads **Advisor**, no glyph, tooltip **Advisor · gpt-6**.
  - Working with two waiting: a working glyph, tooltip and description **Advisor is answering · 2 waiting**.
  - A failure: a warning glyph, tooltip and description carrying the reason.
  - The strip still renders exactly as its existing tests expect, from the same state function.
- **Verification:** the tests pass; `test/tokens.test.ts` passes.

### U3. The pane shows the Advisor tab

- **Goal:** `DeskPane` offers the third tab, renders the advisor chat in it, drops the header strip, and every Mac path into the advisor lands there.
- **Requirements:** R1, R2, R4, R5, R7, R8, R9.
- **Dependencies:** U1, U2.
- **Files:** `app/src/desk/desk-pane.tsx`, `app/src/desk/advisor-pane.tsx`, `app/src/shell/shell.tsx`, `app/src/chat/chat.css`, `test/advisor-header.test.ts`, `test/desk-pane.test.ts`.
- **Approach:**
  1. `DeskPane` builds its tabs from whether `view.advisor` is set, the Advisor tab in the middle with U2's status (R1, R3), and shows the tab the shell derives per KTD2.
  2. A third tabpanel renders the advisor panel per KTD3 while its tab shows, passing the focus, find and model ticks for the `advisor` view (R8).
  3. `OpenAdvisor` inside the pane chooses the Advisor tab (R5); the header's `links` keep `LinkHeader` and lose `AdvisorHeader` (R4).
  4. `shell.tsx` drops `advising` and its props, derives the shown tab per KTD2, and `openAdvisor` follows KTD5.
  5. `useTabFocus` treats the Advisor tab like Canvas: arriving on Advisor with focus left behind in the panel being left (as after **Open Advisor** in the thread) moves focus to the selected Advisor tab, and coming back to Messages returns focus to where it was in the thread.
  6. `AdvisorPaneHeader`, its test and `.loki-advisor-back` go (KTD3). `chat-window.tsx` and `app/src/phone/` are untouched (R9).
- **Patterns to follow:** the Messages and Canvas tabpanels in `DeskPane` (`role="tabpanel"`, `panelId`, `aria-hidden`); `DeskMessages` for how ticks reach `Conversation`.
- **Test scenarios:**
  - The pane's tabs for a chat with no advisor are Messages and Canvas; with one, Messages, Advisor, Canvas in that order, as a pure helper exported for the test.
  - A tab of Advisor on a chat whose advisor is not known yet shows Messages (KTD2).
  - The Mac pane's header markup contains no advisor strip, and still contains a chat link when the chat has one.
  - The phone's conversation header and the floating chat's header still show the strip (existing tests keep passing).
- **Verification:** the tests pass, and the by-hand rows of the Verification Contract.

### U4. The manual and the keymap's words

- **Goal:** the manual and the shortcut table describe the tab.
- **Requirements:** R1–R9.
- **Dependencies:** U3.
- **Files:** `docs/manual.md`, `app/src/shell/keymap.ts`.
- **Approach:**
  1. The chat-pane paragraph that names **Messages** and **Canvas** as the segmented control adds **Advisor** between them, once the chat has one.
  2. The advisor's **Where it shows** paragraph says the Mac shows the state on the Advisor tab, and the floating chat and phone on the strip.
  3. **The advisor chat** paragraph says the Mac opens it on the chat's Advisor tab; the phone sentence stays.
  4. The Esc line ("Esc peels one layer… then the Canvas tab") and the `desk.messages` label name the Advisor tab beside Canvas.
- **Test expectation:** none -- documentation and a label.

---

## Verification Contract

| Gate | Command or check | Applies to |
|---|---|---|
| Format, lint, types | `bun run format:check && bun run lint && bun run typecheck` | all units |
| Tests | `bun run test && bun run test:node` | U1–U3 |
| Builds and smoke | `bun run build:app && bun run build:mod && bun run smoke` | all units |
| CI toolchain | Newest Node 22, the bun in `package.json`'s `packageManager`, `SHELL=/bin/bash` | before push |
| By hand: the tab | Desktop page on `npm run phone-preview`'s daemon: a chat with no advisor shows two tabs; `/advisor` with a question adds the Advisor tab in the middle, its working mark while it answers, then the idle tab with the model in its tooltip (R1, R3) | U3 |
| By hand: reaching it | **Open Advisor** on an answer, the strip in the floating chat on Canvas, and Flow's card each land on that chat's Advisor tab, the chat's header still there, with focus on the Advisor tab after **Open Advisor** (R2, R5) | U3 |
| By hand: keys | On Advisor: ⌘L focuses the advisor's box, ⌘F finds in it, Esc outside the box returns to Messages and back to Messages focuses where you were in the thread, and ⌘[ ⌘] away and back lands on Messages, as from Canvas (R6–R8) | U3 |
| By hand: width | At the narrowest pane width, the three tabs sit in the toolbar's middle without wrapping or covering the title (stop condition) | U3 |
| By hand: Mac app | The above in the Mac app on the regular daemon, with a screenshot for the PR | U3 |
| PR title | `PR_TITLE="feat(chat): …" node --experimental-strip-types scripts/check-pr-title.ts` | the PR |

## Definition of Done

- R1–R9 each have a passing test or a by-hand check from the Verification Contract.
- All checks pass with CI's toolchain, and the PR's CI, Windows included, is green.
- `AdvisorPaneHeader`, the shell's `advising` state and the `.loki-advisor-back` style are gone, not left unused.
- No comment outside the kinds AGENTS.md allows.
- This plan ships in the PR that builds it, with a screenshot of the three tabs.
