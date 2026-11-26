---
title: Quick replies under an agent's last reply
date: 2026-11-02
status: active
---

# Quick replies under an agent's last reply

## Why

When an agent ends a turn at a fork ("run the migration now, or show you the diff first?"), the answer is usually one
of a few short phrases, and typing it is the slowest part. AskUserQuestion covers a question the agent must stop for;
nothing covers the lighter case where the turn is already over and the agent just offers where to go next. Suggestions
(plans 049, 052) are for work in another chat and stay behind their chip; quick replies are for this chat only.

## What changes

1. **The agent offers them in its reply.** At the end of a reply it may add one block:

   ```
   <loki-replies>
   - run the migration
   - show me the diff first
   - skip it for now
   </loki-replies>
   ```

   Two to four options, each a short line that is sent word for word as the person's message, so each must read as
   something the person would say. Anything outside that shape (one option, more than four, a line over 80 characters,
   a block that is not the reply's last thing) is dropped and the reply shows as written without it.
2. **What agents are told.** One short paragraph: offer quick replies only when the turn ends on a choice the person
   is likely to make from a few clear options; never on every reply, never in place of AskUserQuestion when the agent
   cannot go on without an answer, never for work in another chat (that is a suggestion). Loki's own chats get it as a
   prompt section (a `replies` section beside `memory`, through an extension like `memoryExtension`); ACP agents get the
   same words in `agentPrompt` (`daemon/acp/prompt.ts`), with or without loki's tools, since it needs none.
3. **Parsing lives in `core/harness.ts`.** `repliesOf(text)` returns the options or null; `stripHarnessMarkup` takes
   the block out, so the reply's text, the Inbox's `lastAssistantText`, history search and the chat mirror never show
   it. While a reply streams the block is hidden as soon as its opening tag appears.
4. **Where they show.** As a row of text buttons under the chat's last message, only when that message is an
   agent's finished reply holding the block. They are drawn inside the thread, after the last row, never between the
   thread and the box: there, their going away made the thread taller in the frame the sent message arrived, the
   browser moved the scroll up, and the thread took it for the person scrolling away and stopped following (seen on
   the phone, where three 44px buttons stack). Mac and phone, in the chat screen and on the chat's Inbox card (the card
   draws the same Conversation). Desktop labels are the options as written, lowercase being the agent's choice of words;
   the buttons do not restyle them.
5. **A click sends the option.** It goes through the same path as a typed message (`chat_send`), so it queues the same
   way if a turn is somehow running, shows in the thread as the person's message, and the agent reads it as one.
6. **When they go away.** They belong to the last message, so they disappear as soon as anything follows it: a message
   the person sends (clicked or typed), or a new turn. Nothing is stored; a reload shows them again while that reply is
   still the last message.
7. **Keys.** On the Mac, while the message box is empty and has focus, 1 to 4 send the matching option; the buttons
   show their number. A non-empty box types the digit as usual. The phone has no keys for them.
8. **No reply-like-a-question guess for them.** A reply with quick replies already ends on a question; the Inbox's
   `looksLikeQuestion` heuristic keeps working on the text with the block stripped, so nothing changes in the ranking.

## Decisions for review

1. **A tag in the reply, not a tool.** A tool call would need a stored record, a frame and a way to clear it; a tag in
   the reply's text needs none of that, survives every engine (loki's own, Claude Code, Codex over ACP) and dies with
   the reply. The cost is that an older paired loki shows the raw block; the same cost as `<loki-suggested/>` had.
2. **Sent word for word, no editing.** A click sends at once. Anything else is the message box, which is already there.
3. **Only the last reply.** Older replies never show their options, so the thread never offers a fork that has passed.
4. **No count limit beyond four, no styling per option.** Keeps one mechanism.

## Tests

1. `repliesOf` reads a well-formed block, rejects one, five, long and mid-reply blocks, and `stripHarnessMarkup` takes
   the block out.
2. The transcript shows the buttons only under a last, finished agent reply; not while streaming, not under an older
   reply, not once a user message follows.
3. A click calls send with the option's text; 1 to 4 do the same with an empty box and do nothing with text in it.
4. `agentPrompt` carries the paragraph with and without tools; the loki chat section carries the same words.

## Checked by hand

1. A loki chat and a Claude Code chat each end a turn with options; a click sends one and the agent acts on it; typing
   instead clears them. On the Mac, the phone and an Inbox card, with demo daemons for any screenshot.
