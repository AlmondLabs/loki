# Plan 088: the Gmail inbox is the list of email cards

2026-11-10 · changes plans 067 (KTD13), 070 (KTD5) and 078 for Gmail

## Why

A mailbox connected on 2026-11-05, under plan 067's rule that let only direct mail in, kept 41 inbox threads out:
job alerts, order mails, security alerts. Plans 069 and 070 widened the rule to every inbox thread, but the past was
read through a bookmark (`core/account-refill.ts`) that had already passed those days, and the one-time pass after
plan 070 checked only the threads loki had recorded. Mail loki never recorded was never looked at again.

The person works to inbox zero: archiving is the only way a mail is done. Gmail's inbox already says which threads are
not done, and every move loki makes is written back to it, so loki can take the list from Gmail instead of keeping its
own place in the past.

## What

1. **A card is every thread in the Gmail inbox**, read or unread, in every tab (Primary, Updates, Promotions, Social,
   Forums), as plan 070 has it. Archive, here or in Gmail, ends it; read and later rest it as before.
2. **loki lists the inbox when it may hold threads it has not drawn**: on the account's first sync, after this upgrade,
   when Gmail no longer keeps the history since the last tick, and while the last listing stopped at the cap. A
   listing asks Gmail for the threads with the INBOX label, newest first (`labelIds=INBOX`, which is exact where a
   search can lag), and makes a card of each thread loki has no record of.
3. **Gmail's change history stays the tick's signal.** New mail, reads, archives and mail moved back in Gmail come
   through it as today; in an inbox at zero, a tick costs what it costs now.
4. **The cap paces what a listing fetches.** It takes threads until the account has 20 open cards (resting cards
   left out, plan 078) and says there may be more; closing cards makes room, and the next tick lists again. New mail
   is not held to the cap.
5. **A listing never reopens what loki has a record of.** An archived or handed-off thread comes back only when its
   mail is moved back into the inbox, through the history (plan 070, KTD4), so a listing that runs while an archive is
   still on its way to Gmail cannot bring the card back.
6. **What goes for Gmail:** the bookmark's windows (3, 7, 14 and 30 days back), the first three days read whole, the
   one-time pass after plan 070, and the bounded search after lost history; each is a listing now. Slack keeps its
   bookmark; it has no inbox, so it needs its own decision.

## How

1. `mod/gmail.ts`: `listInbox(pageToken)`, one page of the inbox's thread ids, newest first.
2. `mod/gmail-sync.ts`: the cursor is `{ history_id, version: 3, more }`. A cursor from before (version 2, with its
   `refill`) loads, and the first tick on version 3 lists the inbox. `run` reads the history as before; when it was
   lost, it re-reads the open cards and the recorded threads in the inbox, as the search before did; and it lists the
   inbox while `more` holds and the account has room. `refill`, `readWindow`, `newestBefore`, `reconcile` and the
   search in `rebuild` go.
3. `docs/manual.md` and `glossary.md` (Outside card): how mail comes in.

## Tests

`test/gmail-sync.test.ts`, over the fake mailbox, which answers the inbox listing:

1. An inbox thread loki never recorded, under a version 2 cursor whose past was all read, becomes a card on the first
   tick on version 3; an archived record whose thread left the inbox stays archived.
2. A listing passes over a record still in the inbox (an archive on its way) and leaves it archived.
3. With 300 inbox threads the first tick takes the newest 20; closing cards makes room, and the next tick takes the next.
4. Lost history lists the inbox and re-reads the open cards and the inbox threads loki has a record of: one closed
   whose mail is as recorded stays out, one that got new mail meanwhile comes back, as before.
5. In an inbox at zero, a tick with no history makes no listing.
