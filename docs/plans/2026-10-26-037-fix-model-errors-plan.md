---
title: A model error stays in the chat, and a scheduled run tries again
date: 2026-10-26
status: draft
---

# A model error stays in the chat, and a scheduled run tries again

## Why

On 2026-10-26 a daily scheduled task fired at 10:00 into an agent's main chat. Its prompt arrived, and then nothing
did. The store shows what happened:

1. The turn started at once. Four model calls each ended with `stopReason: "error"` and no content, retried after 3,
   4 and 8 seconds: `OAuth refresh failed for openai: fetch failed`. The Mac had no network at that moment; the MCP
   servers failed with `fetch failed` around then too.
2. After about 15 seconds pi-durable gave up, and the input ended unanswered with `model_error`. `events.jsonl` has the
   turn as `origin: "schedule"`, `error_code: "model_error"`.
3. **The chat shows none of this.** A live error only sets the window's error line (`l.error`,
   `core/attention/model.ts`), which is gone after a reload or the next turn. History turns an assistant message into
   its text (`messageSteps`, `core/attention/pi-steps.ts`) and ignores `stopReason` and `errorMessage`, so four failed
   calls become four empty rows, which show as nothing. Asked later, the agent could not tell why either.
4. **The task never tried again.** `Schedules.tick` (`daemon/schedule.ts`) writes the firing down and hands the
   prompt over; what became of the turn is not its concern. A daily check lost to a minute without network waits until
   the next day.

## What changes

### 1. A model error is a row in the chat, live and in history

1. **History**: an assistant message with `stopReason: "error"` and an `errorMessage` becomes an event row,
   `the model could not be reached: <errorMessage>`, cut to 300 characters. Retries that failed the same way fold into
   that one row, with how many tries: `(4 tries)`.
2. **Live**: the same row, made from the same entries as they are written (`message_end`), so a live chat and its
   history fold to the same rows. The window's error line stays for what is not a turn's (a folder that did not
   change).
3. A run that failed and then worked shows nothing: the answer is there. The row is for a turn that ended without one.
4. The row is the person's, not the model's: it is not sent back to the model in later turns.

### 2. A scheduled run that hit a model error tries again

1. **The schedule learns how its turn ended.** `Fire` resolves with the submission's outcome as well as delivering it:
   `done`, or `unanswered` with its reason. `tick` does not wait for it, so one slow turn holds no other task back.
2. **On `model_error`, try again later**: after 5 minutes, then 15, then 60, at most three times. The task keeps
   `retry_at` and `retries` in its record, so a retry survives a restart. A retry fires the same prompt with
   `(another try: at <time> the model could not be reached)` after it, so the agent and the Inbox can tell.
3. **Only model errors**: a turn that ran and failed some other way, or was stopped by the person, is not tried again.
   A slot that comes due while a retry is waiting replaces it, so one task never has two runs open.
4. **A one-time task** is still `done` once it fires; a retry is part of that firing, not a new one.
5. The three tries and their times are constants beside `Schedules` (`RETRY_AFTER_MINUTES`).

## Tests

1. History: an error message with `errorMessage` is one event row; four in a row fold to one with `(4 tries)`; an
   error followed by an answer shows only the answer.
2. Live and history give the same rows for the same entries (`test/thread-model.test.ts`'s every-source test gains an
   error).
3. The row is not in what the model is sent.
4. Schedules, with an injected clock and fire:
   1. An outcome of `model_error` sets `retry_at` 5 minutes on, and the next ticks fire at 5, 15 and 60, then stop.
   2. `done`, or another reason, sets no retry.
   3. A retry survives a reload of the file.
   4. A slot that comes due replaces a waiting retry.
   5. A retry's prompt says it is another try.

## Manual

1. The chat part: a turn that could not reach the model says so in the chat, with the provider's message.
2. The schedule part: a scheduled run that could not reach the model tries again after 5, 15 and 60 minutes.

## Open

1. A retry could also wait for the network to come back instead of a fixed time. The fixed times are simpler, and an
   hour covers a Mac waking from sleep.
