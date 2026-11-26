# An agent may propose a reply in any thread it owns (plan 071)

2026-11-05 · changes [plan 067](2026-11-04-067-feat-unified-inbox-plan.md) (KTD9)

## Why

The person asked an agent, in a chat, to draft a reply to a Gmail thread the agent had found with `account_search`.
`reply_propose` refused: plan 067 allowed a reply only in a thread the person had handed to that very chat. The hand-off
can be made only from an Inbox card, so a thread with no card (archived, or never a card) could never get a draft, and
asking in a chat was not enough. The person decided that their approval of the reply is enough.

## What changes

1. **Any thread of an owned account.** `reply_propose` accepts a thread of any account the chat's agent owns: handed
   to this chat, handed to another, or found by search or read. A thread the account does not have is refused in
   words ("there is no thread … in …").
2. **The gate stays.** Every proposal still waits for the person as a card in every permission mode, may be edited,
   and once approved becomes only a draft in that thread, to that thread's own people. Agents still never send, and
   the tool still has no way to name a recipient.
3. **Words.** The tool's description, the agents' prompt line, the manual, the glossary and SECURITY.md say so.

## Decisions

- **This reverses plan 067's rule that a draft goes only in a handed-off thread.** (session-settled: user-directed,
  chosen over keeping hand-off only and over a "hand this thread here" approval inside the chat: the approval card
  already makes the person decide, and the hand-off was an extra step with a dead end for threads without a card.)
- **The risk moves to the approval card.** Mail an agent reads could steer it to propose a reply in a thread the
  person did not mention; the card names the thread and who the reply goes to, and nothing leaves until the person
  sends the draft.

## Tests

`test/reply-proposals.test.ts`: a reply in a thread found by search (no record) and one handed to another chat are
proposed and draft on approval in the right thread; a thread the account does not have, and an account the agent does
not own, are refused.
