---
title: The agent searches its own chat's earlier turns after a compaction
date: 2026-10-31
status: active
---

# History search after compaction

## Why

A compaction (pi-durable's, automatic or `/compact`) replaces a chat's older turns in the agent's context with one
summary. The turns stay stored, and the person still sees them in the thread, but the agent can no longer reach them:
its only tools for the past are its memory notes. What the summary left out is gone for the rest of the chat, and a
long chat compacts again and again (the largest chat in one person's store has 11 compactions over 2,822 entries).

mainplane (github.com/mainplane-ai/mainplane) turns compaction off and, when a session is full, starts a new one that
names the old session's log; its agent finds what it needs in that log with `rg` as it goes. The part worth taking is
the retrieval: a pointer and a search lose nothing, and the agent spends context only on what it looks up. A new chat
is not: the person keeps one chat, and pi-durable's compaction already empties the context in place.

## What changes

1. **Compaction stays as it is.** pi-durable's background, blocking and overflow compactions and `/compact` run as
   now, with its default thresholds; the chat, its id and its thread do not change.
2. **Two tools over the agent's own chat**, a built-in extension (`daemon/history-tools.ts`), both of kind read:
   - `history_search { query }`: the turns of this chat whose text contains the query, case-insensitive, newest first,
     at most 10 hits, each its row number, who spoke, when, and about 300 characters around the match. It says when
     there were more.
   - `history_read { from, to }`: the rows from `from` to `to` as text (who spoke, the words, each tool call with its
     shortened output), cut at about 8,000 characters, its last line saying where it stopped.

   The rows and their numbers are the thread's (`ChatProjection.since`, as reflection reads them), so a number the
   agent cites is a row the person can find. They cover the whole chat, before and after the last compaction: the
   recent turns cost nothing to search and the agent need not know where the cut is.
3. **They read the daemon's copy, not the database.** `ChatProjection` already holds every chat's log in memory, kept
   up to date on each commit. The tools find the chat as the memory tools do (`AgentInfoDoc` and `ChatDoc` from the
   call's reader), then read the projection: no disk read, no index. The projection is made after the built-in
   extensions in `daemon/main.ts`, so the extension takes it through a getter.
4. **The agent is told where the rest is.** pi-durable's summarizer writes the summary as now. The extension adds a
   prompt section, `history`, shown only once the chat has a compaction (`ChatProjection.compactedSince`): "Earlier
   turns of this chat were summarized above; every one is stored. Find them with history_search and read them with
   history_read before you guess." The section appears at a compaction, when the prompt cache is rebuilt anyway, and
   stays the same after it, so it costs no cache.
5. **Only where it fits.** Chats on loki's engine only: an ACP agent compacts in its own way and has its own history.
   The hidden pass chats (reflection, Learn, doctor) name their tools and do not get these.
6. **The manual** says, beside `/compact`, that the agent can look back over the whole chat after a compaction.

## Decisions for review

1. **Same chat, no new session** (decided 2026-10-31). mainplane's "continue in a new session" is not taken; only its
   retrieval is.
2. **A plain scan, no index.** Measured on a real store (59 MB, 10,387 entries, 31 chats): a full-text scan of the
   largest chat (13 MB of raw records) takes about 23 ms in SQLite; the projection holds less (text and shortened
   tool output, no images) and is already in memory. A search runs on the daemon's main thread, so if chats grow 10 to
   50 times larger it moves to a worker or gets an FTS5 index in a file of loki's own, never in pi-durable's database.
3. **Hits are capped, not ranked.** Newest first, 10 at a time: the cost that matters is context, not time. Substring
   matching misses synonyms; the agent tries other words, as mainplane's does with `rg`.
4. **A section, not a `beforeCompact` hook.** The hook can only decline a compaction or return a whole summary of its
   own, not steer pi-durable's summarizer; writing loki's own summary would be a second model call inside
   pi-durable's task, which holds up a blocking compaction. The section gives the pointer without either. A summary
   of loki's own (one that keeps the chat's goal and open work) can come later through that hook.
5. **The agent is not shown its context size.** mainplane prints it after every tool result so the agent can save
   notes before the limit. Left out here: reflection already runs right after a compaction. A later plan can add it
   with `afterTool`.

## Tests

1. `history_search` finds a word in a turn before a compaction, gives its row, speaker and excerpt, stops at 10 hits
   and says there were more; a chat of another agent with the same chat id is never read.
2. `history_read` returns a range as text, cut at the limit with the line saying where; a range past the end is
   empty, not an error.
3. The `history` section is absent before a chat's first compaction and present, unchanged, after it.
4. The tools are not offered in pass chats or ACP chats; both declare kind read (`test/extensions.test.ts`).
5. Memory storage and a fake model (`test/fixtures`), no real provider or home.

## Checked by hand

A long chat on a throwaway daemon, `/compact`, then a question about something from before it: the agent calls
`history_search`, reads the rows and answers from them; the thread shows the calls as quiet tool rows.
