---
title: The chat list reads each agent once, and paired Macs send Learn only when it changed
date: 2026-10-27
status: active
---

# The chat list reads each agent once, and paired Macs send Learn only when it changed

## Why

The audit of 2026-10-25 (plans 032, 033, 035, 038 and 039 took its first five parts) ended with the daemon's own
work: its start, the lists it answers, and what a paired Mac asks of it. Measured on a throwaway daemon with 6 agents
and 117 chats:

1. **Every chat list reads the same agent records over and over.** `ChatListing` (`mod/chat-listing.ts`) reads an
   agent's record from disk three times for each of its chats (`readLocalAgent` for the model, again through
   `isSubagent`, and `lookupLocalAgentName` for the name), plus once per row deciding whether the chat shows, and
   once more per agent tidying the desks. A `list_desks` for 117 chats took 21 ms, and 90% of that was
   `readFileSync` on six small files; `inbox_list` took 9 ms the same way. Both run on the daemon's one thread, every
   time a window or phone opens or its lists change, and grow with the chats.
2. **Every check for a background pass's chat reads Learn's old worker file.** `isPassChat` reads `worker.json` for
   each chat it is asked about, which on most Macs is missing, so each check is a failed open.
3. **Each Inbox mark sends a paired Mac all of Learn and the mods folder, twice.** A mark (and a pin, a sent message)
   tells paired Macs `state_changed`; each asks `peer_state_get`, which reads every Learn and mod file here and sends
   them whole; the asking Mac compares each by time and writes its manifest. Applying the mark there broadcasts it,
   which tells this Mac the same, and the whole exchange runs back. With 1,000 Learn files that is about 390 KB each
   way, and 57 ms to build plus 120 ms to apply, on each Mac's one thread, for one mark.

The audit also named the start: the daemon reads every entry of every chat before its lists are whole. Measured, that
is not worth changing now: with 13,000 turns (35 MB of stores) the socket opens 0.75 s after launch and its first
list already holds every chat, 50 ms later than with 3,000 turns.

## What changes

1. **A list reads each agent's record once.** `ChatListing.desks()` and `inbox()` read records through one lookup
   made for that list, so each agent's file is read once however many of its chats are in it, and whether it has a
   memory folder is checked once. `info(scope)` asked alone (a desk frame, a title push) still reads afresh. Nothing is
   kept between lists, so a record changed on disk shows in the next list, as now.
2. **The pass-chat check reads the old worker file once per list** (`passChats`, `mod/recall-worker.ts`: the rule as a
   function, the file read when it is made). `isPassChat` stays for single checks, made from it.
3. **A paired Mac asks for Learn and the mods only when they changed.** `state_changed` names the folders that
   changed in the burst (`folders`: `learn`, `mods`), and `peer_state_get` takes the folders wanted: the small parts
   (marks, pins, label colours, MCP servers) always travel, Learn's and the mods' files only when asked. A
   `recall_changed` push names Learn. Pairing, reconnecting and the five-minute poll ask for everything, as now.
4. **Older Macs keep working both ways.** A Mac on an older loki ignores `folders` and asks for everything, and a
   `peer_state_get` without `folders` is answered whole. The asking side applies whichever parts came.

## Decisions for review

1. **Per list, not a cache.** Reading each record once per list takes the list to one read per agent without anything
   to keep current: the daemon writes records (rename, model) and nothing has to hear about it.
2. **The mods folder now syncs on the five-minute poll** (and on reconnect), where until now it also rode along with
   any mark or pin. Nothing in loki changes that folder and then says so; it is edited by hand, which the poll already
   covered. Learn, which loki does change, says so with `recall_changed`.
3. **The echo stays.** Applying a paired Mac's marks still tells it back; that pull is now the small parts only, and
   it is what carries a mark on to a third Mac.
4. **The start is left as it is**, with the numbers above. Holding every entry of every chat in memory is the audit's
   memory question, not a speed one.

## Measured

A throwaway daemon (its own `HOME`, offline fake provider) with 6 agents and 117 chats, 13,000 turns:

|                                  | before (main) | after |
| -------------------------------- | ------------- | ----- |
| `list_desks`, median             | 21.0 ms       | 1.4 ms |
| `inbox_list`, median             | 9.2 ms        | 2.3 ms |

Both lists came out the same on both builds (the Inbox's main chats with no messages yet, which tie, in the order
their stores loaded).

Learn's state for a paired Mac, made-up folder of 1,000 files (500 cards with their schedules):

|                                     | before (main)                 | after                   |
| ----------------------------------- | ----------------------------- | ----------------------- |
| one mark: Learn's part sent         | 390 KB                        | none                    |
| one mark: Learn read, then applied  | 57 ms + 120 ms, each way      | not read, not applied   |

What a mark sends now is the small parts alone: the marks, pins, label colours and MCP servers. This was measured on
Learn's own functions (`recallSnapshot`, `applyRecall`) and checked by the tests, not between two paired Macs.

## Tests

1. `test/chat-listing.test.ts`: 30 chats of two agents, in either list, read each agent's record once (a counting
   reader); a record changed between two lists shows in the second.
2. `test/peer-state.test.ts`: a burst tells the folders it changed, and none when only small parts did; a pull asks
   for the folders named, or every one when given none, and applies a reply without them; `peer_state_get` parses no
   `folders` (an older loki's) as every folder and drops names it does not know.
