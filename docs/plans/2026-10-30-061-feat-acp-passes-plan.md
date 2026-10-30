---
title: Reflection, Learn and the memory review on an ACP agent when no loki model is reachable
date: 2026-10-30
status: active
---

# Reflection, Learn and the memory review on an ACP agent

## Why

The passes (reflection, Learn, `/doctor`; `daemon/passes.ts`) run in a hidden chat on the agent's own loki model.
Plan 020 (KD6) chose that over hidden ACP sessions: with no provider set up, `canRun` says no and the agent's passes
are skipped, quietly and for good. A person who talks to their agents only through Claude Code or Cursor therefore
gets no memory changes from reflection, no Learn cards and no memory review, though every transcript is there to read.

What made KD6 the safer choice then has changed: plan 044 serves loki's tools to an ACP session over MCP
(`daemon/acp/loki-tools.ts`), so an ACP agent can now call `memory_write` and the rest as loki's engine does.

## What changes

1. **Only as a fallback.** A pass runs on loki's engine as today whenever `canRun` says the agent's model is reachable.
   When it is not, the pass runs on an ACP agent instead of being skipped. An agent with a loki model never changes.
2. **Which ACP agent and model.** The one the agent's newest ACP chat runs on (`ChatInfo.engine`: agent and
   model), so the pass uses an engine the person already signs in to and pays for. An agent with no ACP chat either
   is skipped, as today.
3. **Its own hidden chat per job.** `reflection-<agent>-acp`, `recall-<agent>-acp` and `doctor-<agent>-acp`: the
   job's prefix stays, so memory, telemetry and the mod still know them, and an engine is fixed at a chat's first
   message (plan 020, KD4), so the loki-engine pass chat cannot be reused. Hidden, cleared before each run, as now.
4. **Only the job's tools.** The session gets loki's MCP server limited to the job's tools (reflection's and the
   doctor's memory tools; none for Learn): `LokiTools.serverFor` takes the tool list. The agent's own tools are kept
   from doing anything: every permission request in a pass chat is denied without a card, no other MCP server is
   passed, and the session runs in the agent's memory folder, so a tool that reads without asking can only read
   what the pass is about.
5. **The instructions.** The job's instructions go as the appended system prompt where the agent takes one (Claude
   Code), else at the head of the prompt, as `live.preamble` already does for chats.
6. **Reading the answer.** Learn's answer is the turn's text, as now. Reflection counts its writes from the calls
   loki's MCP server ran for that chat, not from tool names in the transcript, since an ACP agent names a call by
   its own title (`mcp__loki__memory_write`, or a sentence).
7. **The same limits.** The run timeout (10 minutes), the queue (one pass at a time), Learn's daily cap and the
   failure back-off apply unchanged. What the run costs lands in the usage ledger under the pass, as an ACP chat's
   turns do.
8. **Said where it shows.** A pass's report and its telemetry name the engine it ran on; Preferences › Learn and the
   manual say that passes use the agent's ACP agent when it has no loki model.

## Decisions for review

1. **On by default, with a switch** (decided 2026-10-30). Without it, an ACP-only person's passes never run; with it,
   they spend some of the person's Claude Code or Cursor allowance. Agents › Reflection has a switch to turn it off;
   the passes are small (one turn per quiet chat, Learn capped per day).
2. **Fallback only, not a choice per agent.** Picking an engine for passes per agent is more to learn for one person;
   it can come later if a loki model is reachable but the person would rather use Claude Code.
3. **This reverses plan 020's KD6** ("over hidden ACP sessions"). The reason it gave, no way for an ACP agent to write
   loki's memory, no longer holds.

## Tests

1. With `canRun` false and an ACP chat on record, a reflection run goes to the ACP chats with the job's instructions,
   only the memory tools on loki's server, the memory folder as the session's folder, and its writes counted from
   the server's calls; a Learn run parses the turn's text into cards.
2. With `canRun` true the pass runs on loki's engine, unchanged; with neither, it is skipped.
3. A permission request in a pass chat is denied and makes no approval card.
4. The fake ACP agent (`test/fixtures`) stands in for Claude Code; no real agent, network or home.

## Checked by hand

A throwaway daemon with no provider and Claude Code signed in: after a chat goes quiet, reflection writes to memory
and Learn makes a card, both shown as run on Claude Code.
