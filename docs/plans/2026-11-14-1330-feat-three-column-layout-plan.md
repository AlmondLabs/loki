# Plan: one three-column window, as Mail's

2026-11-14

## Why

The page-by-page HIG review of 2026-11-14 (`.impeccable/critique/2026-11-14T13-00-00Z__layout-and-components.md`)
found the window built three different ways:

- **The sidebar does three jobs.**
  - In Chats it holds the places, a lone "+" row, a search field and every chat, grouped under its agent. That is
    three levels: place › agent › chat.
  - Under the places, the sidebar becomes a different list in each place: chats, lanes, agents or Learn's views.
- **Each place lays out its content differently.**
  - Chats: two columns.
  - Agents: three (agents, the memory files, the file).
  - Flow: one card as a box filling the pane, its moves in a bar along the window's bottom edge.
  - Learn: two.

The HIG asks for the opposite on each point:

- **Sidebars:** "show no more than two levels of hierarchy in a sidebar". When the data is deeper, use a split view
  "that includes a content list between the sidebar and detail view".
- **Split views:**
  - persistently highlight the selection in each pane that leads to the detail
  - set sensible minimum and maximum pane widths
  - keep the panes balanced
- **Layout:** keep layout changes recognizable as people move around. Layout › macOS: avoid controls at the bottom of a
  window.
- **Toolbars:** symbols rather than text. New and Search as toolbar items: Notes, Calendar, and search at the toolbar's
  trailing edge.

Mail, Notes and Finder all have this shape: sources, a list, the item. The person asked for this plan on 2026-11-14,
after setting the "Flow as Mail's list with a reading pane" item aside on the same day. That item becomes part of this
plan.

## The shape

```
┌──────────────┬────────────────────────┬──────────────────────────────────────┐
│ ● ● ●   [▤]  │ Friday       [✎] [⌕…] │ Spring timetable    [⌫][⏱][🏷][✓][⇥] │  ← one toolbar band
│              │ 12 chats               │ Maren Tidewell · to you · 15h        │
│ Chats        ├────────────────────────┼──────────────────────────────────────┤
│   Pinned     │ ▌chat row (selected)   │                                      │
│   Friday   2 │  chat row              │   the item: a thread, a Flow card,   │
│   Ira        │  chat row              │   an agent, a Learn card             │
│   Archived   │  …                     │                                      │
│ Flow       6 │                        │                                      │
│   Everything │                        │                                      │
│ Agents       │                        │                                      │
│ Learn      3 │                        │   composer / reply                   │
└──────────────┴────────────────────────┴──────────────────────────────────────┘
  sources: 2 levels      the list               the item (detail)
```

### 1. The sidebar lists sources, two levels deep, the same in every place

- **The places stay** as the top level: Chats, Flow, Agents, Learn, each with its symbol and count.
- **Under each place, its sources**, folded by a trailing disclosure chevron, as the HIG's sidebar image draws it:
  - **Chats:** Pinned, then one row per agent (its face, its count), then Archived.
  - **Flow:** Everything, the person's lanes, one per agent with cards, then New Lane…. These are today's FlowColumn
    rows.
  - **Learn:** Review, Leads, All Cards, Deleted. These are today's LearnColumn rows.
  - **Agents:** none. The agents are the list (section 2), as Contacts lists people.
- **Choosing a source** selects its place and fills the list. The place's own row means "all": every chat, Everything,
  or Review.
- **The sidebar no longer changes under the pointer** when the place changes. Only the selection moves, and each
  place keeps its folds.
- **What leaves the sidebar:**
  - the lone "+" row, which goes to the toolbar (section 4)
  - "Find a chat…", which becomes the list's search (section 4)
  - the chats themselves, which move to the list

### 2. The list: one component, every place

`ContentList` (new, `app/src/shell/content-list.tsx`) is the middle column. Its toolbar is a title over a grey count,
with the place's New and Search at its trailing edge. Its rows are the place's items. It behaves the same in every
place:

- **↑↓ selects and shows** the item in the detail, as Mail does; Return moves focus into the detail.
- **The selection** is persistently highlighted: the accent with white text while the list has focus, grey when it
  doesn't (Focus and selection).
- **Context menus** on every row: the same native menus chat rows have today, extended to Flow, Agents and Learn rows.
- **Width:** 260 to 420, 300 by default, dragged or arrowed on its edge, as the sidebar is today.

What each place lists:

| Place | Source | List rows | Detail |
|---|---|---|---|
| Chats | Pinned, an agent, Archived, or all | Chats, one line each as today: the name, and at the trailing edge the waiting count, live dot, ring or time | The thread, with its Messages and Canvas tabs |
| Flow | A lane | The cards in score order, which is the deck's order today: sender or chat, subject, one line of preview, kind icon (chat, mail, Slack, Jira) | The card: its thread and reply box |
| Agents | none | The agents: face, name, live dot, the last thing said (today's AgentsColumn rows) | The agent, with its pages as a tab view centred in the toolbar |
| Learn | A view | The cards or leads in the view; Review lists the cards due, in order | The card (Review: the review card and its grade buttons) |

### 3. Flow becomes a list with a reading pane, and keeps the deck's keys

The deck is the list's order. Nothing about scoring, resting or the visit changes; only how it is drawn changes.

- **Opening Flow** selects the first card, which is what the deck showed.
- **The moves act on the selected card:** Read (→, ⌘]), Later (←, ⌘[), Archive (E, ⌘E), Label (L), Approve, Deny,
  Reply, Open, and Undo. Each then selects the next card, as archiving in Mail selects the next message, so going
  through Flow with the keyboard feels as it does today.
- **The moves become toolbar symbols** at the detail's trailing edge, leaving the bar along the window's bottom:
  Archive, Later, Label, Mark as Read, Hand Off. Archive is the one prominent item, approval cards show Approve and
  Deny, and each symbol has a tooltip and a menu-bar item.
- **A rested card leaves the list** as it leaves the deck today. "You're caught up" with **go through them** becomes
  the list's empty state, and the visit summary becomes the detail's.
- **The card** loses its box: it is the detail's content, at the thread's readable width (`max-w-3xl`).
- **On the phone, nothing changes:** it keeps its one-card deck and swipes (Tab bars; split views are for regular
  widths).

### 4. One toolbar band across the window

- **The sidebar toggle** stays beside the traffic lights.
- **The list's toolbar:** its title and count lead. New (square and pencil) and Search trail:
  - New is New Chat in Chats and New Agent in Agents; Flow and Learn have none.
  - Search filters the list as "Find a chat…" does today, `label:` included. ⌥⌘F focuses it, as Mail's mailbox
    search does; ⌘F stays find in the transcript.
  - ⌘K stays the window-wide search, and a magnifier at the far trailing edge opens it, as Notes puts search last
    (`search-fields-toolbar-search-mac`).
- **The detail's toolbar:** the item's name over its grey line (today's ToolbarTitle). Then:
  - tab views centred over the detail: Messages | Canvas, and Agents' pages, as Calendar centres Day | Week | Month
    | Year
  - the item's moves trailing, as symbols
- **The update notice** stops floating over the content. A small **Update** button sits at the detail toolbar's
  trailing edge until it is taken or dismissed, and Settings keeps saying it.

### 5. Widths and folding

- **Widths:**
  - Sidebar: 200 to 300, 220 by default.
  - List: 260 to 420, 300 by default.
  - Detail: at least 480.
- **Folding:**
  - **Under 1000 wide**, the sidebar folds on its own first, as Mail's does. The list's title then carries the source
    name, and ⌃⌘S or the toggle peeks the sidebar, as `peek` does today.
  - **Under 760**, the list folds too. The detail fills the window, with a Back button leading in its toolbar, and the
    list comes back over it on Back, or on ⌘↑ outside a text box.
- **Kept across restarts:** the widths and each person-made fold (`loki.desktop.column` gains a `list` entry, and old
  values read as today's sidebar).
- **Canvas** keeps both columns. ⌃⌘S folds the sidebar, and **View › Hide List** (⌃⌘L) folds the list for a wider
  canvas. Both are kept per window.

## Where

- **Layout model:**
  - `shell/column.ts` becomes `shell/columns.ts`: pure, both columns, widths, folds, peek, migration.
  - `shell/use-column.ts`, and `shell/shell.tsx` for the pane's left edge and the second column.
- **Sidebar:**
  - `shell/list-column.tsx` becomes the sidebar's sources body.
  - `shell/desk-sidebar.tsx` splits: its sources (Pinned, agents, Archived) stay in the sidebar, and its rows, filter
    and "Needs you" pill go to the Chats list.
  - `desk/flow-column.tsx` and `recall/learn-column.tsx` become source groups.
  - `agents/agents-column.tsx` becomes the Agents list.
- **List:** `shell/content-list.tsx` (new), plus a pure `shell/list-keys.ts` for selection and arrows, with its test.
- **Flow:**
  - `desk/catch-up*.tsx` and `desk/use-deck-actions.ts`: the selected card, select-next after a move, the empty
    state.
  - `item/action-bar.tsx` becomes toolbar symbols.
  - The deck model and scoring are untouched.
- **Toolbar:** `item/toolbar.tsx` and `components` (PaneHeader) for centred tab views, list toolbars and the Update
  button.
- **Menus:** `keymap.ts` gets View › Hide List, and the Flow moves keep their items.
- **Docs:**
  - `docs/design.md`: Shell is rewritten for three columns.
  - `docs/manual.md`: The window, Flow, Agents and Learn.
- **Tests:**
  - columns (widths, folds, migration)
  - list keys (↑↓ selects, select-next after a move)
  - Flow's select-next for each move and for undo
  - a sidebar that keeps its sources across places

## Delivery

Four PRs, each leaving the app whole:

1. **Columns and the list component:** the layout model, `ContentList`, and Chats moved onto it (the sidebar's
   sources, the list, its search and New in the toolbar).
2. **Flow as list and reading pane:** the moves in the toolbar, select-next, the empty states.
3. **Agents and Learn** on the list, with Agents' pages centred.
4. **Folding below 1000 and 760:** Back, Hide List, and the Update button. Then the docs pass.

Each PR gets screenshots at 1440, 1000 and 760, light and dark, and keyboard runs through Flow before and after.

## Decided

- **Chat rows stay one line**, as today (the person, 2026-11-14). Two lines, as Messages and Mail have, was the
  alternative.

## Decisions for review

1. **Agents have no sources;** the agents are the list. Profile and Reflection are forms in the detail, beside the
   list, as Contacts shows a card beside its list.
2. **The phone keeps its deck** and its own navigation. This plan is the Mac's.
3. **⌘[ ⌘] keep** their meanings in Flow and Learn for now. The Keyboards page lists them as alignment keys, and that
   question stays open on its own.
4. **Canvas keeps the list,** with View › Hide List to fold it. *Alternative: Canvas folds the list on its own and
   brings it back on Messages.*
