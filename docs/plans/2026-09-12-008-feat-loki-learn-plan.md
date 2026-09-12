# loki · learning as its own lane: leads, lessons, the loop back to recall (2026-09-12)

Raised 2026-09-12: "A lot of times, some new concepts are discussed in regular conversation. A dedicated
process (or shared with the recall process) could identify the areas that the human could learn more about
and start dedicated [Learn] - {title} conversations with the user. The Learn conversations do not become a
part of the inbox but can stay in the desk." → "go ahead" on the plan and the first slice.

## The shape

Two of loki's ideas already carry most of this. The recall writer reads quiet conversations for what is
worth keeping; a desk is a directory an agent furnishes. A lesson is a desk with a syllabus on it.

1. **Finding.** The writer, in the call it already makes, is asked one more thing: name the concepts the
   person met but did not have to understand. Signals: they asked "what is X", the agent explained at
   length, an acronym went by unquestioned, "I'll take your word for it". Each is a **lead**: a title, one
   line quoting the moment, a depth (a primer in one sitting, or a course of several), and the source
   desk. Same call, so no extra spend; it inherits the writer's off-by-default switch.
2. **Leads** land quietly in Recall as a tab beside review and all cards. Nothing badges the rail. A lead
   is a card with **start** and **not this**. "Not this" goes to a dismissed pile the writer reads before
   proposing again, the way deleted cards already work.
3. **Start** creates the conversation `[Learn] · <title>`, owned by the agent that was in the room, and
   sends one message on the person's behalf, the brief: what to teach, where it came up, how to teach it
   (furnish the desk with an outline first; ask before telling; one idea at a time; quiz cold at the end).
   The desk opens with the chat.
4. **Living with it.** Learn conversations are desks in the tree and never inbox cards: a lesson is
   precisely the thing that can wait. Later: their own tree group with a progress mark from the ticks on
   the outline; sessions scheduled the way cards are, so Recall's header says "1 lesson due".
5. **Closing.** The outline ticked, the agent asks two or three questions cold; if they land, the lesson
   is archived to a "learned" shelf and the agent commits a line to the person's memory. The writer reads
   the Learn conversation like any other, so the cards that keep it fresh come out of the lesson. That is
   the loop: conversation → lead → lesson → cards → recall.

## Decisions

- **Leads only, by default.** The writer proposes; the person starts. A second switch, "start lessons on
  its own", is not in the first cut and may never be.
- **The agent who was there teaches.** It knows the context and the person. A tutor persona is a later
  option; a `human/learning.md` memory file for how the person likes to be taught is the cheaper first step.
- **Recall keeps its name for now.** Renaming the section to Learn (review, lessons, leads as tabs) is the
  right end state and a separate, visible change; the tab lands first.
- **The brief is a user message.** Sent on the explicit click of "start", as the board's dispatch already
  posts tasks. It is visible in the transcript; it is what the person asked for.
- **The lesson's folder is the home directory**, like the recall conversation's. Lessons are about a
  concept, not a checkout; the agent can still read anything the brief points it at.

## Data (under ~/.letta/loki/recall/)

```text
leads/<id>.json            { id, title, why, depth: "primer"|"course", source: CardSource, createdAt }
leads-dismissed/<id>.json  { lead, at }                       the writer's negative examples
lessons/<id>.json          { lead, agentId, conversationId, startedAt }
```

The snapshot the section holds (`RecallSnapshot`) gains `leads`, `dismissedLeads`, `lessons`. A Learn
conversation is recognised by its title prefix (`core/recall/model.ts`: `LEARN_PREFIX`, `isLearnTitle`).
`inbox_list` in the mod skips those titles; the tree lists them as any desk.

## The writer's prompt (core/recall/extract.ts)

After the card rules, one more block: "Also name up to two things the person could learn properly …
title in a few words, `why` quoting the moment in one line, `depth` primer or course. Skip what the
existing leads, lessons and dismissed leads already name." The answer JSON gains `"leads":[…]`. The
worker writes at most two leads per conversation and holds the open pile at twelve; a lead whose title
is near an existing lead, lesson or dismissed lead is dropped (`similarFront` on titles).

## Frames (mod/bridge.ts)

- `recall_lead_dismiss {id}` / `recall_lead_restore {id}` → `recall` snapshot
- `recall_lead_start {id}` → the mod creates `[Learn] · <title>` for the lead's agent through the
  app-server, sends the brief, records the lesson, replies `recall_lesson {agentId, conversationId}`;
  the app opens that desk with the chat.

## Slices

1. **This one.** Leads in the writer's call; the store; the frames; the leads tab with start / not this /
   open the source; dismissed leads under "deleted" with restore; Learn titles out of the inbox; the brief.
2. A "learning" group in the desks tree with the progress mark; `[Learn]` stripped from the row title.
3. Sessions on the FSRS schedule; "n lessons due" in Recall's header; the learned shelf; the memory line.
4. The phone: leads read-only, lessons list; start stays on the Mac (no `recall_lead_start` in PHONE_FRAMES).
5. Rename the section to Learn once the tabs make the old name wrong.
