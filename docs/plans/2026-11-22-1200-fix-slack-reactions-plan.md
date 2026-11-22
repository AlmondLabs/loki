---
title: Reactions on a Slack card match Slack - Plan
type: fix
date: 2026-11-22
topic: slack-reactions
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Reactions on a Slack card match Slack - Plan

## Goal Capsule

- **Objective:** the reaction pills on an open Slack card match Slack: other people's reactions arrive while the card is open, a reaction Slack refuses says why, and one emoji never shows as two pills because it has two names.
- **Means:** an open Slack card reads Slack again about once a minute, and that read also brings back the messages already showing, for their reactions (KTD1, KTD2). The card keeps Slack's refusal and shows it under the message (KTD3). A pill and a pick are the same reaction when they draw the same emoji, and the emoji search answers with Slack's own name for an emoji (KTD4).
- **Product authority:** the owner, through the session that asked for a review of reactions in Flow; their words on the review's findings: "Yes, fix top three". This plan covers those three findings; the rest of the review stays out (Scope Boundaries).
- **Stop conditions:** stop and ask if reading the shown messages again would mean more than one extra Slack call per refresh.
- **Execution profile:** the Slack card view in the mod (`mod/slack-view.ts`, `mod/slack-markup.ts`), one optional ask field (`core/frame-types.ts`, `core/frames.ts`), the card's thread hook and reaction controls (`app/src/desk/outside-card.tsx`, `app/src/desk/slack-thread.tsx`, `app/src/desk/slack-reactions.tsx`, `app/src/item/outside-rows.tsx`), tests, and the manual. Branch `fix/slack-reactions`, commit scope `inbox`.
- **Open blockers:** none.

---

## Product Contract

### Summary

A Slack card in Flow keeps its reactions current while it is open: someone's ✅ on your question shows up within about a minute, without leaving the card. When Slack refuses a reaction, the pill goes back and a line under the message says why; a failed emoji search says it failed instead of "No emoji by that name". Picking 👍 by any of its names joins the 👍 already there, or takes yours back.

### Problem Frame

A review of reactions across Flow found three faults on Slack cards (plan 079 built them):

1. **Stale pills.** An open Slack card reads Slack again only when a new message reaches it, and in a channel or DM that read starts after the last message shown. So a reaction added to a shown message, the one that brought the card included, never appears until the card is left and opened again. A thread already reads whole and refreshes its reactions, but only on a new message too.
2. **Silent refusals.** When Slack refuses a reaction (the account disconnected, the message deleted, no permission), the pill quietly goes back. A failed emoji search shows "No emoji by that name".
3. **Two pills for one emoji.** The search answers with the best-matching name for an emoji: typing `thumbsup` gives `thumbsup`, while Slack keeps 👍 as `+1`. The card matches pills by name, so it adds a second 👍 pill, and picking 👍 that way can't take back a `+1` you already have.

### Requirements

- R1. A reaction someone adds to or takes off a message showing on an open Slack card shows there within about a minute, in a channel, a DM or a thread, while the window is in front.
- R2. A new message still joins the card as today; reading the shown messages again changes nothing else about them (marks, unread lines, loaded pages, the scroll place).
- R3. When Slack refuses a reaction, the pill goes back and a line under that message says what failed and why. The line goes away on the next reaction.
- R4. A failed emoji search says it failed and why, not "No emoji by that name".
- R5. A reaction the person already has is recognised under any name that draws the same emoji: picking it takes theirs back, and picking it when only others have it joins their pill. No second pill appears.

### Acceptance Examples

- AE1. **Covers R1, R2.** A channel card shows messages A, B, C, with C the newest. Someone reacts ✅ to A in Slack. Within about a minute the card shows ✅ 1 under A, and nothing else moves.
- AE2. **Covers R3.** The account is disconnected; pressing 👀 on a message puts the pill back and shows "Couldn't add the reaction: that account is not connected now: …" under it.
- AE3. **Covers R5.** A message shows 👍 2 with yours outlined. Searching `thumbsup` and picking 👍 takes yours back (👍 1), with no second pill.

### Scope Boundaries

- Reactions from the phone, display of reactions on the phone, the hover bar on a just-sent reply, a fast double press racing in Slack, Gmail's own reaction mails, and merging the two pill components: findings from the same review the owner did not pick.
- A channel card scrolled up with more messages after it (`more_after`) does not refresh, as today; it refreshes once the person loads to the end.
- No refresh while the window is in the background; it resumes on the next tick once in front.

### Sources / Research

- Refresh today: `useOutsideThread` re-reads on `[key, tag, view, newest, went]` (`app/src/desk/outside-card.tsx`); `refreshAsk` asks a channel for messages after the last shown, and `withNewer` takes reactions only from messages the read returns. The mod's `after()` reads `conversations.history` with `oldest`, which Slack treats as exclusive (`mod/slack-view.ts`). Only `test/steady-view.test.ts` covers a thread.
- Refusals: `useReactControls` rolls back on a refusal and drops the reason; `searchEmoji` maps a refusal to `[]` (`app/src/desk/outside-card.tsx`).
- Names: `searchEmoji` dedupes by drawn emoji and keeps the first-ranked name (`mod/slack-markup.ts`); `toggleReaction` (`app/src/desk/slack-reactions.tsx`) and the picker's `pick` (`app/src/desk/slack-thread.tsx`) compare by name. emojibase's iamcal list gives `1F44D: ["+1", "thumbsup"]`, the first being iamcal's `short_name`, the name Slack shows.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **An open Slack card reads again about once a minute while the window is in front.** A new message was the only trigger, and a reaction moves nothing the deck sees (`newest_message_id` stays). A one-minute tick, skipped while `document.visibilityState` is hidden, costs per open card per minute one `conversations.info` and two or more `conversations.history` calls (the newer page, the shown range) for a channel or DM, or one whole-thread read, well inside Slack's tier 3. The phone's card shares the hook, so it ticks too. It reuses the existing refresh path, so a thread re-reads whole as today. Governs R1.
- KTD2. **The refresh read brings back the shown messages too, through one optional ask field.** `OutsideWindowAsk` gains `shown_from`: with `direction: "after"`, the mod also reads the messages from `shown_from` up to `from`, both included, in one `conversations.history` call (newest 100), and returns them with the newer ones. `withNewer` already takes reactions from returned messages it shows and adds only those newer than the last, so it needs no change. Those messages are drawn without their reply counts, so the refresh makes no thread reads; `withNewer` takes only their reactions. An older mod ignores the field and the card behaves as today. Governs R1, R2.
- KTD3. **The card keeps the refusal beside the message it was for.** `useReactControls` holds `{ messageId, text }` for the last refusal and clears it on the next reaction; each row's `RowReacting` carries its own line, drawn under its pills on the deck row and the item row. Search hands its refusal to the picker, which shows "Couldn't search emoji: …". Governs R3, R4.
- KTD4. **A reaction is the drawn emoji, not its name.** In the app, `toggleReaction` and `pick` find a pill by name or by the same drawn emoji (image, else character); when one is found, the reaction is sent under the pill's own name, the one Slack keeps. In the mod, `searchEmoji` answers a standard emoji with its iamcal short name (`+1` for `thumbsup`), the name Slack uses, so a new pill gets Slack's name too. A skin tone draws differently, so it stays its own pill, as in Slack. Governs R5.

### Assumptions

- Slack keeps a reaction under the emoji's canonical name (`thumbsup` reads back as `+1`). Slack's method docs (`reactions.add`, `reactions.remove`, `emoji.list`) say nothing about aliases; a third-party CLI's docs say the API normalises `thumbsup` to `+1`, and a recorded `reaction_added` payload in a bolt-js issue shows `+1`. Whether `remove` with an alias removes the canonical one, and which name a workspace alias is kept under, is unrecorded. KTD4 works either way: the app matches by drawn emoji and sends the pill's own name, and a workspace alias draws the same image as its target. The by-hand check confirms it on a real workspace.

### Risks

- A refresh asked before a reaction press and answered after it would put Slack's older state back on that pill; the card keeps the reactions of any message reacted to after the read was asked.
- The tick reads Slack while a card sits open for hours. One call a minute per open card is small; a rate-limit refusal leaves the card as it was until the next tick.
- Drawing the shown messages again re-reads their people and file previews; both are cached per account, so the cost is the history call.

---

## Implementation Units

### U1. Shown messages on a refresh read (mod and frame)

**Goal:** a channel or DM read with `direction: "after"` and `shown_from` also returns the shown messages.
**Requirements:** R1, R2; KTD2.
**Dependencies:** none.
**Files:** `core/frame-types.ts`, `core/frames.ts`, `mod/slack-view.ts`, `test/slack-view.test.ts`, `test/frames.test.ts`.
**Approach:** add `shown_from?: string` to `OutsideWindowAsk` with a doc comment; parse it in `account_thread_read`; in the channel branch of the Slack card view, when the ask has `shown_from`, read `conversations.history` from `shown_from` to `from` inclusive and draw those messages with their flags (no `repliesOf`), before the newer page.
**Test scenarios:** a refresh ask returns the shown messages with their current reactions and the newer ones after them, in order, `more_after` from the newer page alone; without `shown_from` the read is as today; the frame keeps `shown_from` and drops a non-string.

### U2. The card refreshes and takes the shown reactions (app)

**Goal:** an open Slack card asks with `shown_from` and refreshes every minute while in front.
**Requirements:** R1, R2; KTD1, KTD2.
**Dependencies:** U1.
**Files:** `app/src/desk/outside-card.tsx`, `test/steady-view.test.ts`.
**Approach:** `refreshAsk` adds `shown_from` (the first shown message) to a channel ask; a tick in `useOutsideThread`, an interval effect that cleans up and skips while hidden, joins the refresh effect's dependencies for Slack cards.
**Test scenarios:** `refreshAsk` on a channel window gives `shown_from` and `from`; `withNewer` given a channel read with the shown messages takes their reactions (one gaining, one losing all) and adds only the newer message, keeping marks and the window; a thread ask is unchanged.

### U3. Refusals said (app)

**Goal:** a refused reaction and a failed search say why.
**Requirements:** R3, R4; KTD3.
**Dependencies:** none.
**Files:** `app/src/desk/outside-card.tsx`, `app/src/desk/slack-thread.tsx`, `app/src/desk/slack-reactions.tsx`, `app/src/item/outside-rows.tsx`, `test/slack-view.test.ts`.
**Approach:** `ThreadControls.searchEmoji` answers `EmojiChoice[] | string`; the picker shows a string as "Couldn't search emoji: …". `useReactControls` keeps the last refusal by message and exposes it; `RowReacting` carries the line for its row; `SlackRow` and the item row draw it.
**Test scenarios:** a row whose message has a refusal draws the line under its pills, and others don't; the picker given a refused search draws the reason, not "No emoji by that name"; the line wording for add and remove.

### U4. One reaction per drawn emoji (app and mod)

**Goal:** aliases never make a second pill.
**Requirements:** R5; KTD4.
**Dependencies:** none.
**Files:** `app/src/desk/slack-reactions.tsx`, `app/src/desk/slack-thread.tsx`, `mod/slack-markup.ts`, `test/slack-view.test.ts`, `test/slack-markup.test.ts`.
**Approach:** a `sameReaction` helper (same name, or same drawn image or character); `toggleReaction` and `pick` use it and send under the pill's name; `searchEmoji` answers the iamcal short name for a standard emoji.
**Test scenarios:** toggling `thumbsup` on a `+1` pill that is yours takes it back; on others' `+1` joins it; a skin-tone 👍 stays its own pill; `searchEmoji("thumbsup")` answers `+1`; a workspace emoji keeps its name.

### U5. Manual

**Files:** `docs/manual.md`. Say that reactions refresh about once a minute while the card is open, and that a refused reaction says why. **Test expectation:** none.

---

## Verification Contract

| Gate | Command or check |
|---|---|
| Format, lint, types | `bun run format:check && bun run lint && bun run typecheck` |
| Tests | `bun run test && bun run test:node`, with CI's toolchain (newest Node 22, the bun in `packageManager`, `SHELL=/bin/bash`) |
| Builds | `bun run build:app && bun run build:mod && bun run smoke` |
| By hand (owed) | On the regular daemon: react to a shown message from Slack and see it within a minute; react with 👍 found as `thumbsup` on a message with `+1`; disconnect an account and press a pill. |

## Definition of Done

R1–R5 hold with tests for U1–U4, the manual says so, every gate passes, and the by-hand checks are listed as owed in the report.
