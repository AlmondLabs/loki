# loki shell: sidebar, tree, left chat, inbox — plan of record

Decided 2026-09-06 with Deepak. Now that loki is a Tauri app with every shortcut to
itself, the window gets a proper shell instead of two modes bolted onto a canvas.

## Shape

    ┌──────────────────────────────────────────────────────────────────────────┐
    │ ● ● ●                     cost control                                   │  native title bar (desk name / Inbox · n / Settings)
    ├────┬─────────────────────────────────────────────────────────────────────┤
    │ ▣  │ ┌──────────────────┐                                                │
    │    │ │ chat             │       the sheet runs edge to edge under it     │
    │ ✉3 │ │                  │                                                │
    │    │ │                  │                                                │
    │ ⚙  │ ├──────────────────┤                                                │
    │    │ │ › message ira  ⏎ │                                                │
    │    │ └──────────────────┘                                                │
    └────┴─────────────────────────────────────────────────────────────────────┘

- **Sidebar** (48 px, under the native title bar): three segments — desk, inbox, settings. The inbox
  icon carries the waiting count, the same number the tray title and dock badge show.
- **Tree**: clicking the desk icon (or ⌘K) slides a drawer over the sheet listing desks
  grouped by agent, Letta Code style, with an attention dot per desk and "new desk" at the
  bottom of each agent. Type to filter, arrows, Enter. Choosing a desk closes the drawer.
  This replaces the old ⌘K switcher.
- **Desk view**: the canvas fills the whole area; the chat stacks on the left over it,
  edge to edge, narrow (400) or wide (640). The chat's rectangle is a *viewport inset*: fit-all,
  focus and camera glides frame widgets in the uncovered part, and opening or closing the
  chat slides the sheet by the chat's width so nothing ends up under it. The centred chat
  layout is gone; an empty desk opens the chat wide.
- **Inbox**: Catch Up as a full view in the same area, not a veil over the sheet. Esc or
  ⌘1 returns to the desk. Enter/O on a card opens that desk with its chat focused.
- **Settings**: harness (URL, adopted or Desktop), mod link, file locations, chat width,
  and the shortcut table. The first home for facts that had none.

## Keys

| Anywhere | ⌘1 ⌘2 ⌘3 segments · ⌘K tree · ⌘N / N new desk · ⌘[ ⌘] previous / next desk · Esc peels one layer |
| Desk     | ⌘/ toggle chat · ⌘⇧/ narrow / wide · ⌘L focus the message box · ⌘0 1:1 · ⇧1 fit all · ⌘⇧A arrange |
| Chat     | ⏎ send · ⇧⏎ newline · ⌘D dictation (⌘M is minimise on a Mac) |
| Inbox    | → next · ← later · A approve · D deny · R reply · O open · S snoozed · Z undo |
| Global   | ⌥Space show loki on the inbox |

## Steps

1. `app/src/shell/`: `Shell` (owns useDesk + useAttention, segment state, keys), `Sidebar`,
   `DeskTree`, `Settings`, `shortcuts.ts` (one table feeding the handler and the settings page).
2. `Surface` becomes the desk view: receives the hooks' results, loses the switcher, catch-up
   plate and centred layout; gains the inset-aware framing and the chat slide.
3. `ChatWindow`: left-docked, `width: "narrow" | "wide"`, header toggle.
4. `CatchUp`: renders as a view (no veil, no blur); `onOpenDesk` focuses the chat.
5. Remove `DeskSwitcher`. README and design notes follow.

## Not doing (yet)

- Native menu bar, quick-send palette, pop-out widget windows, notifications. Next plan.
- Launch at login (needs the autostart plugin).

## Revisions (same day)

- The drafting title block, then a custom 40px top bar with a header line, were both dropped:
  the window's native title bar now carries the desk name / "Inbox · n waiting" / "Settings".
  Arrange lives on ⌘⇧A only until a native menu exists.
- Chat placement is three-way (left, centre wider, right) on ⌘← / ⌘→; an empty desk centres it.
- Shortcuts estate (later the same day): one keymap table (`app/src/shell/keymap.ts`) drives the key
  handler, Settings, and a native menu bar built by Rust from the same table (`set_menu`, events
  `loki:menu`). Remaps: ⌘T new task (was ⌘J), ⌘0 fit / ⌘⇧0 1:1 / ⌘= ⌘- zoom (⇧1 gone), ⌘⇧/ width
  dropped, inbox decisions as chords while typing (⌘↵ approve, ⌘⇧D deny, ⌘O open, ⌘S snoozed) with
  A/D/O/S as idle-box aliases, board ⌫ done / ⇧⌫ blocked (D and B freed), ⌘, settings, ⌘F find,
  ⌘Z undo widget move, ⌘W close chat, ⌘⇧W hide. Chords the text uses are never taken while typing.
