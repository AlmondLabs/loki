---
title: Chat Labels - Plan
type: feat
date: 2026-10-17
topic: chat-labels
execution: code
---

# Chat Labels - Plan

## Goal

- **Objective:** The person can put labels on chats (`infra`, `billing`, `client-x`) to find and group related
  chats across agents. A chat can carry several; each label has a colour; clicking one shows its chats.
- **Why now:** the sidebar groups chats by agent and filters by title or agent name. A topic that spans agents, or
  many chats with one agent, has no way to be gathered.
- **Execution profile:** One branch per unit, each from `main` after the one before has merged, each its own PR with
  every check run on CI's toolchain.

## Decisions

All user-directed, 2026-10-17, in the brainstorm.

- **KD1. Labels are topics.** Free-form words that stay until removed, for finding and grouping related chats; no
  status semantics. (Chosen over workflow labels such as "waiting", and over both.)
- **KD2. Chips and a filter; the sidebar keeps its grouping.** Rows show their labels as chips; clicking a chip, or
  typing `label:infra` in the sidebar's filter, filters to that label. The per-agent sections stay. (Chosen over a
  group-by-label switch, and over label sections replacing the agent ones.)
- **KD3. Only the person sets labels.** Agents see them (in the chat's details) but have no tool to set them.
  (Chosen over agents suggesting labels, and over a `label_chat` tool.)
- **KD4. Colours are automatic and changeable.** A new label takes the next colour from a short palette on the
  design scales; the picker and Settings › labels change it. (Chosen over picking a colour each time, and over no
  colours.)

## Requirements

- R1. The **labels…** picker: a popover with the existing labels as a checklist, filtered as you type; Enter on a
  new word creates it. It opens from the sidebar row's menu, the chat's title menu, and `/label <name>` (which adds
  that label, creating it if needed; `/label` alone opens the picker). On the phone, from the chat's action sheet,
  as a sheet.
- R2. A label is lowercase, letters, digits and dashes, at most 32 characters (typed words are made so: "Client X" →
  `client-x`). A chat carries at most 8.
- R3. Chips: the sidebar row shows up to two after the title, then "+N"; the chat header shows all; Inbox cards show
  them. Each chip is the label's colour as a dot or tint with its name, legible in both themes.
- R4. Clicking a chip filters the sidebar to that label (the filter field shows `label:<name>`, clearable like any
  filter); `label:a label:b` matches chats with both; a plain word still matches titles and agent names.
- R5. ⌘K finds labels by name; choosing one opens the sidebar filtered to it.
- R6. Settings › **labels**: every label with its colour and how many chats carry it; rename (applied to every chat),
  recolour, delete (removed from every chat, after a confirm naming the count).
- R7. Labels survive restarts and travel with the chat (archive and restore keep them); the phone sees the same.
- R8. Words on screen follow docs/style.md §6; the manual describes labels; **Label** in the glossary.

## Scope Boundaries

- Not in scope: labels set by agents (KD3); grouping the sidebar by label (KD2); labels on tasks or agents; a
  label's own page.
- Not changed: pins (`mod/pins.ts`), the per-agent sidebar sections, archive.

## Mechanism

- **On the chat.** `ChatInfo` (`daemon/kernel/index.ts`) gains `labels?: string[]`, saved in the chat's own
  document like its title, so archive, restore and the projection carry them. `chat_update` takes `labels`;
  `LocalConversationInfo` and `DeskSummary` carry them to the app and the phone.
- **The colours.** `~/.loki/state/labels.json` maps a label to a colour index (KD4); a label not in it gets the next
  free index when first used. Frames: `chat_labels_get` (every label, colour and count, counted from the projection)
  and `chat_label_set` (rename, recolour, delete across chats).
- **The app.** A `LabelPicker` (combobox over a checklist) shared by the row menu, the title menu and the phone
  sheet; `LabelChips` for the row, the header and Inbox cards; the sidebar filter (`sidebar-model.ts`) parses
  `label:` terms; `/label` in loki's commands; ⌘K's search model gains label results; Settings › labels.
- **Agents see them.** The chat's labels go in what the agent is told about the chat it is in (its context line),
  read-only.

## Built

Units 1 to 3 landed as #105, #107 and the Settings › labels PR, each from `main`.

- **As planned:** labels on the chat's own document (`ChatInfo.labels`), colours in `state/labels.json` (a new label
  takes the colour the fewest have), `chat_labels_get` / `chat_label_set`, the `label:` filter, ⌘K's Labels group,
  `/label`, Settings › labels, and **Label** in the glossary.
- **Changed while building:**
  - Chats have no title menu (the header's only menu is the widgets'; rename, pin and archive live in the row
    menu by design), so the header has chips and a quiet **+ label** button instead (R1).
  - A sidebar row shows its labels as coloured dots, not two chips: with chips the title was cut to a few letters
    in the sidebar's width. The header and Inbox cards keep full chips (R3). A row is a button, so its dots are
    not; a chip click filters in the header and ⌘K.
  - The phone's Inbox shows chips on its top card only; the cards behind sit under a veil.
  - In the picker, ↵ takes the first matching label and makes a new one only when none matches; a click on the
    Create row still makes it.
  - The agent learns a chat's labels through the environment note the app adds to a message (its first, and again
    when the labels change), beside the chat's name, rather than a line on the daemon's side.
- **Found while building:** the mod's `list_desks` built each desk summary field by field and dropped `labels`, so
  saved labels never reached the sidebar or header (unit 2, by hand). Unit 1's macOS CI also turned up a race in
  the mod folder's watcher, fixed on its own in #106.
- **Not checked by eye:** the phone's labels sheet and card chips (no paired phone); they share the desktop's
  components.

## Units

1. **Labels on chats** (`daemon/kernel`, `daemon/chats.ts`, `daemon/chat-backend.ts`, `core/frames.ts`,
   `mod/desks.ts`, tests): the field, `chat_update`, the colours file, `chat_labels_get` / `chat_label_set`, the
   desk summaries; normalising names (R2); rename and delete across chats.
2. **Picker, chips and filter** (`app/src/shell/`, `app/src/chat/`, phone, `core/attention/commands.ts`, tests): the
   picker from the row menu, title menu, `/label` and the phone sheet; chips on rows, header and Inbox cards; the
   `label:` filter and chip clicks; ⌘K results. Screenshots desktop and phone, light and dark.
3. **Settings and docs** (`app/src/settings/`, `docs/manual.md`, `glossary.md`, the agent's context line): Settings ›
   labels (R6), the manual, the glossary, labels in what the agent sees.

## Verification

- Each unit's tests plus the full checks on CI's toolchain, Windows included; React Doctor no worse than `main`.
- By hand in the browser pane against a scratch daemon: label chats with several agents, filter by chip and by
  `label:`, find a label in ⌘K, rename and delete one in Settings, archive and restore a labelled chat.
