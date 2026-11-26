# Plan 085: a reply goes into the thread the person opened

2026-11-10 · fixes plan 077's opened thread (R11)

## Why

On a Slack card showing a channel or DM, the person can open a post's thread (plan 077, R11). Their reply then still
went to the card's own place: the DM, or the card's thread, not the thread on screen. Slack sends a reply written in an
open thread into that thread, and so should loki.

## What

1. While a thread the person opened is showing, the reply box says "reply in the thread", and Enter, **send**, ⌘], ⌘[
   and ⌘E send into that thread.
2. Back in the conversation, or once a newer message makes the card show its own view again, a reply goes where it did:
   the DM, or the card's thread.
3. The phone does the same.

## How

1. `app/src/desk/deck-moves.ts`: the reply box holds the opened thread (`ReplyBox.thread`, keyed by `cardKey`), so
   the deck's keys know it; `openedThreadOf` gives it for the card as it is now, and the send carries it.
2. `app/src/desk/outside-card.tsx`: `useOutsideThread` keeps the opened thread in the deck's box when the deck holds
   the box (the desktop), else its own (the phone); the thread state names it; the box's hint follows it.
3. `core`: `OutsideReplyExtra.thread_ts`, through the store and the client; the reply frame takes `thread_ts` (a Slack
   message time).
4. `mod/outside-threads.ts`: a Slack reply with `thread_ts` posts into that thread of the card's conversation; a mail
   reply with one is refused.

A Mac on a loki older than this ignores `thread_ts` and sends to the card's own place, as before.

## Tests

1. `test/outside-threads.test.ts`: a reply goes into the opened thread on a DM and on a channel card; mail refused;
   the box says "reply in the thread".
2. `test/mail-reply.test.ts`: the frame takes a Slack message time and refuses anything else.
3. `test/deck-keys.test.ts`: the deck sends into the opened thread, and not once a newer message made it another card.
