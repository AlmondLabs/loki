# Replying to mail works the way Gmail's reply does (plan 076)

2026-11-08 · follows [plan 068](2026-11-05-068-feat-inbox-thread-reply-plan.md) and
[plan 070](2026-11-05-070-feat-inbox-endings-plan.md)

## Why

A support mail came in and the person wanted to bring the engineering team into the thread. The card could not do that.
Its reply box always replies to everyone on the newest message, without showing who that is. You can't add anyone,
forward the mail, or take a send back. What gets sent is plain text, with no earlier mail under it and no signature. So
anyone who joins the thread later, or reads it outside Gmail, sees one line with no context. The person asked for the
reply to feel like Gmail's.

## What changes

All of this is for Gmail cards on the desktop. Slack cards keep their box as it is.

1. **A recipients line above the box**, as Gmail draws it collapsed: `to Pinku Kumar, cc 2 others`.
   1. Clicking it, or ⌘⇧C in the box, opens To, Cc and Bcc as rows of chips. You can remove a chip. Moving someone to
      another row is removing and adding them; dragging a chip waits for real use to ask for it.
   2. **Adding someone:** type a name or address. Suggestions come from the people in the account's synced mail
      (From, To, Cc), ranked by how often and how recently they appear. A group address like `eng@…` is one of them.
      A full address loki has never seen is taken as typed.
   3. The line stays visible when collapsed, so you always see who gets the reply before sending.
2. **Reply, reply all, forward**, from a small menu at the start of the recipients line, as Gmail's arrow menu works.
   1. **reply all** stays the default, as today.
   2. **reply** goes to the sender only.
   3. **forward** starts with no one, says "Fwd:" in the subject, and carries the thread's attachments.
   4. Switching keeps what you typed. Keys inside the card: ⇧R replies to the sender, F forwards.
3. **The earlier mail goes under the reply**, as Gmail sends it:
   1. The message is sent in two forms, plain text and HTML.
   2. The plain text carries "On 6 Nov 2026, Pinku Kumar wrote:" with the earlier mail quoted line by line.
   3. The HTML carries the same in Gmail's quote block, so Gmail folds it into "•••" for the people reading it.
   4. In the box, the quote shows as a "•••" you can open to read. It is not edited there.
4. **Your Gmail signature** is added under the reply. It comes from the address you send from, read from Gmail's
   send-as settings with the access loki already has. It shows greyed under the text you type, and you can remove it
   for one reply.
5. **From:** when the account has more than one send-as address, the recipients line opens with a From menu. It
   defaults to the address the mail was sent to.
6. **Undo send.** A send waits 10 seconds before it goes to Gmail. A bar shows `sent · undo` for that time. Undo
   brings the card back with your text, the recipients and the mode as they were. The key's move (read, later,
   archive) happens after the wait, never before. The waiting reply is kept in `state/outbox.json` on the account's
   Mac, so a daemon restart sends it when the daemon starts again instead of losing it.
7. **Enter makes a new line in a mail reply; ⌘Enter sends**, as in Gmail. Slack keeps Enter to send.
8. **The phone** gets the recipients line and "add someone". It doesn't get the mode menu, From or Bcc. It shares
   the quote, signature and undo, since those happen in the mod.

## Decisions for review

1. **Reverses plan 068's Enter-to-send for mail.** Plan 068 made the mail box send on Enter, like a chat. Mail replies
   are often longer than one line, and sending a whole team a half-written line is worse on email than in chat.
   Slack keeps Enter. This needs a yes.
2. **Suggestions come from synced mail, not Google Contacts.** Contacts would need a second Google permission and
   another warning on the sign-in screen. The people index is a small per-account file
   (`state/accounts/<id>/people.json`: address, name, count, last seen). It's built from headers loki already reads and
   lives only on the account's Mac. It holds addresses, never tokens. SECURITY.md says so.
3. **The wait is 10 seconds and fixed.** Gmail's default is 5, and you can set it from 5 to 30. I picked one visible
   constant over a setting. 10 seconds leaves time to notice a wrong Cc.
4. **Agents still never send.** Recipients, forward and From are on the frame only the person's own devices send.
   Approved agent drafts still become Gmail drafts as before, with no quote or signature yet. Adding those is a small
   follow-up once the person's own replies have been used for a while.
5. **Forwarding attachments** reuses the bytes Gmail already holds. The mod fetches each attachment and attaches it
   to the new message. No file passes through the app.

## Not in this plan

Each of these needs its own plan, in roughly this order:

1. formatting (bold, italic, links, lists);
2. attaching your own files;
3. keeping unsent replies as Gmail drafts, so they show in Gmail too;
4. writing a new mail that answers no card.

The Gmail link on the card covers these until then.

## Tests

1. The recipients for reply, reply all and forward, including your own addresses and aliases left out.
2. The message with the quote: plain and HTML parts, encoding, Gmail's quote block.
3. The signature for the chosen From.
4. The people index: updates from headers and ranking.
5. The outbox: the wait, undo, sending after a restart, and the move running only once the send is done. All of
   these use an injected clock.
6. The reply frame refuses Bcc or forward from anything but the person's own devices.
7. The recipients chips and the Enter / ⌘Enter keys in the box.
