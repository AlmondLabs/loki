# A mail card laid out the way Gmail lays out a thread (plan 078)

2026-11-09 · follows [plan 076](2026-11-08-076-feat-gmail-like-reply-plan.md)

## Why

Plan 076 made replying to mail work the way Gmail's reply does, but the card still reads like a chat with a form under
it. The person was still not happy with how mail reads and how the reply sits. Four sketches were drawn; the person
picked the one shaped like Gmail's thread view.

## What changes

Desktop Gmail cards only. Slack cards and the phone keep their look.

1. **The subject is the card's title.** The header says the subject first, then who is on the thread and when.
2. **Each mail has its own header line**, as Gmail's do. The face, the sender's name and address, whom it went to
   ("to you, cc Dev Patel"), and the time on the right. The body sits under the name, indented past the face.
3. **Earlier mails fold to one line** with the face, the name, the mail's first line and the time on the right. A press
   opens one, as today.
4. **A mail's files show as chips** under it, by name and size. They are not opened from loki yet; the Gmail link on
   the card opens them.
5. **The reply box sits at the end of the thread**, under the newest mail and indented with it, as Gmail's does. It is
   one framed box: the recipients line at its top, the text, the signature and "•••", then send (⌘Enter) and discard.
6. **The card's moves get their own row** at the bottom (hand off, label, archive, later, read), since send now lives
   in the box.

## Decisions for review

1. To and Cc come from each mail's own headers, read with the thread as before; no new Google permission.
2. Files are listed, not downloaded, so the card reads no more of Gmail than it did.
3. Discard clears the text and puts the recipients back as they started; it doesn't move the card.

## Tests

1. The thread reader passes each mail's To, Cc and files to the card.
2. The "to you, cc …" line, with the person's own address said as "you".
3. The card draws the reply box after the newest mail, and the moves in their own row.
