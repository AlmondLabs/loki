# Plan 092: reading a Slack card marks its Activity read in Slack

2026-11-11 · finishes plan 067 U7 step 6

## Why

Read or archive on a Slack mention or thread card ended it in loki only. Slack's Activity still showed the item
unread, so the person cleared it twice. Plan 067 left this open because no call to mark one Activity item read was
known (`markActivityItemRead` was a stub).

## What

1. Read and archive on a Slack card mark the card's unread Activity items read in Slack: every item of its thread up
   to the newest message the card showed. An item that came after stays unread.
2. Undo marks those items unread again in Slack.
3. A DM is still marked read with `conversations.mark`, and still cannot be marked unread again. No channel's read
   marker moves.
4. If Slack refuses, the card still ends (or comes back) in loki, Slack keeps the item as it was, and loki logs
   `slack:activity-mark-failed` with Slack's reason.

## How

1. `mod/slack.ts`: `activity.markRead` and `activity.markUnread` join the allowed methods. `SlackClient.markActivity`
   sends `entries`, a JSON list of `{type, key, feed_ts}`, as `activity.feed` gives them.
2. `mod/slack-sync.ts`: each tick remembers the unread items by card (a whole read of the feed replaces them, a read
   of its newest page adds to them). `archive` marks the card's items and keeps them for an undo; `restore`, reached
   through the Slack source's undo, marks them unread and remembers them again for the next read.

Slack does not document either call. Another Slack client, slk (gammons/slk#312), tried them against a live
workspace: read, unread and read again on one item, each seen in `activity.feed` within 1.5 s. They go through the
desktop app's session like every other call loki makes. Plan 067's by-hand check stays: mark one mention card read in
loki and see in Slack that only that Activity item clears and its channel stays unread.

What is remembered lives in memory: after loki restarts, the first tick reads the whole feed again before any card can
be read, and an undo after a restart opens the card in loki only.

## Tests

`test/slack-sync.test.ts`, over a fake Slack that checks `entries` as Slack does:

1. a mention card's read marks its item and moves no read marker;
2. a thread card marks each of its items up to its newest message, and not a mention that came after;
3. undo marks them unread, and a second read marks them read again;
4. a refusal still ends the card and is logged;
5. archive on a mention card sends no `conversations.mark`.
