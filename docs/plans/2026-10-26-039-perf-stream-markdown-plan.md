---
title: A streaming reply parses only its last block
date: 2026-10-26
status: active
---

# A streaming reply parses only its last block

## Why

The audit of 2026-10-25 (plans 032, 033, 035 and 038 took its first four parts) found that the reply being written
is parsed whole with every piece that arrives:

1. `AssistantBody` (`app/src/chat/transcript.tsx`) hands the whole reply so far to `react-markdown` with `remark-gfm`
   on each update, about seven times a second while a reply streams.
2. `rehypeWords` then wraps every word in its own span, so React compares one element per word of the whole reply
   each time. A reply of 2,000 words is 2,000 spans compared, and a markdown parse of all of it, for every few words
   added. The cost grows with the reply, so a long answer gets slower to draw the longer it gets.

The spans are wanted: each new word mounts and fades in while the words before it stay put (the phone's chat CSS).
That stays as it is.

## What changes

1. **While a reply streams, it is drawn in blocks** (`streamBlocks`, `app/src/chat/stream-blocks.ts`): cut at blank
   lines, never inside a fenced code block, each block its own memoised `Markdown` keyed by where it starts in the
   reply (which words added after it never change). A block before
   the last no longer changes, so it is neither parsed nor compared again; only the last one is, as its words arrive.
   Words keep their spans, so a new word still fades in and the words before it stay put.
2. **When the turn ends the reply renders whole, as now**, so a finished message is exactly what it was.

## Decisions for review

1. **Blank lines, outside fences, are where a block ends.** That is where markdown ends a paragraph, a heading, a list
   or a table. While streaming, a list whose items are apart by blank lines draws as several lists, and a reference
   link defined further down draws as text until the reply ends; both are right again in the finished message.
2. **One component draws every block**, so the block that was last and is now finished keeps its element: nothing is
   mounted again, and its words do not fade in twice.

## Measured

A throwaway daemon whose fake provider streams 2,000 words in 50 paragraphs over about 18 seconds, into the open chat
on the desktop (Vite, React Scan's hook, counting what React worked on for the whole reply):

|                                  | before (main) | after |
| -------------------------------- | ------------- | ----- |
| word spans React worked through  | 78,398        | 3,353 |
| markdown parses                  | 85, of the whole reply so far | 135, of one block each |
| commits                          | 164           | 141   |

Before, the words compared grew with the reply (1,870 on screen at its longest), so each update cost more than the
last; after, each update works on the paragraph being written. On this Mac the frames held in both (one frame over
50 ms before); the second run's frames could not be counted, as the browser pane was hidden and paused them. A
slower machine or a phone is where the difference shows.

## Tests

`test/stream-blocks.test.ts`:

1. Blocks end at blank lines, however many; a fenced block keeps its blank lines whether it is closed yet or not, and
   a shorter or different fence inside it does not close it.
2. Through `Transcript`: a streaming reply with a heading, inline marks, a table, a fenced block with a blank line and
   a list, drawn in blocks, gives the same HTML as drawn whole once the word spans and the cursor are left out (and
   the line breaks react-markdown puts between blocks drawn in one go, which draw nothing); every word but code is in
   its span while streaming, none once finished.
