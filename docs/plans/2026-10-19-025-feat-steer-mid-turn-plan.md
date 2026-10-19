---
title: A message sent during a turn joins it
date: 2026-10-19
status: active
---

# A message sent during a turn joins it

## Why

A message typed while the agent works waits in the app until the turn ends, then starts a turn of its own. So "use
pnpm, not npm" arrives after the agent has already run npm everywhere. loki's own engine can take it sooner:
pi-durable places a message submitted with `whenBusy: "steer"` after the current tool round, inside the running turn
(its README, "Busy Conversations"). loki already steers a background task's notice this way (`daemon/main.ts`), but
never a message the person types.

## What changes

1. **On loki's engine, a message sent during a turn goes out at once and joins the turn.** The app stops holding it
   (`core/attention/use-attention.ts`, `send`, with `sendMode` in `core/attention/model.ts` choosing): it sends it
   as it would to an idle chat, marked to steer, and shows it at once as the person's own. The `chat_send` frame gets
   an optional `steer`; `DaemonChats.send` passes `whenBusy: "steer"` to `chat.submit` when it is set. pi-durable
   places it after the tool round running now; when no tool is running (the agent is writing its answer), it waits
   for the answer and starts the next turn, as a follow-up would.
2. **On an agent (ACP), nothing changes.** ACP runs one prompt per chat at a time and has no way to add to a running
   one (`@agentclientprotocol/sdk` 1.9.0), so a message sent during a turn waits as it does today, shown as queued,
   and can still be taken back.
3. **Another Mac and the phone.** `steer` crosses with the frame (`mod/chat-router.ts` forwards it as sent): the
   chat's home Mac steers, wherever it was typed.
4. **`docs/manual.md`** says what happens to a message sent while the agent works, for each kind of chat.

Left out (2026-10-19, while building): making the queued send at a turn's end mark the chat seen, as a send typed
at once does. The two paths differ on purpose here: a queued message leaves when the agent's answer lands, maybe
after the person left the chat, and marking it seen then would clear the mark of an answer they have not read.

## Decisions for the person

1. **Always steer, or a choice per message?** Always, on loki's engine (the person chose this on 2026-10-19). One
   behaviour, nothing to learn, and **stop** still ends a turn going the wrong way.
2. **No taking back a steered message.** It is placed within one tool round, usually seconds. pi-durable can withdraw
   a submission not yet placed (`submission.abort`), so a take-back can come later if it is missed.

## Tests

1. The daemon, on a real pi-durable store with a faux model (`test/chat-backend.test.ts`): a message sent with
   `steer` while a tool runs is read by the agent's next step in the same turn; without it, it starts a turn of its
   own (the existing test).
2. The frame: `chat_send` keeps `steer: true` and drops anything else (`test/frames.test.ts`).
3. The app's choice (`sendMode`, `test/attention-model.test.ts`): at once when idle, steered during a turn on loki's
   engine, queued during a turn on an agent.
4. By hand: in a long turn of tool calls, a message sent midway changes what the agent does next.
