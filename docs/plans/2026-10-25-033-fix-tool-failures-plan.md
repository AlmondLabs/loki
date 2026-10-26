---
title: Reflection learns from failed tool calls, and failures say why
date: 2026-10-25
status: active
---

# Reflection learns from failed tool calls, and failures say why

## Why

In one long-used agent's store, the share of tool calls that fail went from about 1% in its oldest entries to 4–6% in
its newest. Most failures are in pi's `bash` tool (367 of 4,313 calls). Read by their error text:

1. **The agent repeats a wrong guess about the Mac**, about 130 times:
   1. `python` was called 40 times, but macOS has only `python3`.
   2. 26 times a Python package was missing.
   3. 63 times a file was not where the agent thought.
2. **Signed-out tools**: 18 expired AWS SSO sign-ins.
3. **Short timeouts**: 21 commands hit a limit the agent set itself.
4. **Ordinary non-zero exits**, about 190: `grep` finding nothing, a failing test, a wrong CLI flag.

Reflection runs often (83 memory commits since 2026-10-11), yet the memory holds no lesson about any of these. It
cannot:

1. **It never sees a tool call.** A pass's material is `formatTranscript` (`mod/recall-worker.ts:67`), which keeps
   only the "you:" and agent lines. A `python: command not found` reaches reflection only if the agent mentioned it in
   its reply.
2. **It is told to drop them.** Its instructions (`daemon/reflection.ts:13`, plan 018) say to leave out "which command
   failed, what was tried along the way". One failure in one chat is one-off, but the same failure in twenty chats is
   a habit, and reflection is never shown the twenty.

loki should not grow a fixed "about this machine" section in the prompt. Reflection is how an agent gets better: it
should see its mistakes and keep what recurs, in notes the agent reads when they apply. This plan does that, and
builds on plan 034, which makes memory a small core plus described topic notes.

Separately, helpers (the Agent tool) and background passes end "unanswered" and loki says only that, though
pi-durable records why. In `events.jsonl`, 22 of the 27 failed turns are `model_error`. pi-durable keeps the
provider's message in the submission's `detail`, and loki drops it (`daemon/subagents.ts:45`,
`daemon/passes.ts:455`, `daemon/chat-events.ts:10`).

## What changes

### 1. Reflection sees failed calls

**This reverses part of plan 018 on purpose:** reflection was kept to what was said, and told to leave failed
commands out.

1. **Its material** gets a line for each failed tool call, in place in the conversation, after the agent's words
   around it:
   1. Format: `[failed bash: <the command, first 200 chars> → <the error's last line, 200 chars>]`.
   2. When the next call of the same tool succeeds, one more line follows, `[then bash worked: <command>]`, so
      reflection sees the fix as well as the mistake.
   3. The error is the last line before pi's own `<harness>` note (which only says "Command exited with code 127"),
      plus the note when it says more, such as a timeout. It is read from the whole result when the result comes back
      and kept on the step as `error` (`core/harness.ts`): a quarter of the failures measured are longer than the 4,000
      characters a step keeps, and the cut drops the end, where the error is.
   4. Successful calls stay out. Learn's material is unchanged.
   5. The lines count against the same `MAX_MATERIAL_CHARS`. The text is built in `daemon/passes.ts`, as an option to
      `formatTranscript`, not a second formatter.
2. **Its instructions** keep the bar (durable, not one-off) and say what makes a failure durable:
   1. The same mistake in more than one conversation of the batch.
   2. Or a fact about this Mac and its tools that will still be true tomorrow: a command that does not exist and what
      to use instead, where a file lives, the right flag of a CLI.
   3. Lessons go in topic notes outside `system/`, each with a `description:` that says when to read it (plan 034),
      for example `gotchas/commands.md — commands and tools on this Mac: python3, uv, where files live`. Only a rule
      that every chat needs goes in the core, within its 12 KB.
   4. A failure that memory cannot prevent (a provider error, a slow service) is not a lesson. An expired sign-in is
      a lesson only as "ask the person to renew it, do not retry".
3. **No new prompt section.** What the agent knows about its Mac is what it has learned there, in its own memory.

### 2. A failure says why

1. **Helpers**: `daemon/subagents.ts` returns the reason and pi-durable's `detail` (the provider's message, cut to
   300 characters). The agent that asked can then wait, retry or carry on without it.
2. **Passes**: `daemon/passes.ts` puts the same in its error, so `daemon.log` says why a reflection failed.
3. **Chats**: when a message goes unanswered with a `detail`, the chat's error line adds it after the hint it shows
   now (`daemon/chat-events.ts`).
4. **Telemetry stays as it is.** `error_code` already says `model_error`, and a provider's message can quote the
   prompt, so it stays out of `events.jsonl`.

## How we know it worked

`turn_finished` already counts `tool_calls` and `tool_failures` per turn. Compare the share for the two weeks before
and after this lands, and check the memory for notes that came from failed calls.

## Tests

1. Reflection's material: a failed call shows as one line in place, a following success of the same tool shows its
   `then … worked` line, successful calls stay out, and long commands and errors are cut.
2. Learn's material is unchanged for the same rows.
3. A batch whose material with failure lines is over the limit is cut the same way it is now.
4. A helper whose child ends `unanswered` with `model_error` and a detail returns both, cut to the limit.
5. A pass that ends the same way throws an error naming both.
6. `chat-events`: an unanswered submission with a detail shows it; without one, the line is as it is now.

## Manual

The memory part of `docs/manual.md` says that reflection also reads the agent's failed tool calls, and keeps what
recurs.

## Open

1. The memory review (`/doctor`, `daemon/doctor.ts`) is told to remove "which command failed, what was tried along
   the way" as one-off. Once reflection keeps lessons from failed calls, that line must spare a lesson that recurs, or
   a review deletes what reflection learned. This plan changes both together.
2. Some skills tell the agent to run `python script.py` (about 20 files across its skills and memory). Reflection
   cannot change the global skills, so a lesson in memory may conflict with a skill's own instructions until those
   files are fixed.
