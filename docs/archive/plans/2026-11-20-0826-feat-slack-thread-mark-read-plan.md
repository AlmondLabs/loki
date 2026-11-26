---
title: Reading a Slack thread card marks the thread read in Slack - Plan
type: feat
date: 2026-11-20
topic: slack-thread-mark-read
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Reading a Slack thread card marks the thread read in Slack - Plan

## Goal Capsule

- **Objective:** after you read or archive a Slack thread card in loki, Slack's Threads view no longer shows that thread unread, so the count in Slack goes down with the card.
- **Means:** move the thread's own read point with Slack's undocumented `subscriptions.thread.mark`: forward on read (never back, R2), back only on undo (R4, KTD4), and only for a thread the person follows (KTD1, KTD2).
- **Product authority:** the owner, on 2026-11-20, after seeing that read marks the card's Activity item but leaves the thread unread in Slack's Threads view.
- **Stop conditions:** stop and ask if Slack's `conversations.replies` does not carry `subscribed` and `last_read` on a followed thread's first message, since KTD1 rests on it.
- **Execution profile:** the mod's Slack client and sync (`mod/`), their tests, and `docs/manual.md`. One branch, one PR, carrying this plan.
- **Open blockers:** none.

## Product Contract

### Summary

Read and archive on a Slack card already mark its Activity items read (plan 092) and a DM read. A reply in a followed thread also shows unread in Slack's Threads view, which has its own read point per thread, and loki never moves it. Now read and archive move it up to the newest message the card showed, and undo moves it back.

### Requirements

- R1. Read or archive on a Slack card for a thread the person follows marks the thread read in Slack up to the newest message the card showed. A reply after that stays unread.
- R2. A thread Slack already has read at or past that message is left alone: loki never moves a thread's read point back on read.
- R3. A DM card marks each followed thread its Activity items name (a reply in a thread inside the DM) the same way, and the DM itself as today. A card whose thread the person does not follow (a top-level mention with no replies, say) marks no thread.
- R4. Undo moves the thread's read point back to where it was before loki moved it.
- R5. If Slack refuses or fails, the card still ends (or comes back) in loki, its Activity items are still marked, and loki logs `slack:thread-mark-failed` with Slack's reason.
- R6. No channel's read marker moves, as today.

### Scope Boundaries

- Not built: undo after loki restarts. What was moved lives in memory, as for Activity items (plan 092); after a restart undo brings the card back in loki only. Evidence that would change it: undo after restart turning out common.
- Not built: asking `subscriptions.thread.get` for the read point. `conversations.replies` already carries it and is documented (KTD1).
- Not built: marking a DM unread on undo. It stays the known gap the manual names.

### Sources

- emacs-slack, [slack-thread.el](https://github.com/emacs-slack/emacs-slack/blob/master/slack-thread.el): marks a thread read with `subscriptions.thread.mark` (`channel`, `thread_ts`, `ts`), and only when the thread's current read point is not past `ts`.
- make-slack-great-again, [issue #118](https://github.com/punarinta/make-slack-great-again/issues/118): Slack's web client drives its Threads view with the `subscriptions.thread.*` calls; an Enterprise Grid workspace refused some of them with `team_is_restricted`.
- Plan 092 (`docs/plans/2026-11-11-092-feat-slack-activity-mark-read-plan.md`): the same shape for Activity items.

## Planning Contract

### Key Technical Decisions

- KTD1. The read point comes from the thread's first message as `conversations.replies` returns it: `subscribed: true` and `last_read`. Slack documents both, and `SlackSync.message` already reads `last_read` there. One page of one message per read or archive.
- KTD2. A thread is marked only when that first message says `subscribed` and its `last_read` is before the card's `newest_message_id` (R2, R3). That one check covers a thread the person does not follow and a top-level mention with no thread: neither is in the Threads view, so there is nothing to clear.
- KTD3. A thread mark never stops the rest: it is tried, logged on failure, and the DM mark and Activity mark go on as today (R5). Every error is logged, the account errors (`signed_out`, `ratelimited`) too, because the card is already ending and the next tick meets them anyway.
- KTD4. Undo marks the thread back to the remembered `last_read` (R4), kept in memory by card beside the Activity items, and forgotten once used.

### Risks

- The call is undocumented and could change or be refused (Enterprise Grid). R5 keeps loki working; the log says why.
- Whether Slack accepts a mark that moves a thread's read point back (R4) is not proven. emacs-slack's forward-only guard suggests it does. The by-hand check covers it.

## Implementation Units

### U1. The client marks a thread and reads its read point

**Goal:** `SlackClient` can read a thread's read point and move it.

**Requirements:** R1, R2, R3

**Dependencies:** none

**Files:** `mod/slack.ts`, `test/slack.test.ts`

**Approach:**
1. `subscriptions.thread.mark` joins `SLACK_METHODS`.
2. A method that marks a thread sends `channel`, `thread_ts` and `ts`.
3. A method that reads the thread's first message (`conversations.replies`, limit 1) gives its `last_read` when it is `subscribed`, and nothing otherwise.

**Patterns to follow:** `markDm` and `markActivity` in `mod/slack.ts`.

**Test scenarios:**
- Marking a thread posts `subscriptions.thread.mark` with the token, `channel`, `thread_ts` and `ts`.
- The read point of a followed thread is the first message's `last_read`.
- A first message without `subscribed` gives no read point.

**Verification:** the client tests pass, and no method outside `SLACK_METHODS` can be called.

### U2. Read, archive and undo move the thread's read point

**Goal:** `SlackSync.archive` marks a followed thread read up to the card's newest message, and `restore` moves it back.

**Requirements:** R1, R2, R3, R4, R5, R6

**Dependencies:** U1

**Files:** `mod/slack-sync.ts`, `test/slack-sync.test.ts`

**Approach:**
1. In `archive`, the card's threads are the one its `thread_id` names (channel and ts) for a channel card, and for a DM card each thread its remembered Activity items name (`channel` and `thread_ts`). For each, read the read point (KTD1). If KTD2 holds, mark the thread up to `newest_message_id` and remember the old read point by card (KTD4). Any failure is logged as `slack:thread-mark-failed` (KTD3).
2. This runs before the Activity mark, whose early return for a card with no items must not skip it.
3. In `restore`, a remembered read point is marked back and forgotten; a failure is logged the same way. This also runs before, and apart from, `restore`'s early return for a card with no remembered Activity items, so a card whose Activity mark failed or that had none still gets its thread back.
4. The fake workspace in `test/slack-sync.test.ts` answers `subscriptions.thread.mark` by moving the thread's read point, can refuse it, and gives a followed thread's first message `subscribed` and `last_read`.

**Patterns to follow:** the Activity mark in `archive` and `restore`, and its `marked` map.

**Test scenarios:**
- Reading a card for a followed thread marks the thread up to the card's newest message, and a later reply leaves it unread.
- A thread whose read point is already at or past the card's newest message gets no mark.
- A card for a top-level mention with no thread, a thread the person does not follow, and a DM card with no thread reply send no `subscriptions.thread.mark`.
- A DM card holding a reply in a followed thread inside the DM marks that thread, and the DM with `conversations.mark` as before.
- Undo marks the thread back to its old read point; a second read marks it forward again.
- Undo marks the thread back for a card whose Activity mark failed, and for one with no Activity items.
- Slack refusing the thread mark still ends the card, still marks its Activity items, and logs `slack:thread-mark-failed`.
- Slack failing to read the first message ends the card the same way and logs it.
- No read or archive sends `conversations.mark` for a channel.

**Verification:** the sync tests pass, and the existing Activity and DM tests pass unchanged.

### U3. The manual says what read does to a thread in Slack

**Goal:** `docs/manual.md` describes the thread mark, its undo and its failure log.

**Requirements:** R1, R4, R5

**Dependencies:** U2

**Files:** `docs/manual.md`

**Approach:** in "Email, Slack and Jira", the paragraph on what read and archive do in Slack gains the thread's read point, that undo moves it back, and `slack:thread-mark-failed`. Keep the line that no channel's read marker moves.

**Test expectation:** none -- documentation.

**Verification:** the paragraph matches what U2 does.

## Verification Contract

- Every check in `AGENTS.md` ("Before you push"), on CI's toolchain (Node 22).
- By hand, on the Mac that holds the Slack account: read one thread card in loki and see the thread leave Slack's Threads view; undo and see it come back unread there; look in `~/.loki/mod.log` for `slack:thread-mark-failed`.

## Definition of Done

- U1 to U3 are in one PR with this plan, and every check passes.
- The by-hand check is done before merge, its undo part included, because the fake workspace assumes Slack accepts a backward mark. If Slack keeps the thread read after undo, R4's Slack effect is dropped and the manual names it as a known gap, as it does for DMs.
- No dead code from abandoned attempts is left in the diff.
