# Plan: the review findings that keep coming back

2026-11-14

## Why

Four design reviews ran between 2026-11-12 and 2026-11-14 (`.impeccable/critique/`), and one on 2026-09-08
(`docs/research/2026-09-08-ui-review.md`). Most of what they found was fixed between runs: the Slack layout, red for
attention, the chat's toolbar, the New Chat sheet, the thread's grammar, the red approval panel. Six findings were
raised in three or more of them and are still on screen today. A finding that survives three reviews is not waiting
for a better idea; it is waiting for someone to decide. This note takes each one, says where it comes from in the
code, and picks a fix.

Today's review (19/40) also found new problems: launch opening on a placeholder chat, ⌘[ ⌘] meaning four things,
VoiceOver reading tooltips, one toolbar per pane, the sidebar emptying in Flow and Canvas. They are left for a plan of
their own, except where a fix here covers them.

## 1. Flow: a move that fails looks like nothing happened

Raised 2026-11-12 (seven decisions on one card), 2026-11-13 (no list), 2026-11-14 (a dead end on a card whose
account needs a sign-in).

**What happens now.** A move pops the card at once and re-orders the deck (`desk/deck-moves.ts`, `decide`). When the
write-back out there is refused, `restore` puts the card back on top and `say` flashes the reason, "not put off: the
reason", in the card header's grey meta line for `FLASH_MS`, 900 ms (`desk/use-deck-actions.ts:11`,
`desk/catch-up-parts.tsx:351`). The same 900 ms that says "read" carries the refusal. To the person the card blinks
and stays: nothing happened. A card whose account has lost its sign-in refuses every move, so Later never gets past
it. On top of that, the card states the sign-in problem twice in red ("Gmail wants a new sign-in…" and "could not read
the whole thread: … sign in again") with no button, and the finishing move changes place with the source: Archive for
a chat or an email, Mark as Read for Slack and Jira (`item/action-bar.tsx`, R13).

**Options.**

1. **Refusals become notices; a card that cannot move says why, once, with the fix.** A refused move goes to `notify`
   (the window's notices, four seconds, in a sentence: "Couldn't put this off. Gmail needs you to sign in again.") with
   **Sign In…** as its action where the reason is a sign-in. The flash stays for the words that confirm ("Read",
   "Later"). A card whose source needs a sign-in draws one line in place of its two red ones, "Gmail needs you to sign
   in again", with **Sign In…**, and Later on it passes the card for this visit without writing back, so the deck
   always moves. (Built: the card's line keeps the account's own words, `disconnectedText`, beside the button, which
   reads Add Token… for Jira and Connect Again… after an admin's block; Sign In… opens Preferences › Accounts.)
2. **Option 1, and the deck becomes Mail's list with a reading pane**, so a stuck card is one row among others and
   ↓ always reaches the next. This answers 2026-11-13's "no list", but it is a redesign of Flow, not a fix.
3. **Only lengthen the flash.** Smallest, and still a grey word in a header.

**Pick: 1.** It ends the dead end and the doubled red without reopening what Flow is. Option 2 gets its own plan if
the person wants it (question 1). The finishing move keeps its source-dependent place (R13: Slack and Jira finish on
read, mail and chats on archive); the review read it as inconsistency, but it follows what "done" means for each
source. Instead, the finishing button's tooltip says what it finishes ("Archive: done with this thread").

Where: `desk/deck-moves.ts` (refusals to a `notice` host method), `desk/use-deck-actions.ts`, `desk/outside-card.tsx`
and `item/outside-rows.tsx` (the one sign-in line), `mod/` for a refusal that carries its kind (`sign_in`) rather
than only words. Tests: `deck-moves` with a fake host, a refused later on a sign-in card advances the deck.

## 2. Learn opens with an essay

Raised 2026-11-12, 2026-11-13, 2026-11-14.

**What happens now.** `RecallIntro` (`recall/recall-parts.tsx:288`) is a card of about 230 words in three
paragraphs, ending in a blue outlined button, "turn the writer on". The phone shows the same (`phone/learn.tsx`).

**Pick.** Apple's welcome sheet: a title, three rows of a symbol, a bold line and one sentence, and one filled
button.

- **Learn** — "Flashcards from your chats, when you want them."
- *Cards from what you discuss* — "After a chat has been quiet for half an hour, the agent writes cards for what will
  still be true in months."
- *Reviewed when you'd forget* — "Cards you know come back less often; the ones you miss come back sooner."
- *Uses your model* — "Up to {daily_cap} cards a day, from your provider budget. Nothing runs while no chat has
  anything new."
- **Turn On Learn** (filled), with **Learn More…** opening the rest (leads, the files under `~/.loki/recall/`,
  deleting a card as feedback, turning it off in Preferences › Learn).

"The writer" leaves the screen: the person turns on Learn, not a writer. The phone takes the same rows at its sizes.
`docs/manual.md`'s Learn part changes its words to match.

## 3. Words that are not Apple's

Raised 2026-11-12 (mixed case in one turn), 2026-11-13 (lowercase controls), 2026-11-14 (lowercase status lines,
sentence-case buttons, raw ids).

**What happens now.** `docs/style.md` §6 already says controls take title case and everything else is a sentence,
and `Button` capitalises a label's first letter (`kit/words.ts`). That catches "turn the writer on" → "Turn the writer
on", which is still not title case. Status lines and empty states are not buttons, so nothing touches them:
"loading the thread…" and "nothing here yet — …" (`chat/conversation.tsx`, `item/timeline.tsx`), "Nothing on this
canvas yet." Raw ids reach the screen: `acp:demo/default` on an agent's profile, a widget folder with its uuid on an
empty canvas.

**Pick: a pass, and a test so it stays done.**

- The pass: every control in title case with Apple's verbs ("Add Provider…", "Show Code", "Delete Agent…"); every
  status line a sentence with a capital ("Loading…"); empty states as Apple writes them, a title with no period and
  one line ("No Widgets", "Widgets the agent adds appear here."); ids behind a "Details" disclosure.
- The test: `test/words.test.ts` reads the JSX text and the `title`, `label`, `placeholder` and `aria-label` string
  props under `app/src`, and fails one that starts with a lowercase letter, except loki's own name, a key, and code.
  Button labels are held to title case by a small list of words that stay lowercase (a, an, and, as, at, by, for, in,
  of, on, or, the, to). `capitalFirst` on buttons then goes, since a label is written right.

## 4. The agent's work is several lines, not one

Raised 2026-11-12 ("Used Read signups.csv", the plan repeating), 2026-11-14 ("Thought / Used a tool / Thought").

**What happens now.** A turn draws a `Thought` line before every stretch of work and before every message that carries
a thought (`item/timeline.tsx:155-169`), and a stretch ends at any message or non-work event (`toolRuns`,
`shared/tool-steps.ts:179`). A turn that thinks, reads, thinks and answers is three quiet lines before the answer,
where design.md promises one ("Worked 14 min · …").

**Pick.** Everything between two of the agent's messages is one Work line, its thoughts included: `Thought` stops
drawing its own line inside a turn, and its text becomes a step in the Work list ("Thought for 12 seconds", opening
to the thought), in order with the tools. A turn with thoughts and no tools still shows "Thought for 12 seconds"
alone. The step's label is the verb and its object ("Read signups.csv"), never "Used" before a verb.

Where: `item/timeline.tsx`, `item/work.tsx`, `item/thought.tsx`, `item/entries.ts` (`thoughtsIntoWork`) and
`shared/tool-steps.ts`. The phone's thread draws no thoughts, so it has nothing to change. Tests: `item-work` for a
think, read, think, answer turn, and `tool-steps` for the one-step line.

## 5. Keys that act without a modifier, and one key bound twice

Raised 2026-11-13 (⌘⇧D twice, a bare "a" approves), 2026-11-14 (also a bare Return approves a step, bare 1–4 send a
quick reply).

**What happens now** (`shell/keymap.ts`):

- ⌘⇧D is Show / Hide Sidebar anywhere (line 60) and Deny in Flow (line 140), which wins there. In Mail it is Send.
- In the chat's box, Return when the box is empty allows the step that waits (`chat.allow-empty`), and 1–4 send a
  quick reply (`chat.reply`, `chat/quick-replies.tsx:18`). Both act from a text field with no modifier.
- Quick-reply buttons print their key on their face (`chat/quick-replies.tsx`), against style.md §6.
- In Flow, single letters (a, d, e, l, o, r) act when the box does not have focus. That is Gmail's habit, not Mail's,
  but it never fires while typing.

**Pick.**

- Show / Hide Sidebar moves to ⌃⌘S, the Mac's own key for it. ⌘⇧D stays Deny in Flow only.
- Allowing from the box takes ⌘Return, as Flow's Approve already does. A bare Return in an empty box does nothing.
- Quick replies keep 1–4 only while one of them has focus, not in the box; their keys go to the tooltip.
- Flow's single letters stay: they never fire while typing, and they are what a Flow visit is built on.
- A test in `test/keymap.test.ts` fails any key bound in two scopes that can be active at the same time.

The menu bar, the keys sheet and `docs/manual.md`'s keys list change with it.

## 6. Grey text that is too faint

Raised 2026-11-13 (row time 4.0:1, monograms 2.6:1), 2026-11-14 (4.1:1, 3.8:1).

**What happens now.** `--loki-muted` (#aeaeb2 at night) passes on the ground and the panel, but a list row's time and
preview sit on the selected row's fill, measured at #49494b, where it is 4.1:1. The monogram's white initial sits on a
gradient from `--loki-monogram-top` #8e8e93, 3.3:1 at its lightest.

**Pick.**

- A selected row draws its secondary text in `--loki-fg` at the meta size, as Mail does for the selected message, so
  nothing new is needed. No opacity on text (design.md).
- The monogram's gradient moves a step darker on both sides so the white initial is at least 4.5:1 at the top, night
  and day.
- `test/tokens.test.ts` gains both pairs: muted text is never drawn on `--loki-selection`, and `--loki-on-monogram` on
  `--loki-monogram-top` is AA.

## Not in this plan

Today's new findings, for a plan of their own: what launch opens on, ⌘[ ⌘] as Back and Forward, accessible names that
match the visible label, one toolbar on every pane, lanes in the sidebar, the sidebar kept in Canvas and narrow
windows, and the phone's places and type sizes beside iOS's. Also the doubled "Chats" heading and "Update Available"
at the sidebar's foot (2026-11-13, 2026-11-14), which belong with the sidebar work there.

## Order

Smallest and most certain first:

1. Contrast (6).
2. Keys (5).
3. Words (3), with the test, then Learn's welcome (2) on top of it.
4. Work line (4).
5. Flow refusals (1).

## Decided

By the person, 2026-11-14:

1. Flow: pick 1 now. Mail's list with a reading pane (option 2) is wanted, later, in a plan of its own.
2. The finishing move keeps its place by source.
3. ⌘Return allows from the box; no bare Return or digits in it.
4. Learn's three rows and **Turn On Learn** as written.
5. The order above, but all six land in one PR, a commit each.
