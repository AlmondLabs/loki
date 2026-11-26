# Plan 086: a sent reply shows in its thread at once

2026-11-10 · follows plans 083 and 085

## Why

Since plan 083 a reply sent from an outside card leaves the card on top, yet the thread on the card does not show
it. The card reads its thread again only when the thread's newest message changes, which waits for the next sync of
the account, so the person's own words vanish from the box and appear nowhere.

## What

1. **The reply shows the moment it is sent.** Enter on Slack, ⌘Enter on mail and the phone's Send put the person's
   words at the end of the thread on the card, as their own message, while the box clears.
2. **Once it went, the thread is read again**, so the reply is shown as Slack or Gmail keeps it (mentions, the mail's
   own formatting) and the stand-in goes.
3. **Undone or failed, it goes.** Z on a held mail, or a send that fails, takes the stand-in out as the words come back
   to the box.
4. A reply sent with a move (⌘], ⌘[, ⌘E) takes the card away, so it adds nothing to the thread.

## How

1. `core/attention/sent-replies.ts`: a small store of the replies sent alone, by account and thread, and the post's
   thread opened on the card that the reply went into (plan 085), so it shows in the view it went to: added as the send
   starts, marked gone when it went, dropped on undo or failure, and settled once a read of the thread came back after
   it went. It counts the sends that went, so a card knows when to read again.
2. `core/attention/chat-store.ts`: `replyOutside` with `stay` keeps its reply in the store (`ChatStore.sent`), which
   `useAttention` hands out as `sentReplies` with the other outside calls.
3. `app/src/desk/outside-card.tsx`: `useOutsideThread` shows the store's replies after what it read, and reads the
   thread again when one went; a read again that fails keeps what the card showed. `threadSourceOf` and the phone's
   source pass the store on.

## Tests

1. `test/sent-replies.test.ts`: add, gone, drop and settle; a settle drops only what went before the read.
2. `test/chat-store.test.ts`: a reply sent alone stays in the store until it went, and goes on undo or failure; a
   reply with a move is not kept.
