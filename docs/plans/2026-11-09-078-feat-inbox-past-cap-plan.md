# Plan 078: the past fills each source up to 20 cards

2026-11-09 · changes plan 067's KTD13 and plan 070's KTD5

## Why

The goal is to close every email and Slack message the person has not dealt with, however old. Today the past arrives
only once an account is cleared: Gmail steps back a window when the account has no unread card, Slack brings 20 older
items when the workspace has no open card at all. One card left open, read or resting, holds the whole backlog back,
and the Slack walk of the Activity feed stops at 1,000 items, so anything older never comes.

## What the person decided

1. **A rolling cap, not a gate.** Each source (each Gmail account, each Slack workspace) is topped up from the past to
   20 open cards. Closing cards makes room, and older items fill it, until the past is all in.
2. **New always comes.** The cap limits only the past. New mail and new Slack still land at once, even past 20; the
   past then waits until the source is under 20 again.
3. **Mail: everything in the inbox.** Every thread still in the Gmail inbox, read or unread, counts.
4. **Slack: DMs and Activity, as now**, with no age limit and no item cap. Unread channel messages that do not name
   the person stay out.

## How

1. `core/account-refill.ts`: `PAST_CAP = 20` replaces `REFILL_BATCH`. `refillWindow(cursor, open)` gives a window while
   the account has fewer than 20 open cards, its limit the room left (`20 - open`); the first window (the 3 days before
   the connection) is still read whole.
2. `mod/gmail-sync.ts`: the refill counts every open card, not only unread ones. A window is read in one pass over the
   inbox, newest first, read and unread alike, until the room is used; the cursor then stands at the oldest thread
   taken, so nothing newer in the window is skipped.
3. `mod/slack-sync.ts`: the refill runs while the workspace has fewer than 20 open cards and takes the room left,
   across windows in one tick. The full walk of the Activity feed reads up to 200 pages (10,000 items), resuming after
   a rate limit as before.
4. `docs/manual.md`: the paragraphs on how older mail and Slack arrive.

## Tests

1. `test/account-refill.test.ts`: a window comes while under the cap, its limit the room left; none at the cap.
2. `test/gmail-sync.test.ts`: read and unread open cards both count; an account under the cap fills to it.
3. `test/slack-sync.test.ts`: the past fills a workspace to 20 across windows, new items still come past the cap, and
   the rest arrives as cards close.
