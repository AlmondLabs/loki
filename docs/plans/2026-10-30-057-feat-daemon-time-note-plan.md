---
title: Messages loki starts itself carry the time
date: 2026-10-30
status: active
---

# Messages loki starts itself carry the time

## Why

An agent has no clock. loki tells it the time in a hidden note on the person's messages (`environmentNote`,
`core/attention/content.ts`): the full note on a chat's first message, then the time again after 30 minutes, on a new
day or in another time zone. The note is added by the app as a message goes out, so only messages the person sends
carry it.

Messages that loki starts itself carry none:

1. a scheduled task's prompt (`daemon/schedule.ts`)
2. a background task's notice (`daemon/background.ts`)
3. the reflection, learn and doctor passes (`daemon/passes.ts`)

In those turns the agent knows only the time of the last note the person sent. A chat quiet for days, woken by a
schedule, believes it is still the day it was last spoken to; a pass reviewing a chat has no "now" to date what it
writes.

## What changes

1. **`daemonTimeReminder(now)`** in `core/attention/content.ts`: a system reminder with the Mac's local time, worded
   as the person's note is, saying it comes from the Mac running loki.
2. **`DaemonChats.deliver` appends it** to every message it delivers, schedules and notices alike, on both engines.
3. **A pass's prompt has it appended** before it is submitted.
4. **Always, not throttled.** These messages are few (a schedule's slot, a task ending, a pass a day), so each carries
   the time; the person's 30-minute rule exists because they write often.
5. **Appended after the text,** never before: the Inbox tells a schedule's turn by its prompt beginning "Scheduled
   task" (`isScheduledPrompt`), and a notice is read as an event from its own block. The thread already strips system
   reminders, so the person never sees it.

## Tests

1. A delivered message reaches the model with the Mac's time after its text, from an injected clock.
2. A scheduled prompt with the note still reads as scheduled.
3. A pass's prompt reaches the model with the note.
