# Plan 090: a Slack card keeps its view while new messages come

2026-11-10 · changes plan 077's R15 and plan 085's stale opened thread

## Why

A Slack card's view was tied to its newest message. Any new message, the person's own reply included once Slack sent
it back, made the card start over: a thread the person had opened closed back to the channel, what they had loaded
with load earlier or load later was dropped, and the card flashed "reading the whole thread…" on the way. Reading a
busy channel or replying in a thread, the person lost their place.

## What

1. A card is its conversation: its account and thread. A newer message is the same card.
2. A thread the person opened stays open until they press back or another card comes on top.
3. A newer message is added at the end of what the card shows. The rows above stay as they were drawn: what was
   loaded, the New line and the mention look. Shown messages take their reactions as they are now.
4. The view does not change: the card's own thread stays its thread even when the Mac would now open the channel.
5. The box follows a new message to the bottom only when the person was at the bottom already, or when it is their
   own, as Slack does; rows brought by load later are not followed.
6. A channel or DM with more after what was loaded reads nothing new: load later reaches it. A thread with replies
   after what was loaded keeps that gap and its count goes up.
7. Leaving the card and coming back still opens it afresh (R15 as meant). Mail and Jira cards are read whole again,
   as before.

Changes two designed rules on purpose, agreed with the person: plan 077's R15 reset on a newer message, and plan 085's
"a newer message makes the opened thread stale".

## How

1. `app/src/desk/deck-moves.ts`: `cardKey` is `account/thread`, no newest message.
2. `app/src/desk/outside-card.tsx`: `useOutsideThread` reads again on a newer message or a sent reply. A Slack card
   already showing its view asks `refreshAsk` (the thread whole, or the channel after the last message) and merges with
   `withNewer`; anything else reads afresh, as before.
3. `app/src/desk/slack-thread.tsx`: `useFollowNewest` scrolls to the bottom on a newer last row when the person was
   at the bottom (`atBottom`) or the row is theirs, and not for rows a load brought.

Not refreshed while the card stays: a post's reply count in the channel view, and edits to messages already shown.
They are right again when the card is opened afresh.

## Tests

1. `test/steady-view.test.ts`: `refreshAsk` for a channel, a thread and a channel with more after; `withNewer` adds at
   the end, keeps marks, takes reactions, orders Slack times as times, keeps a thread's gap; `atBottom`.
2. `test/deck-keys.test.ts`: a newer message is the same card, so the reply still goes into the opened thread.
