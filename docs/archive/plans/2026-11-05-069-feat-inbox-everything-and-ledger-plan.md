# Every mail comes in, and loki keeps what you do with it (plan 069)

2026-11-05 · follows [plan 068](2026-11-05-068-feat-inbox-thread-reply-plan.md)

## Why

Plan 067 let only "direct" mail in: from a person, with you in To or Cc, and carrying no list or automated headers.
That rule can't recognise transactional mail. A fund statement came in because it has no list headers, and fixing that
would mean guessing at more rules. The person chose the other direction: **let everything come to loki, keep a record
of what they do with each thing, and later learn their preferences from that record and act on them.**

## What changes

1. **Every unread inbox mail is a card.**
   - **No filter:** `isDirectMail` no longer gates anything. Gmail's watcher makes a card for the newest unread inbox
     message in any thread.
   - **The kind goes with it:** each card records what kind of mail it is (`MailTraits`, core/mail-filter.ts), read
     from the headers and labels:
     - `to_you`: one of your addresses is in To or Cc;
     - `list`: `List-Id`, `List-Unsubscribe`, or `Precedence: bulk|list`;
     - `automated`: `Auto-Submitted`, `X-Auto-Response-Suppress`, `Precedence: junk`, or a no-reply sender;
     - `category`: Gmail's tab (primary, updates, promotions, social or forums), or null for a mailbox without tabs.

     The thread record keeps these traits.
   - **Slack is unchanged:** it still brings DMs and Activity items. Every message in every channel would be noise,
     not mail.
2. **The ledger of your moves.**
   - **What is recorded:** every Next, archive, reply and hand-off on an outside card becomes one line in
     `state/inbox-ledger.jsonl`. The line holds:
     - the move;
     - how it was made (key, click, swipe or tap);
     - how long the card was on top;
     - the thread's sender, subject and generation;
     - the mail's traits, or for Slack whether it was a DM or a thread.
   - **Where it lives:** it is written on the Mac the account lives on, through the `account_thread_move` frame, which
     the deck sends from the same place it logs `inbox_card_decided`.
   - **Replies and hand-offs:** these now count as Inbox decisions too, logged once they succeed.
3. **Nothing reads the ledger yet.** It is the data for the next step: learning which senders and kinds of mail you
   archive unread, which you answer, and which you hand off, and in time doing those moves for you. That step gets its
   own plan.

## Decisions

- **One mechanism.** Every move goes through the deck's one decision call, so the ledger and analytics never disagree
  about what happened. The ledger keeps what analytics leaves out on purpose (senders and subjects), and it stays on
  the Mac.
- **Lost lines are let go.** A move that cannot reach the ledger is only lost data, so nothing waits on it and no
  error is shown.
- **The ledger rotates at 20 MB,** to `.1`, the same way the analytics file does.
- **Ranking is unchanged.** More cards arrive, and the focus ranking already learns from what you work with. A cap or
  a filter waits for the ledger's data.

## Tests

The new tests cover:
- the traits of each kind of mail, and reading them back;
- the watcher making a card for list, automated and no-reply mail, with its traits;
- the ledger's lines, Slack's kind, unknown threads, and rotation;
- the move frame's parsing and refusals;
- the store sending a move to the account's home Mac.
