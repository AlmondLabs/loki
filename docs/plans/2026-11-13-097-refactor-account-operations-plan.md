---
title: Account operations through scripts - Plan
type: refactor
date: 2026-11-13
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Account operations through scripts - Plan

Plan 097 · follows plan 067 (the account tools), plan 2026-11-11-1011 (scripts and the Google tools), plan 094 (fewer
tools) and plan 095 (two background tools)

---

## Goal Capsule

- **Objective:** each thing loki can do with an account (read a Gmail thread, a Slack thread, a Jira ticket, list
  Flow's cards) is written once. loki's own code calls it directly, and agents reach it only through scripts. The
  model's list loses `account_list`, `account_read` and `account_search`. Every service is reached in one way, and
  scripts can combine a Slack or Jira read with other work.
- **Means:** one layer of typed account operations over the clients that exist now. Each operation is registered once as
  a script-only tool, in the `google`, `slack`, `jira` and `flow` namespaces. Three things that today make a script a
  worse way to read than `account_read` change with it: fencing, asking, and Claude Code chats.
- **Authority:** this plan's Requirements, then its KTDs. The person asked for this design on 2026-11-13, after the
  trace of the account tools showed the duplication is Gmail's alone, and the costs of cutting it lie in how scripts ask
  and answer.
- **Stop conditions:** stop and ask if a script's answer cannot be fenced at the script tool's boundary (U3); if the
  approval hook cannot tie a script's calls to one decision for the whole run (U4); or if loki's MCP server for ACP
  chats cannot run a script with the same sandbox and confinement (U5). Each has a fallback named in its unit. Pick
  one with the person; do not take it alone.
- **Execution profile:** one branch, one PR, or two if U5 turns out large (U1–U4 first, U5 second, each with its
  docs). The person raises and merges them.

---

## Product Contract

### Summary

An agent that owns an account no longer has three account tools of its own. It writes a short script:
`await slack.slack_read({ account, thread })`, `await google.google_gmail_search({ query })`, or
`await flow.flow_list({})`. Reads run without a card in standard mode, as `account_read` does now. A script that
changes or sends asks once, at its first such call. Whatever stranger's text a script brings back reaches the model
fenced, as `account_read`'s does. Claude Code and other ACP chats get the same script tool through loki's MCP server.
Hand-offs, reply proposals and Flow are unchanged for the person.

### Problem Frame

Gmail is read in two ways today: `account_read` and `account_search` for the model, and `google_gmail_read` and
`google_gmail_search` for scripts. Each pair has its own text extraction. Slack and Jira are read only through
`account_read`, so a script cannot reach them. The model's path is the safer one, for three reasons:

1. Its text is fenced as a stranger's.
2. It counts as a read, so it never asks in standard mode.
3. It reaches ACP chats.

A script fences nothing, asks as a command, and runs only on loki's own engine. Cutting the model's tools without
changing that would make reading mail worse. Changing it makes one path good enough for everything.

### Requirements

- R1. **One implementation per operation.** Gmail search, read, modify, send and attachment; Slack read; Jira read; and
  Flow's list each exist once, as a typed function over the account's client. loki's own code (hand-offs, reply
  proposals, Flow's sync) calls those functions where it reads the same things now. Gmail's text comes from one
  extractor.
- R2. **Agents reach them only as script-only tools.** `slack_read`, `jira_read` and `flow_list` join the `google_*`
  tools, in the `slack`, `jira` and `flow` namespaces. Each checks on every call that the account it names is the
  calling agent's, as `ownedAccount` does now. They answer in JSON (`structuredOutput`), and a script reads their
  fields.
- R3. **`account_list`, `account_read` and `account_search` are gone** from loki's engine and from ACP chats. Old
  chats show their calls as they were (as plan 094's R6). The hand-off message and `reply_propose`'s description name
  the script tools instead. The prompt's "Your accounts" section stays, as the one place an agent learns its accounts.
- R4. **Stranger's text is fenced in a script's answer.** A tool whose answer carries text someone else wrote declares
  so. When a script called such a tool, the script tool's answer to the model is fenced as content from senders, not
  instructions, with markup that could pass for loki's own made inert. `docs/SECURITY.md` says what this does and
  cannot do.
- R5. **A script asks by what it does, once.** Nothing is asked when the script starts. Its calls are weighed by their
  own kinds in the chat's mode. The first call that would ask shows one card naming that call. Approving it covers the
  rest of that script's run, and declining it ends the script. In standard mode, a script that only reads never
  asks. Strict mode still asks for each call. "Always allow" is still never offered for a script.
- R6. **ACP chats get the script tool.** loki's MCP server offers Claude Code and other ACP agents one script tool,
  with the same sandbox, limits, namespaces, confinement, asking and fencing as loki's own engine.
- R7. **The prompt costs no more than it saves.** The script section with four namespaces, together with the script
  tool, costs no more than the three removed tools' definitions plus today's script section. The measurement is
  pinned in `test/scripts-prompt.test.ts`.

### Scope Boundaries

- Not in scope: Slack search (loki's Slack client does not call `search.messages`), Jira search, and any new write
  for Slack or Jira. Slack and Jira stay read-only to agents, and replies still go through `reply_propose`.
- `reply_propose` stays a direct tool: it is the approval card, and it never asks.
- No change to what the person sees in Flow, hand-offs or reply cards.

---

## Planning Contract

### Key Technical Decisions

- **KTD1. Operations as plain functions; tools as thin wrappers.** `mod/account-ops/` holds one module per service
  (`gmail.ts`, `slack.ts`, `jira.ts`, `flow.ts`). Each holds functions that take a client and arguments and return
  typed data. `mod/google-tools/gmail.ts` and `mod/account-tools.ts` move onto them. `slackThread`, `gmailText` and
  `jiraThreadText` stop being private to the account tools. The script-only tool for each is `modToolOf`'s shape:
  name, description, schema, kind, owner check, `structuredOutput`.
- **KTD2. A taint flag per script run, set by the tools it called.** A tool declares `strangerText: true` (the Gmail
  reads and search, the Slack and Jira reads, `flow_list` for senders and subjects, Drive and Docs reads). The
  `loki.scripts` wrapper already sees each nested call through `confinedApi`. It marks the run when one of those runs.
  On the way out, it wraps the script's whole text answer in the fence `fenceThread` uses (one block, sender "a
  script's reads"), with markup made inert.
  - Fencing the whole answer, not each field, keeps it one rule in one place: the script decides what it returns, so
    no field-level mark survives it.
  - A script can still pass stranger's text on through a file it writes and the model later reads. That is no wider
    than today, where the model can write `account_read`'s text to a file. It is added to the residual risks.
- **KTD3. Asking: one decision per script, made lazily.** The approval hook knows a nested call by `call.parent`.
  - Outside strict mode, the first nested call that `asks()` would ask about raises a card. The card names the script's
    call and its arguments.
  - The decision is kept in the memo under the parent's id (`approval:script:<parent id>`). Every later call in that
    run reads it, and a resumed run reads it too.
  - A decline blocks that call and every later one in the run, and the script ends with the reason.
  - The script tool itself becomes a read, so it no longer asks on its own. Strict mode keeps today's rule: every call
    asks.
  - This replaces plan 2026-11-11-1011's KTD4 ("nested calls ask only in strict"). That rule existed so a forty-file
    move would not raise forty cards; one card per run keeps that.
  - Flag reversal, agreed with the person on 2026-11-13: in standard mode a script that only reads no longer asks. Before this, every
    script asked.
- **KTD4. ACP chats run scripts through the same confinement.** `daemon/acp/loki-tools.ts` builds an MCP server per
  request from the mod's tools. It gains one `script` tool. That tool runs the code in `scriptSandbox()` with
  `withTimeLimit`, and exposes as functions only the agent's script-only tools, called through the same mod tool path,
  so the owner check and logging are unchanged. Approval and fencing go through the same functions as on loki's
  engine (KTD2, KTD3), called with the ACP chat's mode.
  - Fallback, if pi-durable's Code Mode cannot be driven outside a Harness: the four namespaces' read tools are offered
    to ACP chats directly, with text output fenced as `account_read`'s is now. The person picks.
- **KTD5. Names.** Following `google_gmail_read`: `<namespace>_<verb>`, so `slack_read`, `jira_read` and `flow_list`.
  The namespaces' descriptions say what each is for, in one line each.

### Units

- **U1. Operations layer.** Create `mod/account-ops/` and move the readers that already exist there:
  `thread.ts` (`ThreadMessage`, `ThreadText`), `gmail.ts` (`gmailThread`, `mailParts`, `mailAttachments`,
  `mailHeader`) and `slack.ts` (`slackThreadText`, `senderOf`, `tsIso`), out of `handoff.ts`. Jira's reader,
  `jira-view.ts`'s `jiraThreadText`, was already the one every caller shares, so it stays put. `account_read` drops its
  own Gmail and Slack readers for these, and `google_gmail_read` takes `mailParts`' text. Behaviour changes only where
  the copies differed: `account_read` shows Slack links and mentions by their labels, as a hand-off does, and a script's
  mail text is tidied and falls back to the snippet. Flow's list comes in U2. Tests: the shared Gmail reader (subject,
  the person's own messages, text fallbacks) and the existing hand-off, card and tool tests unchanged.
- **U2. Slack, Jira and Flow script tools.** `slack_read`, `jira_read`, `flow_list`, their namespaces, and the owner
  check per call. Tests: the agent that owns the account reads; another agent is refused without being told whose it
  is; JSON shapes.
- **U3. Fencing.** `strangerText` on a mod tool's annotations (`daemon/mods/api.ts`), set on every Google read,
  `google_api`, and the three U2 tools. `fencedIfRead` in `daemon/scripts.ts` reads the calls Code Mode lists in a
  script's result (`details.calls`, kept with the result, so a resumed script is judged the same) and fences the whole
  answer when any was marked. The fence helpers moved from `handoff.ts` to `mod/account-ops/fence.ts`. Tests: a script
  that read a marked tool answers fenced with a forged closing tag made inert; one that read only a file answers bare;
  a failed one that read is fenced. The file pass-through, and the whole of an answer too long for the model, which
  goes to a file, are written down as residual risks.
- **U4. Asking.** The script tool is a read (`withKind("read")` in `daemon/scripts.ts`). In `daemon/approvals.ts` a
  script's call is weighed by its own kind; outside strict the first that would ask raises one `codemode` card with
  `{ code, first_call: { tool, input } }`, and every later call of the run, calls made at once included, takes its
  answer. A tool's memos are its own task's and a script's calls are tasks of their own, so the run's code and answer
  are held in memory (`scriptRuns`), set when the script's call passes the gate and cleared after it; each call's own
  decision is still memoized, so a call resumed after a restart never asks again, but a later call of a script resumed
  after a restart may ask once more. Tests: a read-only script asks nothing in standard; a script that writes three
  times, two at once, raises one card that shows its code and first call; a decline refuses every later call; strict
  asks for the script and each call; "always allow" is still not kept.
- **U5. ACP script tool.** Done without the fallback: pi-codemode's `CodemodeSandbox.start` runs a script with the
  run's own tool list and answers each call itself, so `daemon/acp/scripts.ts` drives the daemon's sandbox directly.
  loki's MCP endpoint serves `script` to an agent with script-only tools, its description listing them, and a script
  reads one's signature with `describeTool(name)`. It is marked read-only, so the agent does not ask before it; the
  first call of a tool that is not a read raises one loki card (`codemode`, `{ code, first_call }`), whose answer
  stands for the run. That card asks even when the agent's own mode would not have; the agent's mode is its own, and
  loki cannot read it. The answer is fenced from the run's calls, as U3. Differences from loki's engine: no file tools
  (they are pi-durable's, not ChatTools), and `store`/`load` values are not kept between scripts. Tests: the listing
  shows `script` and not the tools behind it; a read answers fenced without a card; three sends, two at once, raise
  one card; `describeTool` answers.
- **U6. Removal and words.** Remove the three account tools. Update the hand-off message and `reply_propose`'s
  description; `docs/manual.md` (accounts, scripts, permission modes); `docs/SECURITY.md` (what reaches the model,
  scripts' asking, residual risks); `glossary.md`; and `skills/loki/SKILL.md`. Measure the prompt (R7).

### Verification

- Every check in AGENTS.md, with CI's toolchain.
- By hand, in a standard-mode chat of an agent that owns Gmail, Slack and Jira accounts:
  1. Ask for the last Slack thread and a Jira ticket's comments. They run as scripts with no card, and the answer is
     fenced.
  2. Ask it to archive three mails. One card appears, and all three are archived.
  3. Hand a thread to the agent. It reads newer messages with a script.
  4. In a Claude Code chat on the same agent, the same read runs through loki's `script` tool.
