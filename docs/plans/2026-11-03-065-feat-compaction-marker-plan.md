---
title: A marker where a chat was compacted
date: 2026-11-03
status: active
---

# A marker where a chat was compacted

## Why

A compaction shows wrongly while it happens and not at all afterwards. pi-durable writes the summary as a user
message, and sends it as one (`message_start`); `daemon/chat-events.ts` shows every user message it is sent, so the
whole summary appears live as a message from you, until a history page replaces the thread, where the `pi.compaction`
entry is one of the kinds never shown. `compaction_start` and `compaction_end` are dropped. When a
compaction holds the turn up (a blocking one: 79 to 151 seconds each, eight times in one agent's chats in October),
the chat shows "running" with nothing happening, which reads as the task having stopped. Afterwards there is nowhere to
see where the agent's verbatim memory starts or what the summary kept, which is what you want to look at when the
agent seems to have forgotten something.

## What changes

1. **One quiet row where the compaction happened.** "chat compacted", an event row like a loaded skill's, sitting
   where the summary entry was written: what is below it the agent still has word for word, what is above it only as
   the summary. Opened, it shows the summary (the text inside pi's `<summary>` wrapper). It is not a work row, so it
   ends a stretch of tool steps, as `toolRuns` already says a compaction does.
2. **While a compaction holds the turn up, the row says so.** A blocking `compaction_start` puts in "compacting the
   chat" with "summarising earlier turns…" beside it; the summary entry turns that row into "chat compacted". A
   background compaction shows nothing until its summary is written, since the agent keeps working meanwhile and a
   background summary that goes stale is never used.
3. **A failure says so in words.** A `compaction_end` with an error turns the running row (or a new one) into
   "compaction failed", the error behind it. One that ends with neither a summary nor an error takes its running row
   away.
4. **The summary is never a message.** The converter takes a user message from `message_end`, which pi-durable sends
   with it in the same batch and which carries the entry's kind, instead of `message_start`; a `pi.compaction` entry
   becomes the row of item 1.
5. **History has it too.** `entrySteps` reads a `pi.compaction` entry as the same step, so every compaction already
   stored shows when a chat is opened, and a live row pairs with its page row by role and text like any other.
6. **Nothing else counts it.** It is not a message: the Inbox, the chat list's last words and unread counts read only
   user and assistant rows, so they are unchanged. `history_search` and `history_read` list it as an event row, which
   tells the agent where the summary starts.

## Not in this change

A window opened in the middle of a blocking compaction does not see its running row: what a newly opened window is
told about a chat (`state` in `daemon/loki-engine.ts`) carries the streaming answer, not live compactions. It sees
the finished row when the summary is written.

## Tests

1. `entrySteps` reads a compaction entry as a finished compaction step with the summary unwrapped.
2. The converter turns a blocking start into a running step, ignores a background one, turns the summary's message
   into a finished step and never a user step, still shows a person's message, and turns an end with an error into a
   failed one.
3. The thread turns a running row into the finished one in place, removes it on a bare end, keeps it across a history
   page while it runs, and does not add a second running row for a repeated start.
