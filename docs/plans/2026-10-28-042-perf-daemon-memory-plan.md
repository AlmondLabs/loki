---
title: The daemon lets go of whole tool outputs and loads chats a few at a time
date: 2026-10-28
status: active
---

# The daemon lets go of whole tool outputs and loads chats a few at a time

## Why

The daemon keeps every chat's entries in memory as thread steps (plan 017, U6), each tool's output cut to 4,000
characters (plan 035). Measured on 2026-10-28 with a throwaway daemon on a copy of one person's stores (196 chats,
about 450 MB of entries; no keys, so nothing ran): 233 MB of heap once settled against 40 MB on an empty folder, and
519 MB while the chats loaded. The running daemon's footprint was 380 MB.

A heap snapshot put 192 MB of the 233 in strings, and 77 MB of those were whole tool outputs nothing kept on purpose.
V8 keeps a cut of a long string as a view into the whole of it, so each 4,000-character output held the full output
it was cut from. Another 11 MB was the same for a user's words with loki's markup taken out.

The load peak came from loading every chat of a store at once, each read whole before its steps were made.

## What changes

- `ownText` (core/harness.ts) copies a text so that it holds its own characters, through a JSON round trip, the one
  copy every engine makes whole. A tool's output and arguments cut to `TOOL_TEXT_MAX`, and a user's words with markup
  taken out, are kept as such copies.
- The chat projection loads four chats of a store at a time (`LOAD_AT_ONCE`, daemon/chats.ts), and keeps each entry as
  its steps as each page of 500 is read (`AgentStore.eachEntry`), so whole records are never all held together.

## Trade-offs

- Every cut is copied once, 4,000 characters at most; it now owns 40 MB of text it used to share with outputs that
  were held anyway, which is why the net saving is 52 MB, not 90.
- Loading four at a time could make the first chat list wait longer on a store with many chats; on the copy it was
  not measurable against the rest of the start.

## Results

On the copy, two runs each (heap, MB):

| | peak while loading | settled |
| --- | --- | --- |
| before | 519, 521 | 233, 233 |
| after | 410, 411 | 181, 181 |

What stays is chat history itself: 40 MB of cut outputs, 35 MB of messages' words and 33 MB of users' words with
their markup. Keeping less of every chat is a larger change to plan 017's projection, for a plan of its own.

## Tests

- A store with seven chats, one longer than a page of entries, loads every chat whole.
- `ownText` reads the same as its text, lone surrogates included.
