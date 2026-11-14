---
title: An agent replies in any thread of its accounts - Plan
type: feat
date: 2026-11-14
topic: reply-any-thread
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# An agent replies in any thread of its accounts - Plan

## Goal Capsule

- **Objective:** The person can ask an agent to answer any existing thread in an account it owns, on Gmail, Slack or Jira, and the reply card tells them, from the service itself, exactly where the reply will land before they press Send.
- **Means:** `reply_propose` reads the thread from its provider through one seam per provider; Flow's thread record stops being needed (KTD1, KTD2).
- **Product authority:** the person, in the session of 2026-11-14 that asked for this plan.
- **Open blockers:** none. The open decisions under Outstanding Questions each have a recommended default the build can take.
- **Stop conditions:** stop and ask if a Jira Service Management comment posted through `postComment` turns out to be internal rather than shared with the customer (Assumptions), or if any provider cannot confirm a thread exists without changing it.
- **Execution profile:** one branch, `feat/reply-any-thread`, one PR that carries this plan; the person merges.

---

## Product Contract

### Summary

`reply_propose` takes a reference to any existing thread in an account the agent owns: a Gmail thread id, a Slack thread id or link, a Jira key, id or link. loki reads that thread from the service, and the card shows what the service says: the ticket's key and title, the Slack conversation and the message replied to, the mail's subject and people. A thread with no card in Flow says so on its card, and a Jira card says who Jira will tell. Nothing about Flow changes: the thread does not get a card.

### Problem Frame

The person reviews every reply an agent proposes and presses Send themselves, so requiring the thread to have had a card in Flow first protects nothing; it only blocks real requests. Asking an agent to comment on a Jira ticket the person never watched fails with "OPS-99 has never had a card in Flow, so loki cannot find it" (R28 of `docs/plans/2026-11-10-1451-feat-jira-inbox-plan.md`, which made the key resolvable only from a card). Slack works loosely: a thread without a record names its DM partner "them", and a mistyped channel or timestamp is never checked. Gmail already reads the thread through its API and works for any thread.

Lifting the gate moves the safety onto the card: when the agent can name any ticket, a mistyped or injected key must be caught by the person reading the card, which therefore has to show what the service says, not what the agent typed.

### Key Decisions

- **Any existing thread, no Flow card needed.** The person's Send is the gate. (session-settled: user-approved — chosen over keeping R28's card requirement: every reply already waits for the person's approval, and the guards in R3 to R7 cover a wrong or injected reference.) Governs R1, R2.
- **Replies only.** A new mail, a new DM or a new Slack conversation stays out; only a thread that already exists can be answered. Governs R2.
- **The thread does not enter Flow.** Proposing in a thread with no card leaves Flow as it was. Governs R8.

### Requirements

**Reaching the thread**

- R1. `reply_propose` accepts a thread of any account the agent owns, whether or not it has ever had a card in Flow, on every provider loki has.
- R2. The thread must exist and be readable by the account: a reference the service does not know, or one for another Jira site or Slack workspace, is refused with why, and nothing is proposed. A Slack channel named without a message is refused, since a top-level post there starts a conversation; a DM named alone is its own existing conversation and is kept.
- R3. The agent may name a thread by what it has: Gmail by the thread id scripts return; Slack by `channel:ts`, a channel or DM id, or a message link of the same workspace; Jira by key, numeric id, or a `…/browse/KEY-1` link of the same site.

**The card**

- R4. The card names the destination as read from the service when the reply was proposed: Gmail the subject and the people it goes to (as today); Slack the conversation (`#ops`, the DM with a named person), whether it is shared with people outside the workspace, and, for a thread, who wrote its first message and its first line; Jira the ticket's key and title.
- R5. A reply in a thread with no card in Flow says so on its card in a plain sentence.
- R6. A Jira card says who Jira will tell: the assignee and reporter by name and the number of watchers, worded as what Jira usually does, since each project's notification settings decide. On a Jira Service Management ticket it says the customer will see the comment.
- R7. A Jira reply whose text holds an `@name` says that Jira will not notify that person, since the comment goes as plain text.

**After the proposal**

- R8. Proposing creates no thread record: what a sent, failed or interrupted reply needs (its outcome, the "may have gone" line, the place a second Send goes) comes from the proposal's own `thread_id` and its outbox entry (KTD6).
- R9. Send, Undo and the outcome work the same for a thread with no card as for one with a card.

### Acceptance Examples

- AE1. **Covers R1, R4, R5.** Given a Jira ticket OPS-99 the person has never watched, when the agent proposes a comment on `ops-99`, then the card shows `OPS-99 · Fix the login timeout` read from Jira and says the ticket has no card in Flow.
- AE2. **Covers R2, R4.** Given the agent mistypes `OPS-990`, when Jira answers that no such ticket exists, then `reply_propose` is refused with that reason and no card appears.
- AE3. **Covers R2, R3.** Given a `…/browse/OPS-1` link of another Jira site, then the proposal is refused naming the account's own site.
- AE4. **Covers R4.** Given a Slack link to a thread in a DM the person has never opened in Flow, then the card says "the thread in your DM with Vivek Rao" with that thread's first line, never "them".
- AE5. **Covers R8, R9.** Given a proposal for a thread with no card, when the person sends it, then it is posted, the agent is told it was sent, and Flow still shows no card for that thread.

### Scope Boundaries

- Starting new mail, a new DM or a new conversation (Key Decision "Replies only").
- Turning `@Vivek` into a real Jira or Slack mention chosen by the agent: Slack already turns `@handle` into a mention at send (`SlackPeople.mentions`), unchanged here; Jira mentions need a person picked from Jira's user search and shown on the card, which is a follow-up (Outstanding Questions).
- Posting an internal Jira Service Management comment.
- Gmail web links as references: their ids are not the API's thread ids.

### Outstanding Questions

Deferred, each with the default this plan takes:

- **Jira mentions.** Resolve `@name` to a Jira accountId (assignable users of that ticket), show the person picked on the card, and post an ADF mention node? Default: out of scope; R7 warns instead. A follow-up plan if the person wants it.
- **Internal comments on service tickets.** Offer "Internal" on the card for Jira Service Management tickets? Default: no; R6 says the customer sees it, and the person can Reject.
- **Whole Slack channels.** Today a channel id with no `ts` posts a top-level message there. R2 refuses it under "Replies only"; if the person wants it kept, R2 and the Key Decision change together.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **One reader per provider behind one type.** `ReplyTarget = (account, reference) => Promise<ThreadFacts>`, where `ThreadFacts` carries `thread_id` (the provider's own id, as threads are keyed today), `subject`, `to`, `cc`, `place`, and the Jira `notice` facts of R6. Each provider's reader lives beside its other reads in `mod/account-ops/` (`gmail.ts`, `slack.ts`, and a new `jira.ts`); `mod/reply-proposals.ts` picks one by an exhaustive `switch` on `AccountProvider`, so a new provider fails to type-check until it has one. This replaces `where()` and `ticketRecord()`. Governs R1 to R4.
- KTD2. **The provider is always read; the record only lends names.** Even when Flow has a record, the reader asks the service, so a key that a stale record would match is still checked and the title is current. A record may supply only what the service read cannot name cheaply (a Slack DM partner's name before `usersInfo` answers). A service read that fails refuses the proposal rather than falling back to the agent's words. Governs R2, R4.
- KTD3. **References parse at the edge, per provider.** Jira: a key matches `^[A-Za-z][A-Za-z0-9_]*-\d+$`, digits are an id, and a link's host must equal the secret's `site` or `link_host`; all three resolve through `JiraClient.issue`, and the proposal keeps the numeric id (KTD7 of plan 1451). Slack: a link's host must match the workspace URL `authTest()` gives (or the org's `enterprise.slack.com` host), `p1700000000123456` becomes `1700000000.123456`, and a `thread_ts` query names the thread; a channel of another workspace is also refused by `conversations.info` answering `channel_not_found`. The thread is keyed `channel:(thread_ts ?? ts)` from the message Slack returns, so a reply's ts resolves to its parent, as `mod/slack-sync.ts` keys threads. Gmail: the id as given. Governs R3.
- KTD4. **Jira's notice facts come from the same `issue` call.** `ISSUE_FIELDS` gains `watches` (for `watchCount`) and the project's `projectTypeKey` (`service_desk` marks a service ticket); no watcher list is read. Governs R6.
- KTD5. **The proposal says whether Flow had the thread.** `ReplyProposal` gains `in_flow: boolean`, set from `threads.get(account, thread_id)` at propose time (for a Slack thread in a DM, also the DM's channel id alone, which is how Slack sync keys DM cards), and Jira's `notify` (assignee, reporter, watcher count, `customer_sees`). Stored proposals without them parse as `in_flow: true` and no notice, so old cards read as before. Governs R5, R6.
- KTD6. **No record on propose.** Nothing after `propose` reads the thread record: `send` uses `p.thread_id`, the outcome reaches the proposal by its ids through the outbox (`HeldProposal`), "may have gone" is derived from the outbox (`record()` in `mod/reply-proposals.ts`), an agent's reply never marks the thread dealt (`sendNow` in `mod/outside-threads.ts`), and Slack's thread and Gmail's reply-all come from the thread id and the API. A thread record is what Flow's outside card and `flow_list` read, so writing one would put the thread in Flow. Governs R8, R9.
- KTD7. **The `@name` warning is computed on the card.** `app/src/item/proposal.tsx` checks a Jira reply's current text (edits included) for `@word` and shows R7's line; nothing is stored. Governs R7.

### Assumptions

- Jira Cloud's `POST /rest/api/3/issue/{id}/comment` with no `sd.public.comment` property posts a comment the customer sees on a service ticket, when the person is a licensed agent on that service project; a person without an agent licence can only comment internally. Checked by hand on a service project before merging; if the comment is internal or refused, R6's line follows what Jira did and the stop condition applies.
- Slack's `conversations.replies` with `limit: 1` on a `ts` that is not a thread parent still returns that message, so a reply to a lone message is found.

### Sources

- `mod/reply-proposals.ts`: `propose`, `where`, `ticketRecord`, `registerReplyTools` (the tool's description and the `thread` parameter).
- `mod/outside-threads.ts`: `holdAgentReply`, `sendNow` (Jira posts on the numeric id; agents never mark dealt).
- `mod/jira.ts`: `issue`, `ISSUE_FIELDS`, `JiraSecret.site` and `link_host`, `jiraTicketUrl`.
- `mod/slack.ts`: `conversationsReplies`, `conversationsInfo`, `usersInfo`.
- `docs/plans/2026-11-10-1451-feat-jira-inbox-plan.md` (R28, KTD7), `docs/plans/2026-11-13-097-refactor-account-operations-plan.md`, `docs/plans/2026-11-14-1134-feat-reply-sends-plan.md`.

---

## Implementation Units

### U1. A reader per provider

- **Goal:** turn an agent's reference into `ThreadFacts` through each service's API.
- **Requirements:** R1 to R4, R6; KTD1 to KTD4.
- **Files:** `mod/account-ops/thread.ts` (the `ThreadFacts` and `ReplyTarget` types), `mod/account-ops/gmail.ts`, `mod/account-ops/slack.ts`, `mod/account-ops/jira.ts` (new), `mod/jira.ts` (`ISSUE_FIELDS`, `JiraIssue` gains `watch_count`, `service_desk`), `mod/index.ts` (the `jira` arm of `clientFor` gets its client).
- **Approach:** move Gmail's reply-all reading out of `where()` unchanged. Slack reads the message at `ts` with `conversationsReplies` and names the conversation with `conversationsInfo` (its `is_ext_shared` flag too), the DM partner and thread author with `usersInfo` (an external partner marks the DM shared). Jira calls `issue`.
- **Test scenarios** (`test/account-ops-reply-target.test.ts`, new, with fake clients): a Jira key in any case, an id and a same-site link all give the numeric id, `KEY-1 · title`, and the notice facts; a link of another host is refused; Jira's 404 refuses with "no ticket OPS-990 on <site>"; a Slack link with and without `thread_ts` gives `channel:ts`; a link of another workspace is refused; a channel id with no `ts` is refused and a DM id alone is kept; a `channel:ts` naming a reply gives the parent's `channel:thread_ts`; a Slack Connect channel is marked shared; a `ts` Slack does not have is refused; a DM names its partner from `usersInfo` with no record; a Gmail 404 refuses as today.
- **Verification:** the tests above pass; `npm run typecheck` fails if a provider is added to `AccountProvider` without a reader.

### U2. Propose through the readers

- **Goal:** `propose` uses U1, records `in_flow` and the Jira notice, and writes no thread record.
- **Requirements:** R1, R2, R5, R8, R9; KTD2, KTD5, KTD6.
- **Files:** `mod/reply-proposals.ts` (drop `ticketRecord` and `where`; the tool's description and `thread` parameter name keys, ids and links and drop "that has had a card in Flow"), `core/frame-types.ts` (`ReplyProposal.in_flow`, `notify`), `test/reply-proposals.test.ts`.
- **Test scenarios:** replace "a comment for a ticket that never had a card is refused" with AE1 and AE2; a proposal on a recorded ticket is still checked against Jira (a stale record's key that Jira no longer has is refused); `in_flow` is false with no record and true with one, and true for a thread in a DM that has a card; after propose, `threads.list` is unchanged (AE5); a stored proposal without the new fields parses with `in_flow: true`; AE5's send of a no-card Jira proposal posts to the numeric id and reports sent.
- **Verification:** `npm test -- reply-proposals` passes.

### U3. The card

- **Goal:** the card shows R4 to R7.
- **Requirements:** R4 to R7; KTD5, KTD7.
- **Files:** `app/src/item/proposal.tsx`, `app/src/desk/reply-proposal-card.tsx` (`recipientsText` for Jira reads `KEY-1 · title`; the phone draws the same component), `test/item-proposal.test.ts`.
- **Approach:** the lines sit under the destination in the card's secondary text, as sentences: "This ticket has no card in Flow.", "Jira usually tells Grace Lee (assignee), Ana Ruiz (reporter) and 3 watchers.", "The customer sees this comment.", "Jira will not notify @vivek: the comment goes as plain text.", "This conversation is shared with people outside your workspace." Text read from the service (a title, a first line, a subject) is one quoted, truncated line, set apart from these notice lines, so a stranger's words cannot pass for loki's.
- **Test scenarios:** each line shows only when its fact holds; the `@name` line follows the person's edits; a Gmail card with `in_flow: false` says the thread has no card in Flow.
- **Verification:** `npm test -- item-proposal` passes; the card checked by hand in light and dark.

### U4. Manual and glossary

- **Goal:** the words people read match the new behaviour.
- **Requirements:** R1, R5 to R7.
- **Files:** `docs/manual.md`, section "Email, Slack and Jira", the paragraph "You send an agent's reply from its card" and its item 3 (drop "only on a ticket that has had a card in Flow"; say any thread of the account, the card's no-card line, and Jira's notice lines; proposing and sending leave Flow as it was, though an answer to a sent reply may bring the thread in, since Jira and Slack then count the person as following it); `glossary.md`, "Reply proposal" (any thread of its accounts, named by id, key or link); `docs/SECURITY.md`, "What loki calls in Jira" (any ticket a proposal names, with its watcher count and project type) and "Residual risks" (an owner can propose a comment on any ticket of the site, a service ticket's customer included, and the card's lines read from the service are the gate).
- **Verification:** `npm run format:check`.

---

## Verification Contract

| Check | Command | Proves |
|---|---|---|
| Format, lint, types | `npm run format:check && npm run lint && npm run typecheck` | style and the exhaustive provider switch |
| Tests | `npm test && npm run test:node` | U1 to U3 scenarios, AE1 to AE5 |
| Builds | `npm run build:app && npm run build:mod && npm run smoke` | the app and mod still build and start |
| By hand | on the regular daemon: ask an agent to comment on a Jira ticket with no card, reject it; ask for a Slack reply by link, reject it; one Jira Service Management ticket of a test project, sent | R4 to R6 on real data, the Assumptions |

## Definition of Done

- Every requirement R1 to R9 holds and AE1 to AE5 each have a named test.
- `ticketRecord`, `where` and R28's message are gone; no code path requires a thread record to propose.
- The manual and glossary parts in U4 are changed in the same PR, which carries this plan.
- Every check in the Verification Contract passes locally with CI's toolchain and in the PR's CI, Windows included.
- No abandoned-attempt code is left in the diff.
