# Every Inbox card says who, where and how directly (plan 073)

2026-11-05 · follows [plan 067](2026-11-04-067-feat-unified-inbox-plan.md) and [plan 069](2026-11-05-069-feat-inbox-everything-and-ledger-plan.md)

## Why

A Slack card showed a sender, "farmart · Slack" and the message. It did not say where the message was posted or why
it reached the person, so an @channel ask to everyone looked the same as a question to them. Email and chat cards each
had their own header shapes. The person compared three layouts and chose one shape for every card: sender first, an
avatar with a mark for where it came from, and a tag for how directly it is meant for them.

## What changes

1. **Two lines, sender first, on every card in the Mac's Inbox.**
   1. A round avatar: the sender's Slack photo, a mail sender's coloured initial, a chat's agent face.
   2. A small mark in the avatar's corner says where a card came from: `#` for Slack, an envelope for mail. A chat has
      none, since chats are loki's own.
   3. Line 1 is who: the sender, or the chat's agent.
   4. Line 2 is where or what, then when: a Slack channel (`#crm-support`) or "direct message", a mail's subject, a
      chat's title; then the time and the notes the card already had.
2. **A tag for how directly the card is meant for the person**, on one scale for every kind of card, most direct first:
   1. a Slack DM, a mail to the person; a chat that asked them or needs approval
   2. a Slack mention of them
   3. a reply in their Slack thread; a chat that finished or failed
   4. a mention of a Slack user group
   5. @channel or @here; a mailing list
   6. a mail sent by a machine

   Only the first level uses the attention colour; the last two are muted.
3. **The workspace or mailbox is named only when more than one is connected** for that service.

## Where the facts come from

1. **Slack:** the kind of Activity item a card came from (each tick already reads it) gives the tag; a DM's own kind
   too. The channel's name comes from `conversations.info`, asked once per channel and remembered. The sender's photo
   comes from `users.info`, which loki already asks for the sender's name.
2. **Email:** the traits plan 069 records on each mail (to the person, a list, sent by a machine).
3. **Chat:** its status, as its badge shows today.

New fields on the card's facts are optional, so a paired Mac on an older loki still draws its cards.

## Decisions

1. **No official logos.** Slack's brand terms do not allow its logo outside approved programmes, and no current Google
   permission was found for the Gmail logo, so the mark is a plain glyph in a colour of loki's own.
2. **Mail sender photos are not fetched.** A real photo needs another Google permission, and a site icon service would
   tell a third party which mail is being read; mail shows initials.
3. **"To you" covers To and Cc** for now: the traits do not tell them apart.
4. **The phone keeps its header** in this change; it follows in its own.
5. **A chat's purpose line moves to the title's hover text**, so a chat card stays two lines.

## Checked

Tests for the tag scale, the Slack facts and the header's markup; a render in light and dark on a demo daemon with
made-up cards.
