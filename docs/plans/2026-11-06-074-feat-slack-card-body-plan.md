# A Slack card reads like the channel it came from (plan 074)

2026-11-06 · follows [plan 073](2026-11-05-073-feat-card-headers-plan.md)

## Why

A Slack card showed the one message it was about, alone, in a tall empty card: an @channel ask with nothing around
it, under a header that already named its sender. The person wants the card's body to look like Slack, with the
messages before and after it, so opening a card feels like being in that chat.

## What changes

1. **A Slack card's body is drawn as the chat draws messages** (the Slack-style rows of the transcript): a face,
   then name and time on the first of a run of messages by one person, day pills, and the red **New** line before
   the first message the person has not read.
2. **What it shows, by where the card came from:**
   1. **A channel message or a thread** (`<channel>:<ts>`): the channel's 5 messages before the thread's first
      message, that message with its replies under it (indented, as an open thread), and the channel's 5 messages
      after it.
   2. **A DM**: its last 50 messages, as today.
3. **The card opens on the message it is about**: the New line, or the newest message when there is none, scrolled
   into view, not the bottom of what came after.
4. **Email cards keep their mail rows**; the phone keeps its rows and gains the same messages.

## Where the facts come from

1. The thread: `conversations.replies`, as today. Its first message carries `last_read` for a thread the person
   follows, which places the New line.
2. Before: `conversations.history` up to the thread's first message, 5 messages.
3. After: `conversations.history` from the thread's first message. Slack returns the newest first, so a busy channel
   is paged back, at most 3 pages of 100, to reach the 5 right after; past that the card says more came since.
4. A channel's or DM's `last_read`, when the thread has none: `conversations.info`, which loki already asks for the
   channel's name.
5. Faces: the `users.info` loki already asks for names, remembered across reads of one account.

A card opens with 3 to 6 Slack calls instead of 1. They are read only when a card opens, and a rate limit is waited
out as today.

## Decisions

1. **A hand-off still sends the thread alone**: the channel around it is context to look at, not work to hand off.
2. **The thread is shown inside the channel, not instead of it**, so a thread reply and a channel post read the same.
3. **No reactions, files or edits yet**: text only, as today.
