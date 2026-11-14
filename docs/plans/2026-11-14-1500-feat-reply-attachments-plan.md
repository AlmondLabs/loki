# Plan: files on a proposed reply

2026-11-14

## Why

An agent that owns a Gmail account was asked to answer a handed-off thread with an invoice attached. `reply_propose`
takes text only, and its prompt line says never to send mail any other way, so the agent could neither attach the file
nor go around the card; it drafted a reply that spoke of an attachment it did not have. The person asked on 2026-11-14
for files on `reply_propose`. Gmail's drafts already carry files (`rfc2822` in `mod/gmail.ts`, plan 076), so the work is
getting them from the agent, past the person, into the draft.

## Requirements

1. **R1.** `reply_propose` takes an optional `attachments`: paths in the chat's folder, as `google_gmail_send` does.
   Only a Gmail reply takes them; on a Slack or Jira reply they are refused with why, since neither draft can hold a
   file.
2. **R2.** The files are checked when the reply is proposed: each is a file inside the chat's folder, at most 10 of
   them, and 25 MB at most together (Gmail's limit for a message). The proposal keeps each file's name, path, size and
   MD5; never its bytes.
3. **R3.** The card names each file and its size under the reply, on the desktop and the phone. The person approves the
   reply with its files as they are; a file they do not want comes off the draft in Gmail before they send it, as any
   other change does.
4. **R4.** Approving reads each file again. A file that is gone or changed since it was proposed (its MD5 differs)
   refuses the approve with which file and why, and the reply waits; the person rejects it and the agent proposes again.
   So the draft holds the files the card named.
5. **R5.** A file goes with a type guessed from its name (Drive's guess, now shared), not as raw bytes, so the people
   it goes to can open a PDF in place. `google_gmail_send` uses the same guess.
6. **R6.** The agent is told the files with the rest: in the tool's answer, and in the notice once the draft is written.

## Decisions

1. **Paths, not Gmail attachment ids.** A file in another mail reaches the folder with `google_gmail_attachment` first;
   one way in keeps the check in one place.
2. **No removing a file on the card.** The draft is the person's to edit before it goes, and nothing is sent; a remove
   control would be a second editor for what Gmail already edits.
3. **Changed means refused, not re-read.** Approving a different file from the one the card named would make the card
   untrue.
4. **Out of scope.** An ACP chat's tool calls have no folder (`ToolContext.cwd`), so they are refused there, as
   `google_gmail_send`'s attachments already are. The prompt line "never send mail any other way" beside a script's
   `google_gmail_send` is left as it is.

## Units

1. **U1.** `ReplyAttachment` in `core/frame-types.ts`; `ReplyProposal.attachments`, parsed from the saved file.
2. **U2.** `mod/reply-proposals.ts`: the tool's `attachments`, resolved in the chat's folder (`inChatFolder`), checked
   and recorded in `propose`, read and compared in `write`, passed to `createDraft`; the tool's answer and the drafted
   notice name them.
3. **U3.** The cards (`app/src/item/proposal.tsx`, `app/src/desk/reply-proposal-card.tsx`) list the files.
4. **U4.** Tests in `test/reply-proposals.test.ts`; `docs/manual.md` and `glossary.md`.
