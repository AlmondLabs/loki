---
title: What the chat pane shows when - Plan
type: feat
date: 2026-11-12
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# What the chat pane shows when - Plan

Plan 098 · an information pass over the new chat pane (plan 097) and Flow's cards, after the pane's first design
critique (2026-11-12, 24/40) · the person's principle: every piece of information easy to reach, the screen never heavy

---

## Goal Capsule

- **Objective:** the new chat pane and Flow's cards show, by default, only what the person reads or acts on now; every
  other piece is one glance, one hover or one press away, and nothing that was reachable before becomes unreachable.
- **Means:** each element is placed on one of four tiers (R1) and drawn at that tier; this plan lists every element of
  the pane with its tier today and the tier it moves to, and the person agrees each move before it is built.
- **Authority:** this plan's Requirements, then the inventory as the person decides it, then the units.
- **Stop conditions:** stop and ask if (1) a move hides something a keyboard or screen reader user cannot then reach
  (R4); (2) a move undoes an interaction the person designed on purpose and has not said yes to on its own line (the
  ones marked **reversal** below); (3) a move needs data the daemon or mod does not keep.
- **Execution profile:** continues on `feat/shadcn-thread`, behind the "New chat pane (preview)" preference, so today's
  thread is untouched; units in order, each its own commit.

---

## Product Contract

### Summary

The critique found the pane's information right and its amount wrong: a turn could carry a thought line, a plan card, a
work line, a failure named three times, then the answer, and every message a copy icon and a time. Plan 097's critique
fixes cut the repetition. This plan sorts what is left by when the person needs it.

### The four tiers

1. **Always:** what the person reads or must act on now. The words (your messages, the agent's and people's replies),
   anything that needs you (an approval, a question, a proposed reply), the item's title, and the one move that
   finishes the item.
2. **A quiet line:** a summary taken in at a glance, one line, muted, never more than one per turn: "thought 2s ·
   worked 2 min · 3 commands · plan 1 of 3". It names what is behind it.
3. **On hover or focus:** what is reached for now and then: copy, the exact time of a message, the key on a button,
   the secondary chips. Shown when the pointer is over the row or the keyboard is on it.
4. **Opened:** the detail behind a line: each step and its input and output, the plan's entries, the thought, the
   quoted mail, the folded thread.

### Requirements

- R1. Every element the pane draws has one tier, recorded in this plan's inventory; a new element names its tier and
  what it displaces before it is drawn.
- R2. A turn shows at most one quiet line above its words. The thought, the work and the plan are parts of that line,
  each opening to its own detail; a part with nothing to say is left out, not shown empty.
- R3. Anything on tier 3 appears on keyboard focus as on hover, and is in the accessibility tree whether shown or not;
  hiding is visual only (opacity or `sr-only`), never `display: none` for something a screen reader needs.
- R4. Nothing reachable today becomes unreachable: every move, key, time and detail keeps a path no longer than one
  hover or one press from where it is now.
- R5. What needs the person never drops below tier 1: an approval, a question, a failure at a turn's last step, a
  proposed reply, an unread flag.
- R6. The phone is out of scope: it has no hover, and its view is its own (plan 097 left it as is).
- R7. Reduced motion: a tier-3 reveal is an opacity change with no movement, and under reduced motion it is instant.

### Scope Boundaries

- In: the desktop chat pane in the preview, Flow's chat and outside cards in the preview.
- Out: the phone; the chat list and rail (the visual-language plan after 097 covers them); today's thread with the
  preview off; any change to what the daemon or mod keep.

### Success Criteria

- On the demo daemons, the "Signups by week" chat at 1400px shows fewer always-on elements per turn than before
  (counted in U1 and again at the end: text lines, controls and icons visible with nothing hovered).
- The pane's critique, rerun after this plan, scores 3 or more on heuristic 8 (aesthetic and minimalist design) and
  no lower than today on heuristics 6 and 7.
- A keyboard-only walk through a chat and a Flow card reaches every move and detail it reaches today.

---

## The inventory

Each row: the element, where it is today, the tier it moves to, and why. Rows marked **reversal** undo a placement
the person chose earlier and each needs its own yes.

### A turn

| # | Element | Today | Moves to | Why |
|---|---|---|---|---|
| T1 | Agent's name on the turn | always | always | who said it |
| T2 | "worked 2 min" beside the name | always | quiet line | part of the work summary, said once |
| T3 | State badge (working, needs you, failed) | always | always | R5 |
| T4 | Thought line ("thought for 2 seconds") | its own line before each message | part of the quiet line | R2: one line, not three |
| T5 | Plan card | its own card | part of the quiet line ("plan 1 of 3"), opening to the entries; the whole card only while the turn works and the plan changed | the answer should outweigh its scaffolding |
| T6 | Work line ("Ran 3 commands · 1 failed") | its own line | part of the quiet line | R2 |
| T7 | Failed step named under the work line | always when a step failed | always only when the last step failed (R5); else inside the opened work | a failure the agent got past is history |
| T8 | The agent's words | always | always | the point of the turn |
| T9 | "Waiting on you" on the work line | always while paused | stays, as the quiet line's lead | R5, and the proposal above the box holds the answers |

### A message

| # | Element | Today | Moves to | Why |
|---|---|---|---|---|
| M1 | Copy as markdown | 40% until hover | hidden until hover or focus (R3) | reached for now and then |
| M2 | Time on every message | always | hover or focus; the turn's first message and your own keep theirs | the turn header already places it in time |
| M3 | Face and name on a person's message | first of a run | unchanged | Slack's own grouping |
| M4 | Mentions you marker | red stripe | the "mentions you" words in the row, quiet; the stripe uses `--loki-mention-bar` | colour alone is not enough (PRODUCT.md) |
| M5 | Reactions (Slack) | always | unchanged | they are content |

### The header

| # | Element | Today | Moves to | Why |
|---|---|---|---|---|
| H1 | Title | always | always | |
| H2 | Unread, starred, mentions you flags | always while they hold | always | R5 |
| H3 | Agent and its state chip | always | always | which agent, and whether it waits on you |
| H4 | Folder chip | always | hover or focus on the header | used to check, not to read |
| H5 | Labels chips and "+ label" | always | labels stay when set; "+ label" on hover or focus | an empty affordance is noise until wanted |
| H6 | "in focus" and the card's meta words | always | hover or focus | explains the ranking, rarely needed |

### Under the box

| # | Element | Today | Moves to | Why |
|---|---|---|---|---|
| A1 | The finishing move (archive, or read) | always, filled | always | the one move |
| A2 | Secondary moves (later, read, open, label, hand off) | always, quiet | always, quiet, at most three; a fourth and more go in a "more" menu | ≤4 choices at a decision point |
| A3 | Key on each button | always | hover or focus on the bar, and always while the keyboard is driving (the last input was a key) | **reversal** of plan 097 KTD9, which shows keys on the buttons |
| A4 | Flow's keys line under the card | always | removed when A3 lands: the keys show on the buttons | said twice today |

### The box

| # | Element | Today | Moves to | Why |
|---|---|---|---|---|
| B1 | The box and send | always | always | |
| B2 | Model and effort pill, mode chip | always | quiet until the box has focus or text; always when not the default | set once, read rarely |
| B3 | "+" and the mic | always | unchanged | small, and where they are expected |
| B4 | Queued messages with take back | above the box | unchanged | they need you while the turn runs |
| B5 | Quick replies (1, 2) | above the box | unchanged | they are the decision |

### Proposals

| # | Element | Today | Moves to | Why |
|---|---|---|---|---|
| P1 | Approval: tool, its input, approve, always allow, deny | always | tool and a one-line input always; the whole input opened | a long input buries the buttons |
| P2 | "always allow" | a button beside approve | **reversal** to decide: keep, or move behind approve's menu with a "just this chat" choice | a permanent grant one click from approve (critique question 3) |
| P3 | "the agent is paused on this step" | always | removed: the "needs you" badge and the card say it | said twice |

### Flow's cards

| # | Element | Today | Moves to | Why |
|---|---|---|---|---|
| F1 | A chat card's whole excerpt (thoughts, plan, work, words) | as the pane | as the pane after this plan | one vocabulary |
| F2 | Deck header ("2 need you · 4 chats") | always | unchanged | where you are |
| F3 | Gmail quoted text and earlier mails | folded | unchanged, and a folded mail folds back | already tier 4; fixes the one-way fold |

---

## Planning Contract

### Key Technical Decisions

- KTD1. One reveal mechanism: a `group/row` (or `group/bar`) on the container and `opacity-0
  group-hover/row:opacity-100 group-focus-within/row:opacity-100` on the tier-3 element, as the copy button already
  does. No JavaScript, no layout shift: the element keeps its space.
- KTD2. "The keyboard is driving" (A3) is one flag on the document, set by the last input being a key and cleared by
  the pointer, read by CSS through a data attribute; Flow's deck already tracks focus and keys and is the place to own it.
- KTD3. The quiet line (R2) is one component, `TurnSummary`, in `app/src/item/`: it takes the turn's parts and draws the
  line; each part is a button that opens its own detail below the line, one open at a time. Work, Plan and Thought keep
  their opened views unchanged.
- KTD4. Visual hiding only (R3). An element on tier 3 stays in the DOM and the accessibility tree.

### Risks

- Hover-revealed controls are slower to find for a first-timer. Mitigation: R3's focus reveal, and the finishing move
  and the decisions never hide (R5).
- Merging three lines into one can make the line long at 900px. Mitigation: parts drop from the right (plan, then
  thought) into the opened view when the line would wrap; tested at 900px.

---

## Implementation Units

### U1. Count, and the reveal

Count the always-on elements per turn on the demo (the Success Criteria's baseline), add KTD1's reveal classes as a
small shared pattern, and move M1 and M2.

### U2. The turn's quiet line

`TurnSummary` (KTD3): T2, T4, T5, T6, T7, T9. Tests: a turn with all three parts draws one line; a part with nothing
is left out; the last-step failure stays always; each part opens its own detail.

### U3. The header

H4, H5, H6 on the reveal. Tests: the folder and "+ label" are in the markup and hidden until hover or focus.

### U4. Under the box, and the box

A2's "more" menu past three; B2's quiet pill. A3 and A4 only if the person says yes to the reversal.

### U5. Proposals and Flow

P1's folded input, P3; P2 only if the person decides it; F3's fold back; M4's words and bar colour.

### U6. Docs

`docs/design.md` gets the four tiers as a rule and the inventory's outcome; `docs/manual.md`'s "New chat pane
(preview)" section says where each thing went.

---

## Verification Contract

- Every unit: the checks in AGENTS.md, and the demo daemons rendered at 1400px and 900px, day and night, with nothing
  hovered, then hovered, then walked by keyboard.
- End: the always-on count against U1's baseline, a rerun of the pane's critique, and a keyboard-only walk (Success
  Criteria).

---

## Open Questions (the person's)

1. A3: keys on hover or focus, and always while the keyboard drives, in place of always on the buttons (plan 073
   KTD9)? And A4, dropping Flow's keys line once they do?
2. P2: keep "always allow" beside approve, or move it behind approve with a "just this chat" choice?
3. T5: while a turn works and its plan changes, show the whole plan card, or keep it in the quiet line even then?
4. M2: hide the time on every message except the turn's first and your own, or keep times always?
5. Any row in the inventory that should stay where it is?
