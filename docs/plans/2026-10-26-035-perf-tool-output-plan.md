---
title: Tool output capped where it leaves the daemon
date: 2026-10-26
status: active
---

# Tool output capped where it leaves the daemon

## Why

The audit of 2026-10-25 (plans 032 and 033 took its first two parts) found that a tool's whole output travels and
stays where only 4,000 characters of it are ever shown:

1. **Every tool result goes to every socket raw.** `tool_execution_end` (`daemon/chat-events.ts`) pushes the result's
   content as pi-durable stored it, and so do ACP chats (`daemon/acp/chats.ts`): a picture from `view_image` or an MCP
   tool as base64, a whole file from `read`, a long command's output. Every desktop tab, phone and paired Mac following
   the chat gets it, one `JSON.stringify` per socket, and the app keeps the first 4,000 characters (`toolOutput`,
   `core/harness.ts`).
2. **A call's arguments go whole too.** An answer's tool calls carry their arguments, so a `write` sends the file it
   writes, and an `edit` both texts.
3. **The daemon keeps all of it for good.** The projection (`daemon/chats.ts`) keeps every entry's steps in memory, for
   every chat, hidden ones included, and a result step held the raw content and a call step the raw arguments.

## What changes

1. **One function says what a step needs to be shown** (`shownStep`, `core/attention/pi-steps.ts`): a result becomes
   its text, capped as the app caps it (pictures and other non-text parts leave nothing, as in the app today); in a
   call's arguments every string is cut to the cap. An argument still being streamed as text is left whole, since cut
   it might not parse.
2. **Steps are shown that way everywhere they leave a message:** `messageSteps` applies it, which covers the projection,
   history pages and both engines' written answers; `DaemonChats.attach` applies it to every step event pushed to the
   sockets, which covers live tool results from loki's engine and from ACP agents.
3. **Capping twice is the same as once** (`cap`, `core/harness.ts`): a text that already ends in the cap's
   "… N more characters" line at the cap's length is left alone, so the app's own cap of a capped output changes
   nothing.

Nothing on screen changes, with one exception: a tool whose input is shown as its whole JSON (one with no command, path
or pattern to show), with a string longer than 4,000 characters in it, says fewer "more characters" after the cut,
since the daemon has already cut that string. The first 4,000 characters shown are the same.

Approval cards keep the whole input: deciding needs it, and they are rare.

## Decisions for review

1. **Cut at the daemon's edge, not in each engine.** `attach` is the one door every chat event goes through (loki's
   engine, approvals, ACP), and `messageSteps` the one every stored message is read through.
2. **The store keeps everything.** Only what the projection keeps in memory and what goes to clients is cut; the model
   and pi-durable's entries still have the whole output.

## Measured

A throwaway daemon with a fake provider whose answer is two real tool calls in a scratch folder: `write` with a
395 KB file, then `bash` printing it (`bash` keeps the last 50 KB). What one window following the chat received for
the turn, twice each, the same both times:

|                         | before (main) | after |
| ----------------------- | ------------- | ----- |
| the turn's chat events  | 445 KB        | 10 KB |
| the `write` call step   | 392 KB        | 4 KB  |
| the `bash` result step  | 51 KB         | 4 KB  |
| the history page after  | 5 KB          | 5 KB  |

That is per window: a desktop tab, a phone and a paired Mac following the chat each got the 445 KB. History pages were
already cut when folded, so they read the same. What the projection keeps in memory was not measured; the steps it
keeps are the same cut ones (`messageSteps`).

## Tests

1. `test/tool-steps.test.ts`: capping a capped text changes nothing. `shownStep`: a result with a picture and a long
   text is its capped text and folds as the whole result did; long strings in a call's arguments, nested ones too,
   are cut, and the step's label and shown input are the same as from the whole arguments; arguments still arriving
   as text, and words, pass as they are.
2. `test/chat-backend.test.ts`: a turn whose call has 100,000-character arguments and whose tool answers 100,000
   characters pushes both cut, everything pushed for the turn stays under 30 KB, and the model's next request still
   has the whole output.
