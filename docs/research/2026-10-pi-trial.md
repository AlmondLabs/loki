# Pi trial: the daemon against Letta

Plan 017, U2. Run 2026-10-10 on a Mac with `scripts/trial.ts`.

## Verdict

**R1 is met. The port continues.** With the same model, provider and prompts, the pi-durable daemon beat Letta on all three measures the gate names:

| Median across 23 turns | Letta | Daemon | Change |
|---|---|---|---|
| Time to first token | 2,651 ms | 1,375 ms | 48% less |
| Harness overhead per turn | 101 ms | 7 ms | 93% less |
| Gap from a tool result to the next model request | 23 ms | 1 ms | 96% less |
| Whole turn | 4,197 ms | 3,307 ms | 21% less |

None of the 46 turns failed. The daemon's event loop stayed responsive while three chats streamed at once: its 99th-percentile delay was 8.3 ms, well under the 50 ms threshold in U2. Each agent's store therefore stays on the main thread, which settles Open Question 1 of the plan.

## Setup

1. **Model:** OpenRouter's `~anthropic/claude-haiku-latest` on both backends, using the same key. Letta's model catalogue predates Haiku 5.5's exact id, so both used the alias.
2. **Letta:** Letta Code's app-server on the Mac, with hidden conversations on the agent `friday`, archived after the run. Permission mode was Letta's default, unrestricted.
3. **Daemon:** `daemon/kernel` on pi-durable 1.1.0, with in-memory storage and pi-durable's coding tools.
   - Instructions: `friday`'s own compiled system prompt (about 109 KB), so both sent the model the same instructions.
   - Approvals: none.
4. **Prompts**, each run five times in a fresh conversation:
   1. a one-sentence question with no tools;
   2. three dependent shell commands;
   3. three file reads;
   4. a question over a 70 KB document.

   Then the first prompt ran in three chats at once.
5. **What each measure means** (`daemon/timing.ts`):
   - **Time to first token:** from the send to the first streamed word, thought or tool call reaching the client.
   - **Harness overhead:** the turn, minus the time the model or a tool was working.
   - **Gap after a tool:** from a tool's result to the start of the next model request.

## By prompt

| Prompt | Letta first token | Daemon first token | Letta overhead | Daemon overhead | Letta whole turn | Daemon whole turn |
|---|---|---|---|---|---|---|
| Plain question | 1,802 | 1,300 | 80 | 3 | 2,326 | 1,633 |
| Three dependent commands | 3,127 | 1,293 | 147 | 15 | 7,645 | 5,606 |
| Three reads | 2,651 | 1,346 | 112 | 7 | 4,197 | 3,134 |
| Long document | 2,804 | 1,448 | 82 | 2 | 4,826 | 3,652 |
| Three chats at once | 2,867 | 1,461 | 1,361 | 15 | 3,358 | 6,462 |

All times are medians in milliseconds.

## What the numbers do and do not show

1. **The harness numbers are the clean comparison.** Overhead and the gap after a tool are time the model plays no part in. The daemon spends about 7 ms per turn where Letta spends about 100 ms, and about 1 ms after each tool where Letta spends about 23 ms.
2. **Part of the first-token gain is a smaller request, not a faster harness.** The daemon offered the model four tools; Letta offers its whole tool set. Fewer tool definitions mean a shorter prompt. Expect some of the 1.3 s gain to shrink as the daemon gains its own tools (plan units U10–U12). The overhead and post-tool numbers are unaffected by this.
3. **Letta queued concurrent chats.** With three chats at once, Letta waited a median 1,355 ms before the first request left; the daemon waited 6 ms.
4. **The three-at-once rows are not like for like.** In this run the daemon's three chats ran the three-command prompt, and Letta's ran the plain question, so the whole-turn times in that row cannot be compared; the waits before the first request can. `scripts/trial.ts` now uses the same prompt for both.
5. **Prompt-cache retention was not compared.** The plan asked for `short` and `long` to be tried. This run used pi-ai's default, `short`, so Open Question 3 is still open for U8.
6. **One model, one machine, five runs.** The medians are clear, but this is a small sample on one provider route.
