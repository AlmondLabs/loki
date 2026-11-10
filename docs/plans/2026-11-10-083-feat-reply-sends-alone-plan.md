# Plan 083: a reply sends alone

2026-11-10 · changes plan 070's R11

## Why

Enter in a Slack card's reply box (⌘Enter in a mail's) sent the reply and then marked the card read, so the card left
the deck as soon as the person replied. The person wants the next move to be theirs, made explicitly, on Slack and
mail alike.

## What

1. **Enter on Slack, ⌘Enter on mail, and send only send.** The box clears, "sent" flashes, and the card stays on top.
   Nothing is marked read, put off or archived, and no decision is logged; the person's next key (⌘], ⌘[, ⌘E or
   another) is the move.
2. **A mail sent alone is still held for 10 seconds.** Z stops it while it waits and puts the words back in the box,
   the card where it was. The hold is kept in the card's reply box rather than on a decision, since nothing was
   decided.
3. **The moves still carry a reply.** ⌘], ⌘[ and ⌘E with text in the box send it with their move, as before; each of
   those is the person's own explicit choice.
4. **The phone's Send** sends alone too, and the card waits for a swipe; the phone's "count a reply's read once"
   check (`isDismissed`) goes with the read it guarded.

## How

1. `core/frame-types.ts`: `ReplyThen` gains `stay`. `core/frames.ts`: the reply frame takes it (`SEND_THENS`); an
   agent's proposed move after a reply (`after_reply`) does not.
2. `mod/outside-threads.ts`: `stay` makes no move after the send; replying still marks the card dealt with (plan 077).
3. `app/src/desk/deck-moves.ts`: `sendReply` sends with `stay`; the card keeps its place. A mail's goes through
   `sendHeldStay`, its hold on `ReplyBox.held`, which `undo` stops first.
4. `app/src/phone/inbox.tsx`: Send sends with `stay` and the card is not taken off.
5. `docs/manual.md`: the reply paragraph.

A Mac on a loki older than this refuses `stay` ("then must be read, later or archive"), so an account on such a Mac
says so on Enter or ⌘Enter until that Mac is updated; ⌘] and the other moves still send.

## Tests

1. `test/deck-keys.test.ts`: Enter on a Slack card and ⌘Enter on a mail send with `stay`, and the card stays on top
   with nothing decided; Z while a mail sent alone waits stops it and puts the words back.
2. `test/outside-threads.test.ts`: `stay` sends and moves nothing but the dealt mark.
3. `test/mail-reply.test.ts`: the frame takes `stay` and refuses a move it does not know.
