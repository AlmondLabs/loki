---
title: The last three items from the architecture survey
date: 2026-10-30
status: active
---

# The last three items from the architecture survey

## Why

Plans 052 to 059 worked through the 2026-10-29 survey. These are its three remaining items, each small.

## What changes

1. **`onStatus` is a subscription.** The chat client's link status was the one hook left as a property a caller
   sets. It is now `onStatus(fn)` over `Listeners`, returning the way to stop, like every other subscription, and
   `ChatStore` stops hearing it when it lets the client go.
2. **`ScopeDebouncer` is built on `debounce`**: one per desk with work waiting, its delay given once in the
   constructor (its one caller always passed 1,200 ms). Its test uses Vitest's fake timers, as the other burst tests do.
3. **`DaemonChats.busy` reads the chat once.** It fetched the chat and then resolved it, which fetched it again; a
   `find()` that answers null for a missing chat does both. `exportChat` also checked for a waiting approval on top
   of `busy`, which both engines' `busy` already count.
4. **`daemon/acp/catalog.ts`**: `AcpCatalog`, the agents loki knows apart from running them. It owns the agent list
   and its edits, how each agent last went, what each offered in its last session (and its cache file), the model
   picker's entries, and a chat's engine as the app shows it. `AcpChats` keeps the processes and sessions, and tells
   the catalog what a session offered and how a turn went. `acp/chats.ts` goes from 1,072 lines to 963.

## Left as it is

1. **The engines stay built inside `DaemonChats`**, though the survey suggested passing them in. Passing them in was
   so tests could use fakes, but none needs one: the `DaemonChats` tests run on in-memory storage with a stand-in
   model provider, and the ACP tests run the fake agent process. A factory passed in would be a seam with nothing
   varying across it.
2. **`ChatStore`'s handling of a dropped link stays.** `FrameChatClient` reports only `open`, once (it handles a
   reconnect itself, by opening its chats again), so `ChatStore`'s `closed` branch and its settle-on-reopen are not
   reached through it. They are kept for a client that reports drops; removing them is a separate decision.

## Checked

1. `test/acp-catalog.test.ts`:
   - what a session offered survives a restart and reaches the picker, the default featured
   - an agent that is not installed is no quick pick, and Settings says so
   - a sign-in failure reads as signed out, and an edit forgets it
   - an offer that changes nothing writes nothing
2. `test/lifecycle-events.test.ts`: each desk is debounced on its own, and clearing drops the waiting work.
3. The ACP, chat-backend and chat-store suites run unchanged.
