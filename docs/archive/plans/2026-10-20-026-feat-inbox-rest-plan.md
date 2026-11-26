---
title: Next lets a stale card rest, longer each time
date: 2026-10-20
status: active
---

# Next lets a stale card rest, longer each time

## Why

Four weeks of the person's Inbox (1,007 card visits, 23 Sep to 19 Oct; a visit is every decision on one card
before moving on) say the top of the Inbox works and the tail does not:

1. The card shown first is the one acted on: typically no skip before it; rank 1 is acted on 69% of the time, and
   a card with something new from the last hour 83%.
2. Stale cards, with nothing new, are 43% of what is shown and acted on 18% of the time; 11–13% once the chat has
   been quiet over a day; 5% on the phone, where they are 61 of 88 visits.
3. The deck grows (a median 29 cards a pass in the week of 21 Sep, 42 by 19 Oct), since only archiving removes a
   chat and archive is 3% of decisions.
4. Next on a card in focus halves its chat's focus (2026-10-05), but a stale chat has little focus to lose, so it
   comes back at the same place every pass.

Until 2026-09-27 the Inbox had **Later** (⌘[): a card deferred along a ladder, 10m · 30m · 1h30 · 4h30 · 13h30 ·
1d, voided by new content, reset each day (`fc2a82e` removed it, with `core/attention/ladder.ts` and `snooze.ts`).
It was used 60 times in its last four days. It was dropped to make moving on one action; this plan keeps one action
and gives it the ladder back for the cards it suits.

## What changes

1. **Next on a stale card lets it rest.** A stale card is one with nothing new, no approval and no question. Next
   on it hides it from the Inbox for

   `rest = min(7 days, max(10 min × 3^(n − 1), quiet for))`

   where `n` counts the Nexts on that chat since the ladder last reset, and `quiet for` is the time since its last
   message. A chat just worked in rests 10 minutes the first time, 30 the second; a chat quiet for two days rests
   two days more. There is no daily reset: a stale chat no longer floods the first pass of each morning.
2. **Next on a card with something new is what it is now:** the chat is read, and the card rests for the first rung
   only (10 minutes), so an agent still working comes back in this pass. It does not climb the ladder.
3. **What resets the ladder** (back to `n = 0`, and the rest ends): something the person sends into the chat — a
   reply on the card, a message from the chat view, an answer to a question, an approval or a denial — or something
   new from the agent: a message, a question, an approval request. **Opening or reading never resets it**: the
   person reads many cards they then set aside (2026-10-20, their correction). Marking read or unread does not
   either.
4. **A Next straight after replying on the same card** is moving on, as now (`skipsFocus`'s rule): it rests the card
   for the first rung and does not climb.
5. **A stopped agent never rests**: an approval or a question shows whatever was pressed before.
6. **One mechanism.** The ladder replaces the focus skip (`SKIP_FACTOR`, the `skip` focus action and the `skips`
   marks between Macs). Focus goes back to measuring only what the person does; pushing a card away is the
   ladder's job alone.
7. **The end of a pass says what rests.** When only resting cards are left, the Mac and the phone show "You're caught
   up · 9 resting · go through them"; the last shows them, in score order, and Next on one there climbs as usual.
   No snoozed toggle, no Later section.
8. **Kept by the mod, shared.** Each chat's rest (`n`, until when, and the content stamp it was set against) lives
   in `state/attention.json` beside focus (`mod/seen.ts`), so the Mac and the phone see the same deck; paired Macs
   take each other's rests with the Inbox marks (the later rest per chat wins).
9. **No settings.** The constants (10 minutes, ×3, 7 days) are in code and in `docs/manual.md`, "The order".
10. **Measured.** `inbox_card_decided` and `inbox_card_shown` carry the card's rung (`rest_n`) and whether it came
    back from rest (`rested`); `npm run analytics` reports how often a card back from rest is acted on, by rung.
    Target: clearly above today's 18% for stale cards, or the constants change.

## Where

1. `core/attention/rest.ts` (new): the rest of a chat after a Next, whether a rest still holds for an item (its
   stamp, a stopped agent, the clock), and what resets it. Pure, with the clock passed in.
2. `core/attention/queue.ts`: `inboxQueue` and `catchUpQueue` leave resting cards out, and say how many rest.
3. `core/attention/focus.ts`, `mod/seen.ts`, `core/frames.ts`: the skip action and `skips` go; `seen.ts` keeps
   rests and sends them in its snapshot; the `seen` frame carries them to clients.
4. `core/attention/use-attention.ts`: Next asks the mod to rest the card (the focus skip call it replaces);
   sending, answering and deciding reset it.
5. `app/src/desk/catch-up-parts.tsx`, `app/src/phone/inbox.tsx`, `app/src/phone/deck.ts`: the caught-up line and
   "go through them".
6. `core/analytics.ts`: the two properties and the report line.
7. `docs/manual.md`, "The order" and the Inbox's keys: Next, the ladder, what resets it.

## Decisions for the person

1. **Next on a new card rests it 10 minutes**, rather than not at all: a card the person moved past should not be
   the next one up again a moment later. Proposed: yes.
2. **The cap is 7 days**, so even a long-quiet chat comes past once a week until it is archived. Proposed: yes.

## Tests

1. `rest.ts`: the ladder's rungs; `quiet for` lengthening a rest; the 7-day cap; a new message, a question or an
   approval voiding a rest; sending resetting `n`; opening and reading leaving it; a stopped agent never resting;
   a Next after a reply not climbing.
2. The queue: resting cards left out and counted; one coming back when its rest ends or its content changes.
3. `seen.ts`: rests kept across a restart, sent in the snapshot, and the later rest taken from a paired Mac.
4. The analytics report: a card back from rest acted on, by rung, from a small event log.
5. By hand: Next through a pass of stale chats, see "caught up · n resting"; reply in one from the chat view and see
   it back in the Inbox.
