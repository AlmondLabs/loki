---
title: A smaller system prompt — memory and skills loaded when needed
date: 2026-10-25
status: draft
---

# A smaller system prompt — memory and skills loaded when needed

## Why

The system prompt of a chat with the most-used agent is about 35k tokens before tool definitions, and it goes with
every model call, helpers and passes included:

| Section | Size        | What loads                                                                         |
| ------- | ----------- | ---------------------------------------------------------------------------------- |
| memory  | ~26k tokens | every note under `system/` in full (15 notes, 94 KB), and the path of 155 others   |
| skills  | ~4.6k       | each skill's name and whole description                                            |
| project | ~4k         | the folder's AGENTS.md or CLAUDE.md                                                |
| mcp     | ~150        | server names; their tools load through `mcp_search`                                |

MCP servers already work the way the rest should: a short list, with details only when asked for. Memory does not.
`memorySection` (`daemon/memory.ts:60`) puts every `system/` note in full, so the core grows with each project's
gotchas and conventions. Most of the 155 listed paths are files of the agent's own skills (`skills/…`), which the
skills section already names.

The notes already have what is needed: all 55 of this agent's notes outside `skills/` start with a `description:`
line in front matter.

## What changes

### 1. The core is small, the rest is a described list

1. **Core**: `system/` notes in full, as now, within a budget of **12 KB** (`CORE_BUDGET`). Nothing is cut. When the
   core is over budget, loki says so to reflection (below), not to the chat.
2. **The rest**: each note outside `system/` is listed by path with its `description:`, cut at a word to 200
   characters, for example
   `- gotchas/commands.md — commands and tools on this Mac: python3, uv, where files live`. A note without one is
   listed with its first heading, or by path alone.
3. **Skills files are not listed** in memory: anything under `skills/` is already in the skills section.
4. The same for every agent, and for Claude Code chats (`memorySection(…, "files")`), which list full paths.

### 2. Reflection keeps the core within budget

1. **The prompt says when.** When the core is over 12 KB, reflection's prompt (`daemon/reflection.ts`) adds one
   paragraph: the core's size, the budget, and its biggest notes. Reflection then moves what is not needed in every
   chat into topic notes outside `system/`, each with a `description:`, and leaves at most a line in the core.
2. **The instructions say what belongs in the core**: who the agent is, who the person is and how they like to work,
   and rules that apply to any task. A project's or a tool's conventions and gotchas are topic notes.
3. **It starts with what is there.** The first reflection after this lands sees the core is over budget and starts
   moving notes. A large core may take a few runs. Each run's changes are commits by Reflection in the memory repo, so
   any move can be seen and undone.
4. **Notes it writes or edits get a `description:`** when they lack one: one line saying when the note is worth
   reading.

### 3. Skill descriptions are shorter in the list

The skills section (`daemon/skills.ts:56`, and `daemon/acp/prompt.ts` for Claude Code chats) shows each description
cut at a word to 200 characters. Not at the first sentence: on the measured agent that drops the "use when…" part from 22 of the 31 descriptions that have one, against 7 for the plain cut. The whole text still comes with the Skill tool.

## What it saves

Measured on the same agent. The list of notes, with each description cut to 200 characters like a skill's, comes to
about 10 KB: one note's description alone is a 14 KB line. Until reflection moves notes, the memory section stays
about the size it was (104 KB). Once the core is within 12 KB, it is about 22 KB, roughly 5.5k tokens instead of 26k.
The skills list goes from 18.5 KB to 10.4 KB. About 35k tokens becomes about 11k.

## Risks

1. **The agent may not read a note it needed.** The description is what it decides by, so reflection is told to
   write it as when-to-read, not as a title. Plan 033 shows the effect: a failure that comes back after its lesson was
   filed means a description is not doing its work.
2. **A move loses something.** Reflection moves text rather than rewriting it, and every move is a commit.

## Tests

1. `memorySection`: `system/` notes in full; other notes listed with their description; `skills/` files left out; a
   note without front matter listed by path.
2. The core's size is reported over the budget and not under it.
3. Reflection's prompt has the over-budget paragraph, with the biggest notes, only when the core is over.
4. Skill descriptions in the list: cut at a word to 200 characters; a short one is left whole.
5. The same for the `files` form (Claude Code chats).

## Manual

The memory part of `docs/manual.md`: the core notes (`system/`) are in every chat and kept to 12 KB by reflection;
other notes are listed with their description and read when needed.
