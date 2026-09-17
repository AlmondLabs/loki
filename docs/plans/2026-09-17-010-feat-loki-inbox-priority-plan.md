# loki · the inbox as a scheduler's ready queue (2026-09-17)

Raised 2026-09-16: "the more active conversations that I have, the more number of items I seem to have in my
inbox. This has now gotten overwhelming … Can we come up with a better algorithm to manage this chaos.
Remember, one of the main goal here is also to improve the cache utilisation of the llm api calls." Then,
after two rounds of simplifying: "Thinking about this from the lens of process queues in operating system —
a main queue that holds up all the cards, a queue that holds the cards that are visibility hidden (deferred
for later). The following events update the queues: a user action on the top card (approval or rejection,
an input), a turn finish on any of the conversations, a turn blocked for permissions. On each of these
events the priority order should be computed." → "go ahead".

## What the numbers said (2026-09-16, this Mac)

1. **The inbox is the person's own fan-out coming back.** 42 conversations listed, 17 cards waiting, 15 of
   them one agent's topic threads, 14 arrived within the day, 3 of them a cron's Slack digest; 26 snoozes
   on file, one card deferred seven times. Every card ranked equal to every other.
2. **Cache writes are the bill.** Of ~11,700 requests since August 21, 83 % of prompt tokens were cache
   reads, yet at the provider's prices cache *writes* were about 72 % of prompt spend, and 95 % of written
   tokens came from full rewrites of a conversation (~375k tokens each; 430 of them since September 10,
   about 55 a day). Two thirds were returns to a conversation after its five-minute cache had expired; the
   rest followed compaction, memory edits and model switches.
3. **A longer cache TTL does not help.** Letta can ask for the one-hour cache (`PI_CACHE_RETENTION=long`);
   modelled on the same traffic it costs 3 % more, because every incremental write then costs double.
4. **The arithmetic of a burst.** Five turns in one conversation spread over a day are five rewrites; the
   same five inside ten minutes are one rewrite and four small writes — about a quarter of the tokens.
   Cards handled one per pass, hours apart, are the most expensive way to run a conversation.

## The shape

The deck was already a ready queue with a wait queue beside it: `catchUpQueue` is what can be acted on,
snoozes hide cards until a timer or a content change brings them back, and `mergeQueue` folds live items
into an open pass on every event. What it lacked was a priority. This adds one number and changes what a
reply does.

1. **One score, one list, no bands** (`core/attention/priority.ts`):
   `blocked ? 100 : 0` (an approval, a question, a failed turn) `+ warm ? 10 : 0` (the agent spoke under four
   minutes ago, so the provider still has the prompt cached) `+ yours ? 5 : 0` (the turn answers a message a
   person sent, not a scheduled prompt) `− 0.1 · hours since the last message`. Blocked agents dwarf
   everything; warm replies to you come next, because answering one costs a tenth of answering it cold;
   then colder replies; then reports nobody asked for. The age term only settles ties and lets old cards
   drift down. Nothing ages upward. `buildItems` orders by it, so the desktop deck, the phone deck and the
   rail count all see the same list.
2. **Yours vs a report.** The mod's digest now records the last message a person or a schedule sent
   (`lastAsk: { at, scheduled }`), reading the log backwards past the agent's last words to the last human
   text; Letta's scheduler always opens with `Scheduled task "…" is firing.`, which is the whole test. The
   live stream sets the same field from `user_message` deltas. Cron digests therefore rank as reports without
   loki reading the cron file.
3. **The events.** A user action on the head (approve, deny, reply, answer, seen, later), a turn finished
   anywhere, a turn blocked on a permission or a question — all already flow through `applyEvent` →
   `buildItems` → `mergeQueue`. Two more: the **clock tick** (the 30-second timer that already expires
   snoozes now also feeds `now` into the score, so warmth fades without any other event) and **you spoke
   elsewhere** (typing into a conversation from its desk removes its card through the seen marker, as before).
4. **No preemption of the head.** `mergeQueue` keeps index 0 where it is and orders everything behind it by
   score on every event. A permission request that arrives while you read lands next, not on top of you.
5. **Recompute at dequeue too.** `popHead` drops the head and orders the rest by score at that moment: the
   next card's warmth may have changed while you read the last one.
6. **A reply keeps the card** (restored 2026-09-17). The first cut made a reply a state transition — the card
   left the ready queue the way a process leaves for I/O and came back by score when the turn finished. That
   reversed a design the user had made on purpose ("I had designed for that to be an explicit ⌘] action. Why
   did that digress?"), and it was not needed for the burst: staying on the card, the answer streams in where
   you are and the follow-up goes out warm with no re-ordering at all. So: a reply or an answer keeps the card
   current; moving on is ⌘] as before; and if you do move on, the merge places the returning card by score —
   warm and yours — behind whatever you are reading then. The record is kept here so the reversal is not retried.
7. **The word.** Each card carries the largest term of its score after the time: `warm` (brass), `reply to
   you`, `report`; blocked cards say it with their badge. The phone's footer carries the same word.
8. **Unchanged.** The wait queue (snooze tiers, the content stamp that voids a deferral, the daily reset), the
   keys, the seen markers, the state file, the badge count (every card in the ready queue).

## Decisions

- **No bands, no pins, no demotions, no focus set.** Each was proposed and dropped for confusion or scope:
  "I want this to be simpler. I dont want the bands." The score's four terms are constants anyone can read.
- **The wait queue stays a timer.** "Later" keeps its Anki backoff; the user framed deferral as visibility,
  not as a lower priority. A card that wakes re-enters at its natural score.
- **Warm is four minutes, not five.** The provider's cache lives five minutes from its last use; the fourth
  minute is for reading the card and typing.
- **Age never lifts a card, except a blocked one** (2026-09-17, on "how will you manage cards with the same
  score"). Operating systems age priorities to prevent starvation; here starving a report is the point. But
  among blocked cards the sign flips: the agent that has waited longest comes first, since a stopped agent
  is the one case where waiting makes a card more urgent. Ties otherwise fall to a stable sort — newest first
  in the list, already-queued before newly-arrived in an open deck — and are near-impossible anyway, the age
  term being continuous to the millisecond.
- **Replies record no decision.** A decision keeps a conversation out until its stamp changes; the turn that
  answers a reply always changes the stamp, and undoing a sent message is not a thing.

## Files

- `core/attention/priority.ts` (new): the score, `reasonOf`, `byPriority`, `isScheduledPrompt`, `LastAsk`.
- `core/attention/model.ts`: `lastAsk` on Digest, Live and AttentionItem; `buildItems(…, now)` orders by score.
- `core/attention/queue.ts`: `popHead`; `mergeQueue` orders the tail by score. `useAttention.ts` feeds the clock.
- `app/src/desk/useDeckActions.ts`: `answer` (the structured form, through the same path as a typed reply); `CatchUp.tsx`,
  `CatchUpParts.tsx` (the word), `app/src/phone/Inbox.tsx` (the word).
- `mod/desks.ts`: the digest's `lastAsk`.
- Tests: `test/priority.test.ts` (new), `queue.test.ts`, `attention-model.test.ts`, `desks.test.ts`.
- `docs/manual.md`, `README.md`.

## Follow-up (2026-09-17): the ladder becomes two knobs

"Can this be made configurable like 1 number (x) and the steps are x^n. Default x can be 10." The old steps
(5m · 15m · 45m · 2h · 6h · 1d) were already geometric, about ×3 each; 10ⁿ minutes is too steep (the third
deferral hides a card for most of a day, the fourth for a week — with the daily reset only two steps would ever
run), and one base ties the first step to the growth. Chosen: two knobs, **first** (minutes, default 10) and
**growth** (default 3), steps = first · growth^(n−1), capped at a day: 10m · 30m · 1h30 · 4h30 · 13h30 · 1d.
`core/attention/ladder.ts` holds the ladder, its ranges (1–1440 minutes, ×1–×10) and the labels; the mod keeps
the setting in `state/attention.json` beside the markers (`SeenStore.ladder`/`setLadder`), the `seen` frame
carries it, `snooze_ladder { firstMinutes?, growth? }` sets it, and Settings gains an **inbox** page: the order's
terms, and the two fields with the resulting ladder shown. The phone defers by the same ladder.

