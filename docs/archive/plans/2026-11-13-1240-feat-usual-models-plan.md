---
title: Each agent's usual models start new chats and lead the switcher
type: feat
status: active
date: 2026-11-13
---

# Each agent's usual models

## Goal

A new chat starts on the harness, model and effort the person uses most with that agent, so they rarely open the
switcher. Inside a chat they still switch model and effort freely (within its harness, plan 020 KD4).

## Decisions (the person's, 2026-11-13)

- **Per agent.** friday may run on Claude Code and atlas on loki's own models; each agent keeps its own.
- **Three usual configurations.** A configuration is a model handle plus its reasoning effort. Each agent keeps at
  most three, each with how many times the person switched to it.
- **Written only on a switch.** A `chat_model` request (the person choosing a model or effort, on the Mac or the phone)
  counts: a kept configuration gains one; a new one takes a free place, or the least used one's place when all three
  are taken (the older on a tie). Sending messages writes nothing, and a new chat starting on its usual model is not a
  switch. Few writes, and reading is one small file.
- **New chats start on the top one.** Most used first, the more recent on a tie. With nothing kept yet, or when the
  top one's ACP agent is not running here, the chat starts on the agent's own model as before.
- **The switcher leads with them.** With nothing typed, the agent's usual configurations come first ("Usual"), each
  with its effort; in a started chat only those on its own harness.

## Shape

- `mod/usual-models.ts`: the file `state/usual-models.json` (`{ version: 1, agents: { <agent id>: [{ handle,
  reasoning_effort, uses, at }] } }`), read and recorded atomically, beside `mod/models.ts`'s recent list.
- `daemon/chat-backend.ts`: `model()` records the switch once it succeeds; `create()` applies the agent's top
  configuration through the same path, without recording.
- A `models_usual` push (on connect, and to every window after a switch) carries every agent's list; the app keeps it
  and hands the chat's agent's list to the switcher (`app/src/chat/model-switcher.tsx`).

## Tests

- Recording counts a kept configuration, fills free places, replaces the least used when full, and orders by uses
  then recency; a broken or missing file reads as empty.
- A new chat starts on the top configuration; with none, or with its ACP agent missing, on the agent's model.
- A switch records; creating a chat does not.
- The switcher's "Usual" group comes first, carries efforts, and keeps to the chat's harness once it has started.

## Manual

`docs/manual.md`, where Select model is described: new chats start on the agent's usual model; the switcher's Usual.
