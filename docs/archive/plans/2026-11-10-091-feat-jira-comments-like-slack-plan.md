# Plan 091: Jira comments look like Slack messages

2026-11-10 · follows plan 089

## Why

Plan 089 made a Jira card read like the ticket, but its comments still go through the plain list mail uses on the
phone: no faces, the name repeated on every comment, "2h" with no clock or day, rich text flattened to plain lines, and
a mention as bare "@Ada". The person wants the comments to look and feel like a Slack card's messages.

## What

On the desktop, a Jira card's comments are drawn by the Slack card's row, without what Slack alone has (reactions, the
hover bar, thread replies):

1. **Faces:** the comment author's Jira avatar on the first comment of a run, as Slack shows a photo.
2. **Runs:** one person's comments in a row sit under one face and name, broken by a gap, a new day or the New line,
   as Slack's are (`planSlackRows`).
3. **Time and days:** the clock time beside the name, and Slack's day pills ("Today", "Yesterday", a weekday, a date).
4. **Formatting:** bold, italics, strikethrough, inline code, code blocks, quotes, bullet and numbered lists, links by
   their label, emoji and headings, from Jira's document format, drawn as Slack's blocks and spans are.
5. **Mentions:** a mention is drawn as Slack's mention pill, and a comment that mentions the person gets the mention
   wash Slack gives the messages that brought its card.

The New line, "load earlier" and the comment box stay as they are. The phone keeps the plain list, as Slack's phone
card does. A comment's attachment still reads "[attachment]" (a later step).

## Decisions

1. **One shape for rich text.** The home Mac turns a comment's Jira document into the `SlackBlock`/`SlackSpan` shape the
   Slack card already draws, carried on the comment as `body`, beside its plain `text` (kept for the phone, the
   hand-off and older apps). Anything the shape has no place for keeps its words as plain text.
2. **The Slack row, not a copy.** Jira comments use the Slack thread's row and planning, with reactions, the hover bar
   and replies left out when the card is Jira's.
3. **Avatars are Jira's own URLs** from the comment's author (`avatarUrls`, the 48 px one), loaded by the app as Slack
   photos are; a comment without one shows initials.
4. **The wash marks mentions of the person**, not every new comment: a Jira card is brought by any event, so washing
   all of them would say nothing.

## Tests

1. `test/jira-text.test.ts`: a document with bold, italics, code, a code block, a quote, lists, a link with a label, a
   mention, an emoji and a heading becomes the expected blocks and spans; an unknown node keeps its text.
2. `test/jira-view.test.ts` / `test/jira.test.ts`: a comment carries its author's avatar, its `body`, and whether it
   mentions the person.
3. `test/outside-threads.test.ts` (or the Slack thread's tests): a Jira card's comments draw faces on run starts, one
   name per run, clock times, day pills, mention pills and the wash on a comment that mentions the person, with no
   reactions or hover bar; a Slack card unchanged; the phone unchanged.
