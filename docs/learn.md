# Learn: how the card writer, leads and lessons work

The manual says what every key does. This is the mental model: what the Learn section is trying to do, what
runs when, and what it costs. Internally everything here is still called "recall": the worker, the frames,
the folder `~/.letta/loki/recall/`. The section was renamed Learn on 2026-09-12.

## The idea in one paragraph

You talk to your agents all day and most of what you learn in those conversations is gone by the weekend.
Learn keeps two kinds of thing out of them. **Cards**: one fact each, asked back on a spaced-repetition
schedule until it sticks. **Leads**: concepts that went by without being understood, each one click from a
**lesson**, a conversation of its own in which the agent that was there teaches the thing properly. Nothing
about any of this happens in chat. A background worker reads, a model writes, and you meet the results in the
Learn section and nowhere else.

## The three things

1. **A card** is a question that stands alone, an answer that fits on a line or two, a few tags, and a
   pointer to the conversation it came from. Cards live in `recall/cards/<id>.json`; their review history
   lives apart in `recall/schedule/<id>.json`, so the writer's edits never touch your schedule.
2. **A lead** is a title, one line quoting the moment it came up, and a depth: a primer you can take in one
   sitting, or a course of several. Leads live in `recall/leads/`; the ones you declined in
   `recall/leads-dismissed/`.
3. **A lesson** is a conversation titled `[Learn] · <title>`, owned by the agent that was in the room, opened
   with a brief written on your behalf. Lessons are desks in the sidebar and never inbox cards: a lesson is
   precisely the thing that can wait. The record is in `recall/lessons/`.

## The loop

```text
conversation goes quiet ──► the writer sweeps ──► cards ──► you review ──► again / got it ──► FSRS reschedules
                                    │                │
                                    │                └─► you delete ──► the deleted pile ──► the writer reads it
                                    │                └─► you keep failing ──► a replay of the source ──► a rewrite
                                    └───────────► leads ──► start ──► a [Learn] lesson ──► its own cards, later
```

The only signals you give are the two answers, the delete key, and start or not this on a lead. Everything
else is inferred.

## The writer

### When it runs

- Ninety seconds after the mod activates, then on a timer: **sweep every N minutes**, ten by default, in
  Settings › learn. "Run now" fires it by hand. A sweep already running is reused, never doubled.
- A conversation is read only once it has been **quiet for ten minutes**, whatever the interval, so the writer
  never reads a thought half-finished.
- The writer is **off by default**. It spends your provider budget in the background, so it never starts until
  you switch it on. The first visit to Learn explains this and offers the switch.

### What it reads

- Every conversation in the inbox list except its own, newest first. Each has a **cursor**: the transcript
  line the writer has read up to. It reads from the cursor to the end.
- Less than 300 new characters is chatter: the cursor moves, nothing is asked.
- Each new stretch gets a **score** in plain code, no model: length with diminishing returns, your share of the
  words, and how many questions you asked. A stretch you wrote half of beats one the agent monologued.
- Stretches are grouped by agent and **packed** by score into one call per agent, up to 48k characters and
  eight stretches. What does not fit waits, its cursor unmoved, for a later sweep.
- Cards you keep failing bring the last 4k characters of their source conversation along as a marked
  **replay**. A replay is for the rewrite only; nothing new is written from it.

### What it asks

- One **hidden conversation per agent**, named "recall", for the life of the agent. It is a desk in the sidebar
  (and in ⌘K search) so you can read what was asked and what came back, but it stays out of the inbox and the writer never
  reads it for cards.
- The prompt carries the stretches, labelled so answers can say which one they came from; the existing cards
  whose wording overlaps them, eighty at most; up to forty deleted cards as examples of what not to write; the
  failing cards; the open, started and dismissed lead titles; and the room left for cards and leads today.
- The conversation's working directory is the recall folder itself, so the model's read-only tools can grep
  the rest of the deck before writing. The prompt names the folder and the deck's size rather than quoting
  every card, so it stops growing with the deck.
- After each answer the writer runs `/compact all` on that conversation, so the next ask starts from a short
  summary rather than every transcript ever sent. Letta's project settings in that folder keep the dreaming
  pass off: the writer's digests of your conversations must never become the agent's memory.
- If the ask fails, the cursors stay where they were and the same stretch is retried next sweep.

### What it writes

- **New cards**, up to the day's room. **Cards a day** (twenty-five by default) caps the deck, not the reading:
  once reached, the card cursor waits for tomorrow while a second cursor keeps reading for leads. A front too
  close to an existing or deleted card is dropped.
- **Revisions** to existing cards, when a later conversation corrected or sharpened one. Reading the stretches
  side by side, the model writes one card for a fact that came up twice and a revision, not a second card,
  for a correction.
- **Leads**, up to two per conversation, while the open pile is under twelve. A title near an open, started or
  dismissed lead is the same lead again and is dropped.
- A one-line note, shown in Settings and on the all-cards strip: "3 new · 1 revised · 2 leads from 5
  conversations in 2 asks", or "nothing worth a card", or "nothing new".

### What it costs, and the levers

Every ask is one model turn plus one compaction turn, and each carries the agent's whole fixed prompt, which
is its system prompt, its memory folder and its tools, on top of up to 48k characters of stretches. Three
levers, in order of effect:

1. **The agent's memory size.** This is most of every ask. An agent whose `memory/system` folder has grown to
   tens of thousands of tokens pays that on every sweep, every compaction and every turn of every lesson.
   Letta's `/doctor` and `letta memory tokens` measure it; moving bulk from `system/` to `reference/` cuts it.
2. **Sweep every N minutes.** Fewer sweeps mean fewer, larger asks and later cards. The quiet threshold does
   not change.
3. **Cards a day.** Caps the deck. Reading and leads continue past it, so it saves little on its own.

## Reviewing

- The queue puts **new cards first**, marked, because the first sight of a card is also the moment to throw it
  out. Then what is due, oldest first.
- Two answers: **← again** and **→ got it** (1 and 2 too; space, ↵ or ↓ shows the answer and then means got it;
  either arrow reveals the answer first).
  Each answer reschedules the card with **FSRS**, the scheduler modern Anki uses.
- **Deleting a card (X or ⌫) is the feedback.** It moves to the deleted pile the writer reads before writing, so a
  rejected card never comes back reworded. A card deleted after many failed reviews reads as badly written,
  one deleted unseen as not wanted. Z undoes.
- A card you keep failing is offered back to the writer with a replay of its source, for a rewrite in place.
- E edits a card yourself; O (⌘O) opens the desk it came from; ⌘[ and ⌘] step through the four views (Review,
  Leads, All cards, Deleted); "export for Anki", on All cards, copies the deck in Anki's plain-text import format.

## Leads and lessons

- Leads come out of the same call as cards, so they cost nothing extra and inherit the writer's switch. They
  sit in the **Leads** view of Learn's sidebar, newest first, twelve open at most. Nothing badges the rail for
  them.
- **Start** creates the `[Learn] · <title>` conversation for the agent that was there, puts an info card with
  the lead on its desk, opens the desk on Messages, and sends the brief as your first message: open with why
  this matters to you, furnish the desk with the outline as a list you can tick, ask before telling, one idea
  at a time, a cold quiz at the end. The brief is a user message, sent only on your click, the way the board's
  dispatch posts a task. A lesson whose brief never arrived is listed under "lessons under way" with
  **send the brief**.
- **Not this** moves the lead to the dismissed pile, which the writer reads before proposing again. Restore is
  in the **Deleted** view, beside the deleted cards.
- Decided and kept: leads only, never auto-started; the agent who was there teaches; lessons stay out of the
  inbox. The writer reads a lesson like any other conversation, so the cards that keep a lesson fresh come out
  of the lesson itself. That is the loop closing: conversation, lead, lesson, cards, recall.

## What it deliberately does not do

- It never posts in chat, never badges the inbox, never starts a lesson on its own.
- It never reads its own conversations, and the dreaming pass never reads them either.
- It never writes a card the deleted pile already covers, and never touches your schedule.
- The phone has the review deck only (the answers, delete and undo); the leads, the writer's switch and its knobs
  stay on the Mac.

## Files

```text
~/.letta/loki/recall/
  worker.json               enabled, model, dailyCap, tickMinutes, written today, cursors, leadCursors,
                            recallConversations, writers, last run and its note
  cards/<id>.json           front, back, tags, source, history of the writer's edits
  schedule/<id>.json        FSRS state and review log, kept apart from the card
  rejected/<id>.json        the deleted pile: the card and how many reviews it had
  leads/  leads-dismissed/  lessons/
  .letta/settings.local.json   reflectionTrigger off, for the writer's conversations
```

## Where the code is

- `mod/recall-worker.ts`: the sweep, scoring, packing, the hidden conversation, compaction.
- `core/recall/extract.ts`: the prompt and the parser, as pure text in and out.
- `core/recall/model.ts` and `core/recall/fsrs.ts`: the types, the review queue, FSRS.
- `mod/recall.ts`: the store, one JSON file per thing.
- `mod/bridge.ts`: the `recall_*` frames the section speaks to the mod.
- `app/src/recall/`: the section, its list of views (`LearnColumn.tsx`, `views.ts`), the deck, the leads view,
  the worker strip. Settings › learn is in `app/src/settings/Settings.tsx`; the phone's deck is
  `app/src/phone/Recall.tsx`.
- Plans: `docs/plans/2026-09-12-008-feat-loki-learn-plan.md` for leads and lessons.
