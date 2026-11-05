# Outside cards show the whole thread and take your reply (plan 068)

2026-11-05 · follows [plan 067](2026-11-04-067-feat-unified-inbox-plan.md)

## Why

Using the unified Inbox for real showed two problems with outside cards: a Slack or Gmail card looked blank, and the
accounts setup felt backwards.

**The card looked blank.**
- **Bare lines:** it showed the thread's last three lines as plain paragraphs, with no sender or time.
- **Repeated title:** the title was the newest line again.
- **No reply:** there was nowhere to answer. The person wants to read the whole thread and answer it without leaving
  loki.

**The accounts setup felt backwards.**
- **Owner first:** it asked for the owner before the service.
- **Two places:** it listed accounts in two places.
- **Mixed tabs:** the Inbox tabs mixed accounts ("farmart (Slack)") with agents.

## What changes

1. **The whole thread.** Opening an outside card reads the whole thread from its account, on the Mac the account lives
   on (`account_thread_read`).
   - **Messages:** each message is drawn with its sender and time, oldest first, and your own messages are marked as
     yours.
   - **Gmail cleanup:** the quoted history under "On … wrote:" is cut from each message.
   - **Fallback:** while the thread loads, or if reading it fails, the card shows the last lines it already has.
2. **Your reply sends.** A reply box sits under the thread. R focuses it on the desktop, and Enter or send sends it, as in a chat's box
   (`account_thread_reply`).
   - **Gmail:** a reply-all in the thread, threaded by In-Reply-To and References, and never addressed to one of your
     own addresses.
   - **Slack:** a message in the DM, or in the thread for an Activity item.
   - **After sending:** the card is archived the way archive archives it, so it leaves the Inbox until someone writes
     again.

   This reverses plan 067's "nothing is sent" for **the person's own words only**:
   - **Agents still cannot send:** their replies stay proposals that become drafts once approved, and no tool sends.
   - **Why the send calls are safe:** the client methods that send are reachable only from the reply frame, which only
     the person's devices send. They are never reachable from a tool.
   - **Docs:** SECURITY.md and the manual say so.
3. **A plainer header.** The header shows who, where (account and service) and the subject for mail, and no longer
   repeats the newest line. The account is a small label on the card.
4. **Tabs by owner.** An outside card files under the agent that owns its account, not under a tab of its own.
5. **Accounts get one home: Preferences › Accounts.**
   - **Service first:** connect gmail and connect slack come first; the owner picker sits beside them and defaults to
     the only agent, or the first one.
   - **The list:** each account shows its owner, which can be changed in place, plus disconnect.
   - **Agent pages:** they keep their short list of owned accounts.

## Decisions

- **Send and archive are one step.** Answering a thread is being done with it for now, and a new message brings the
  card back.
- **No draft fallback in the box.** Agents' drafts still work as before.
- **Slack bot DMs keep arriving.** The person didn't ask to filter them.

## Tests

The new tests cover:
- the quoted-history cut;
- the Gmail send body;
- the Slack post's parameters;
- the read and reply frames, including refusals;
- the owner tabs.
