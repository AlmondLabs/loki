# Learn: how the card writer, leads and lessons work

The manual says what every key does. This is the mental model: what the Learn section is trying to do, what
runs when, and what it costs. Internally everything here is still called "recall": the frames, the writer's
chats, the folder `~/.loki/recall/`. The section was renamed Learn on 2026-09-12.

## The idea in one paragraph

You talk to your agents all day and most of what you learn in those conversations is gone by the weekend.
Learn keeps two kinds of thing out of them. **Cards**: one concept, principle or piece of lasting knowledge
each, asked back on a spaced-repetition schedule until it sticks. **Leads**: concepts that went by without being understood, each one click from a
**lesson**, a conversation of its own in which the agent that was there teaches the thing properly. Nothing
about any of this happens in chat. A background pass reads, the agent writes, and you meet the results in the
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
conversation goes quiet ──► the writer reads ──► cards  ──► you review ──► again / got it ──► FSRS reschedules
                                    │                │
                                    │                └─► you delete ──► the deleted pile ──► the writer reads it
                                    │                └─► you keep failing ──► a replay of the source ──► a rewrite
                                    └───────────► leads ──► start ──► a [Learn] lesson ──► its own cards, later
```

The only signals you give are the two answers, the delete key, and start or not this on a lead. Everything
else is inferred.

## The writer

The writer is one of the daemon's two **background passes** (`daemon/passes.ts`, plan 018); reflection, which
keeps each agent's memory, is the other. Both work the same way and differ only in what they are for: the same
trigger, the same cursors, the same hidden chat run as the agent itself, one run at a time.

### When it runs

- Once a minute the daemon looks over your chats. A conversation is read once it has been **quiet for half an
  hour** and holds new text since the writer last read it, so the writer never reads a thought half-finished.
- "Run now", in the Learn section or Settings › learn, reads every conversation with something new at once,
  whether or not it is quiet.
- The writer is **off by default**. It spends your provider budget in the background, so it never starts until
  you switch it on. The first visit to Learn explains this and offers the switch.

### What it reads

- One conversation per run. Each has a **cursor**: the entry the writer has read up to. It reads from the
  cursor to the end, at most the newest 24k characters.
- Less than 300 new characters is chatter: the cursor moves, nothing is asked.
- Cards you keep failing bring the last 4k characters of their source conversation along as a marked
  **replay**, five at most. A replay is for the rewrite only; nothing new is written from it.

### What it asks

- It asks the agent itself, in one **hidden conversation per agent** (`recall-<agent>`), cleared before each
  run and with no tools: it answers, and loki writes the files. The conversation stays out of the sidebar, the
  inbox and reflection.
- The prompt says what is worth a card: a concept or principle you met, or knowledge of your field that will
  still be true in a few months. And what never is: a one-off detail of the task at hand, passing state, how the
  agent did its work, what you plainly already knew. Most stretches of work hold nothing worth a card, and zero
  is the usual answer.
- It carries the stretch; the existing cards whose wording overlaps it, eighty at most; up to forty deleted cards
  as examples of what not to write; the failing cards; the open, started and dismissed lead titles; and the room
  left for cards and leads today.
- If the ask fails, the cursor stays where it was and the same stretch is tried again after another half hour.

### What it writes

- **New cards**, up to the day's room. **Cards a day** (five by default) is a ceiling, not a target: once it is
  reached, the writer reads nothing more until tomorrow, and a stretch that had more cards than room waits with
  its cursor unmoved. A front too close to an existing or deleted card is dropped.
- **Revisions** to existing cards, when a conversation corrected or sharpened one, or to a failing card.
- **Leads**, up to two per conversation, while the open pile is under twelve. A title near an open, started or
  dismissed lead is the same lead again and is dropped.
- A one-line note, shown in Settings and on the all-cards strip: "1 new · 1 lead from "KMS keys"", or
  "nothing worth a card".

### What it costs, and the levers

Every run is one model turn as the agent, carrying the agent's whole fixed prompt (its system prompt and memory)
on top of up to 24k characters of the stretch. Each run is measured (`npm run analytics`, the background passes
section). Two levers:

1. **The agent's memory size.** This is most of every ask. An agent whose `memory/system` folder has grown to
   tens of thousands of tokens pays that on every run and every turn of every lesson; moving bulk from `system/`
   to `reference/` cuts it.
2. **Cards a day.** Once reached, nothing more is read that day.

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
- It never reads its own conversations, and reflection never reads them either.
- It never writes a card the deleted pile already covers, and never touches your schedule.
- The phone has the review deck only (the answers, delete and undo); the leads, the writer's switch and its knobs
  stay on the Mac.

## Files

```text
~/.loki/recall/
  cards/<id>.json           front, back, tags, source, history of the writer's edits
  schedule/<id>.json        FSRS state and review log, kept apart from the card
  rejected/<id>.json        the deleted pile: the card and how many reviews it had
  leads/  leads-dismissed/  lessons/
  worker.json               from before the background passes: read only for the writer's old hidden chats
~/.loki/state/
  passes.json               reflection and Learn on or off, Learn's cards a day
  pass-cursors.json         each pass's cursor in each chat, cards written today, Learn's last run and its note
```

## Where the code is

- `daemon/passes.ts`: the background passes' runner: when a chat is read, the cursors, the hidden chat, one run at
  a time. `daemon/learn.ts`: the writer as a pass, from the stretch to the files.
- `mod/recall-worker.ts`: what the writer and lessons share: Learn's own chats, the transcript as read, the
  cards worth quoting, starting a lesson.
- `core/recall/extract.ts`: the prompt and the parser, as pure text in and out.
- `core/recall/model.ts` and `core/recall/fsrs.ts`: the types, the review queue, FSRS.
- `mod/recall.ts`: the store, one JSON file per thing.
- `mod/frames/recall.ts`: the `recall_*` frames the section speaks to the mod (declared in `core/frames.ts`).
- `app/src/recall/`: the section, its list of views (`LearnColumn.tsx`, `views.ts`), the deck, the leads view,
  the worker strip. Settings › learn is in `app/src/settings/Settings.tsx`; the phone's deck is
  `app/src/phone/Recall.tsx`.
- Plans: `docs/plans/2026-09-12-008-feat-loki-learn-plan.md` for leads and lessons;
  `docs/plans/2026-10-10-018-refactor-loki-background-passes-plan.md` for the background passes.
