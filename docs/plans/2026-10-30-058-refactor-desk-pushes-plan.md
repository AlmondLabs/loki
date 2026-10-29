---
title: What the mod's pushes leave in a tab, as one pure fold
date: 2026-10-30
status: active
---

# What the mod's pushes leave in a tab, as one pure fold

## Why

`useDeskSocket` kept 27 pieces of state, one `useState` each, and one `onmessage` switch set them. A `desk` push alone
called nine setters. A reader had to follow the switch to learn what a push changes, and nothing outside a rendered
hook could check it. It is the same shape `ChatStore` replaced in `useAttention` (plan 052), and the last large one in
the app.

## What changes

1. **`app/src/desk/desk-pushes.ts`**: `DeskSocketState`, every part a push leaves in a tab, and
   `applyPush(state, push, ctx)`, which folds one push in, purely. Each part keeps its object when the push changes
   nothing in it, and the whole state does when nothing changed at all. The clock and the person's last touch of the
   canvas come in `ctx`, so the camera rule can be tested. The helpers it needs (`withScope`, `withMark`,
   `withReasoningEffort`, `macsFromFrame`, the phone demo) move with it.
2. **`useDeskSocket`** keeps the socket and what a push asks to be done: a reply to its waiter, a chat's events to
   their listeners, the gestures and measures held until a desk came, the lists asked for again. Its state is one
   `useState` of `DeskSocketState`. Its callers' own updates (an optimistic model or title) become one `part(key)`
   update each. It returns the same fields as before, so `useDesk` changes only its imports.

## The decision that matters for speed

A push that changes no state, a chat's streamed events above all, must not touch React at all. So the fold is applied
through `useState` and only for `STATE_PUSHES`. `useReducer` for every push would run the hook's component on every
streamed piece: React 19 cannot drop a reducer's no-op before rendering, as it can a `useState` update that returns
the same object.

## Measured

The shell's renders were counted in the running app (a temporary counter in `Shell`, not committed) against a
throwaway daemon with made-up data and the fake ACP agent as its engine. The same scenario ran three times each way:
ten streamed replies over three chats, then five widgets written to the open chat.

| | page load | the scenario |
| --- | --- | --- |
| before | 17, 18, 17 | 51, 51, 52 |
| after | 17, 18, 17 | 49, 53, 52 |

The change is render-neutral, as expected: React already batched the old setters of one message into one render.
What it buys is a fold anyone can read and test, not speed.

## Checked

1. `test/desk-pushes.test.ts`:
   - a desk push's header parts, and that a repeated title changes nothing
   - the marks keeping their maps
   - the camera waiting for the person
   - a pairing code lasting only while the listener is up
   - each restart due showing again
   - streamed events not being state pushes
2. `test/desk-socket.test.ts` runs unchanged against the moved helpers.
3. In the app, after the change: replies streamed in, the widgets landed in the open chat, and its title and unread
   count followed.
