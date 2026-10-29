---
title: Two seams made whole: a chat's engine rules, and who a push is for
date: 2026-10-29
status: active
---

# Two seams made whole: a chat's engine rules, and who a push is for

## Why

An architecture survey on 2026-10-29 read the daemon, the mod and the app for places where one idea is spread over
several files. Two were small to fix and had a cost today:

1. **A chat's permission mode falls back in four places, two of them by hand.** `approvals.ts` and `chats.ts` fall
   back to `DEFAULT_MODE`; `loki-engine.ts` and `acp/engine.ts` write `"unrestricted"` again. A change to the
   default would miss two of them. The rule for when a chat may change engine (plan 020, KD4) sits inline in
   `DaemonChats.model`, reachable in a test only through a real store and the fake ACP agent.
2. **Who a push reaches is decided at each call in `mod/index.ts`.** The mod keeps five loose variables for its two
   listeners (`srv`, `ws`, `starting`, `stopped`, `lan`) and a guard that throws, and picks a push's audience by
   which variable it calls: `ws?.broadcast` for the desktop, `lan?.broadcast` for the paired Macs, `broadcast` for
   everyone. The second is wrong: `lan.broadcast` reaches every socket on the LAN listener, so phones get
   `state_changed`, `memory_changed` and `group_changed`, which only a paired Mac reads.

## What changes

1. **`modeOf(stored)`** in `daemon/approvals.ts`: the mode a chat runs in, its stored one or `DEFAULT_MODE`. The four
   fallbacks use it. **`engineMoveRefused(current, wanted, started)`** in `daemon/engine.ts`: why a chat may not move
   to another engine, or null; `DaemonChats.model` throws what it says.
2. **`mod/sockets.ts`**: one `Sockets` owns both listeners. `push(frame, { to, scope })` names the audience:
   `everyone`, `desktop` (the Mac's own tabs) or `macs` (paired Macs only). It starts the loopback server and closes
   it if the mod stopped meanwhile, and holds the phone listener once it is built. `WsBridge.broadcast` takes the
   audience, so a `macs` push skips phones and tabs at the socket.
3. **`core/daemon-calls.ts`** (added the same day, survey item 4): the daemon's settings and agent calls, by feature
   (an agent's memory and skills, Engines, MCP with its always-allowed tools), each one request over the mod socket.
   They were split by frame name: `useDesk` read memory and skills, while `FrameChatClient` wrote them and
   `useAttention` wrapped each write again with its own "not connected" check and error text, 25 times over. `useDesk`
   makes the calls once and Settings and Agents use them; the chat client keeps the chats. A call made while the
   socket is down now waits for it, as every other request does, instead of failing at once.

4. **`mod/peering.ts`** (survey item 5): the paired Macs, wired once. `activate()` built them inline: about 250 lines
   of pairing, links, syncers, the chat directory and router, moves, state, memory and agents, threaded through the
   desk's own wiring and reaching back into it by closure. `startPeering(deps)` takes what it needs from the mod (its
   sockets, its local lists, the chats, the marks) and hands back what the mod needs: pairing for the listener, the
   router for the bridge, Settings › Macs' frames, the merged lists, and whether a push changed the person's state. A
   second pairing code now replaces the first one's lapse timer instead of running beside it.

## Left as it is

1. **The ACP process stays built inside `AcpChats`** (survey item 1). The ACP tests' 10 ms wait is the `until` helper
   that docs/style.md asks for, not a sleep, and the file runs in 1.9 s; an in-process fake agent would be a second
   copy of `test/fixtures/fake-acp.mjs` to keep in step.
2. **`info.engine?.kind === "acp"`** stays where it is: `ChatEngine` has one kind, so the check reads as "runs on an
   ACP agent", and the migrations ask it about stored data, not about the `Engine` interface.
3. **The agents, providers and labels stay in `useAttention`**: each holds a list the app shows, which a change
   updates; moving them is the `ChatStore` work (survey item 6).

## Checked

1. `test/engine-rules.test.ts`: `modeOf` and `engineMoveRefused` on every case.
2. `test/sockets.test.ts`: each audience reaches only its listeners; a server that comes up after the mod stopped is
   closed. `test/server.test.ts`: a `macs` push reaches a paired Mac's socket and no other.
3. `test/daemon-calls.test.ts`: each call's frame, its reply, and its refusal in words.
4. `test/peering.test.ts`: a pairing code holds the listener up until it lapses; Settings › Macs lists the tailnet's
   computers only; a state push tells the paired Macs once; with no Mac paired the lists are this Mac's.
