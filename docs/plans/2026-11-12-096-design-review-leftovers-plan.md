# Plan 096: the three review items that need a decision

2026-11-12

## Why

The review of 2026-11-10 left three places where work can still be lost, each needing a choice about how loki
behaves, not only code (plan 082, "Not in this plan"). This note sets out each one, the options, and a pick. Nothing
is built until the questions at the end are answered.

## 1. A held mail reply whose send fails after nobody waits for it

**What happens now.** A mail reply waits 10 seconds in `state/outbox.json` for its undo (`mod/mail-outbox.ts`). When
the time comes it leaves the file, then goes to Gmail. If the card that sent it is still waiting (the frame's 60
second limit, `chat-client.ts`), a failure brings the card back with the words and the reason. If nobody waits (the
frame timed out, or the reply was resumed after a restart), a failure is only logged (`outside:resumed-send-failed`).
The reply is gone and no card says so. The lid closing during the hold, or a Mac that starts offline, is enough.

**What is hard.** Gmail has no idempotency key. A send that timed out may have gone, so sending again can send twice;
that is why the reply leaves the file before the send.

**Options.**

1. **Keep a failed reply and show it; the person sends again.** A failed entry stays in the outbox file with its
   reason and is no longer timed. Its card shows "not sent: the reason" with **send again** and **discard**, on every
   device. Nothing retries by itself.
2. **Make sending again safe, then retry once by itself.** Each held reply carries a header of its own
   (`X-Loki-Outbox: <outbox_id>`). Before sending again, loki reads the thread and looks for a message with that
   header: there, the reply went, and the card is marked sent; absent, it is sent. Network failures retry once by
   themselves after a minute; any other failure is shown as in option 1.
3. **Leave it.** The window is small and the log says what happened.

**Pick: 1 now, with the header from 2**, so **send again** first checks the thread and never sends twice. Retrying by
itself (the rest of 2) can follow once there is a week of the log line to say how often it happens.

**Also found.** Since #240 scripts send mail through `google_gmail_send`, by design (R15). The doc comment in
`mod/mail-outbox.ts` and the line in `docs/SECURITY.md` that say no agent tool reaches a send call are no longer true;
they should say that a script sends on its own, and the outbox holds only the person's own replies. The outbox's seal
(#218) still matters: it stops a script from adding a reply that looks like the person's.

## 2. A release that fails after it is published

**What happens now.** `npm run release -- publish` creates the stable release, tagged and marked latest, with the
`.dmg`. Then the workflow renders the cask, uploads it, and pushes it to the tap (`release.yml`). If a step after the
publish fails (the tap token, a network error), running the job again numbers a new stable from the tags, so the same
commit ships twice, as `.0` and `.1`. The nightly deletes its release before creating the new one, and the nightly
build is cancelled when a newer merge comes, so a cancel between the two leaves `loki-nightly.rb` pointing at a file
that is gone.

**Options.**

1. **Draft first, publish last, each step safe to repeat.** A stable is created as a draft (which makes no tag yet)
   with the `.dmg` and the cask, then made public and latest, then the cask goes to the tap. Before numbering, the job
   looks for a release (draft or not) that targets this commit and takes its number; each step skips what is already
   done. The nightly keeps its release: the new `.dmg` is uploaded beside the old one, the tag moves, the tap gets the
   new cask, and only then is the old file deleted, so a cancel at any point leaves a nightly that works.
2. **Only make a re-run refuse.** The job stops when a release already targets this commit, and the steps after it are
   done by hand. Smaller, but a failed tap push still needs someone at a terminal.

**Pick: 1.** It is the one way that lets a failed job be re-run with the button. It changes `scripts/release.ts`
(`publish`, `cmdVersion`) and the build job's last three steps; `scripts/release.ts` already has tests for the
numbering, which would cover "a re-run takes the same number". The first real run is a nightly after it merges.

## 3. A chat move whose last step fails

**What happens now.** Moving a chat to another Mac (`mod/chat-moves.ts`): the old Mac holds the chat and copies it
out, the new Mac imports it, then tells the old Mac to hide its copy (`peer_chat_moved`). If that last message is lost
(the link drops), the hold on the old Mac lapses after 3 minutes (`MOVE_TIMEOUT_MS`) and it takes messages again,
while the new Mac also has the chat: two writers. The automatic hand-over tries again at the next contact, but its
import sees the chat already there and skips it, then hides the old copy, so anything written on the old Mac after
the lapse is lost. A move by hand is never tried again.

**Options.**

1. **The hold never lapses by itself.** The old Mac keeps the move on disk (`state/moves.json`) instead of a 3-minute
   timer. While it holds a chat it asks the new Mac whether it has the chat: yes, it hides its copy; no, it lets go.
   While the new Mac cannot be reached, the chat says "moving to the other Mac, which is out of reach" with **keep it
   here**, which ends the move; the new Mac then drops its copy at the next contact. Every move, by hand or not,
   finishes at the next contact.
2. **Keep the lapse, and merge on return.** When the move finishes late, the new Mac imports what the old Mac wrote
   after the lapse. Two writers can then have made two different turns from the same point, which have no order to
   merge in.
3. **Leave it.** It needs a link to drop in a window of a few seconds, and loses at most the messages of the minutes
   after.

**Pick: 1.** One writer at all times is the rule the design rests on (architecture.md, "Several Macs"); option 2
breaks it. It costs a moved chat a few minutes of "out of reach" in the rare case, with a way out that the person
chooses.

## Questions

1. Mail: **send again** after a check of the thread, and nothing retried by itself for now (pick 1 above). Or retry
   once by itself as well?
2. Mail: is the wording "not sent: the reason" with **send again** and **discard** right for the card, on the desktop
   and the phone (sentence case there)?
3. Release: draft-first for stables and upload-then-delete for the nightly (pick 2.1)?
4. Chat moves: a hold that never lapses by itself, with **keep it here** while the other Mac is out of reach (pick
   3.1)? This changes what a person sees during a move: a chat can say it is out of reach where today it comes back
   by itself after 3 minutes.
5. Order: release first (it decides whether anything ships), then mail, then chat moves?
