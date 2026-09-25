# loki · visual direction

**Subject.** A memory palace your agent furnishes. One person's desks, seen at a
glance: what the agent built here, who built it, what is waiting on you.

**Direction: Slack, day or night (2026-09-23).** The desktop wears Slack's desktop look, the same system
the phone adopted the same day: a neutral grey ground, raised panels a step lighter, near-white (or
near-black) ink, one sans face, rounded chrome. Blue is for links, focus and anything interactive; the red
badge is for what is unread or waits on you; green fills the affirmative button. This replaced the drafting
table outright, by the user's decision; it is not a second option. Three recorded rules were reversed with
the user's approval: (1) brass for needs-you became blue for interaction, red for attention and green for
affirmation; (2) chrome is rounded, where plates used to be square and only sheet things rounded; (3) the
condensed uppercase tracked labels and the mono meta became sentence-case sans, with mono kept only for code,
data (diffs, file bodies) and key hints. The foundation (tokens, primitives, chat classes) moved first; the
inline styles in the desktop views followed in a sweep the same day, and the layout followed with plan 013
(see Signature and Shell).

## Tokens (`app/src/kit/tokens.css`)

The structural stack is the ground `--loki-bg`, panel `--loki-panel`, raised header `--loki-panel-header`,
then `--loki-hover` and neutral `--loki-selection`. `--loki-border` is a quiet divider; `--loki-control-border`
is deliberately stronger and stays at least 3:1 against control surfaces. `--loki-fg` and `--loki-muted` stay
AA on every working surface. The roles:

- `--loki-accent` — the link / interactive blue (links, focus, toggles, a chosen pick, chart series), with
  `--loki-accent-soft` (a pressed or chosen fill) and two tints whose names are kept from the drafting table
  to avoid churn: `--loki-brass-soft` (the quiet blue wash behind accent ink) and `--loki-brass-glow` (the
  highlight halo). The accent no longer means "needs you".
- `--loki-attention` / `--loki-on-attention` — Slack's red badge and its ink: unread counts, the dot on a desk
  that waits on you. Only a badge or dot, never a panel.
- `--loki-affirm` / `--loki-on-affirm` — Slack's green, filled, and its ink: the one affirmative button on a
  surface (approve, done).
- `--loki-positive` / `--loki-negative` — status inks (a pass, a failure, a destructive action).
- Inputs, agent speech, user speech and inline code each have their own surface token (`--loki-well`,
  `--loki-bubble`, `--loki-user-bubble`, `--loki-code`) instead of borrowing selection or accent.

No literal colour appears in a component; the agent chip's hue is the one computed colour. `data-theme`
selects dark or light values, and the saved `system` preference follows the operating system. `data-palette`
selects the colour family: loki's own (Slack's values, the default) or Tokyo Night, each with a day and a night
side that fill the same roles — Tokyo Night's blue is the accent, its red the attention badge (and the
negative), its green the affirm, its teal the positive; Day inks that miss AA are darkened along their own hue.
Tokyo Night is colour only: it takes the same type, radii and roles. An inline initializer applies both before
first paint; the grounds are repeated in `index.html`, the web manifest and the native window (`src-tauri`).

Type scale, in px, used as plain numbers in inline styles: **9.5** micro (kbd, rail) · **10.5** fine print ·
**11** tag · **12** small, meta, label (`.loki-label`) · **13.5** body · **15** row title · **17** card title ·
**22** display · **28** hero. One face: the system sans (`--loki-font`); `--loki-display` and `--loki-label`
are aliases of it, kept so older call sites resolve. SF Mono (`--loki-mono`) only for code, data and key hints.
Weight carries the hierarchy (400 reading, 600 labels and names, 700 titles); no tracking, no uppercase.

Radii: `--loki-radius-sm` **6** fields, icon buttons, dense rows · `--loki-radius-md` **8** buttons, rows,
plates · `--loki-radius-lg` **12** cards, sheets, popovers, panels · `--loki-radius-pill` **999** chips, badges,
toasts; circles use half their size. A radius with a role is written as its token (`"var(--loki-radius-md)"`), never
as the number; the tokens test fails a bare 6, 8, 12 or 999 outside the phone. Shadows: `--loki-shadow-sheet` (modals), `--loki-shadow-float` (popovers),
`--loki-shadow-panel` (the chat), `--loki-shadow-low` (small plates). Stacking: `LAYER` in
`app/src/kit/layers.ts` (panel 100, bubble 101, rail 110, modal 200, capture 210, strip 250, toast 300), never arithmetic
on one; small inline z-indexes are for stacking inside one component only.

Focus flashes, one rule in `tokens.css`: when focus moves by keyboard, a 2px accent-blue ring appears and
fades over a second, so you see where focus went without a box sitting there. Controls (buttons, rows, tabs,
links, selects, checkboxes) settle on a 2px muted ring, since nothing else shows which one Tab or Enter acts
on; text fields settle on nothing, the caret shows them. The ring is inset (so a clipped list never cuts it
off) and offset on links. Only the colour animates, so under reduced motion the settled ring shows at once.
Nothing sets `outline: none`, and a rule that turns a ring off also says `animation: none`. Reduced motion zeroes
every CSS duration *and delay*; JS-driven glides (the camera) go through `glide()` in `app/src/kit/motion.ts`.

`test/tokens.test.ts` fails `bun test` when a style leaves these scales. It reads every `.tsx`, `.ts`
and `.css` under `app/src` (colours, sizes, radii, tracking, faces, shadows, layers, outlines), checks that
every `var(--loki-*)` is defined and used and every `loki-*` class has a rule, that `index.html`, the manifest
and the native window carry `--loki-bg`, that every family defines the attention and affirm roles with AA ink,
and that no serif or condensed face, no tracking and no display/label face is left in a stylesheet. Inline
styles are held to the same: no `letterSpacing`, no `textTransform: uppercase`, and no face but the sans or
mono (the display and label aliases never appear in a view). Mono inline is for code, diffs, file bodies,
paths and commands shown as data, commit and task ids, and key hints; timestamps, counts, status words, names
and meta lines are the sans. Label and heading strings are written in sentence case, since nothing transforms
them (`sentence()` in the primitives capitalises one built from an id).

## Primitives (`app/src/components/`, 2026-09-08; Slack look 2026-09-23)

The chrome is built from one vocabulary, with every state in `components/components.css` and never inline:
**Button** (tone quiet · paper · brass · positive · negative; size sm 28 · md 36 · touch 44; bare, block,
kbd), **IconButton** (24 · 28 · 36 · 40; danger goes red on hover), **NavButton**, **Chip** (active is
neutral, brass the blue pick, attention the red badge, tone for a status badge, static, tag, touch, label,
float), **Field** / **TextArea** (sm · md · touch; mono, bare, large, inline), **Row** (selected, dense, touch,
flush), **Sheet** (veil, aria-modal, Escape, click-out, focus returned; top or bottom), **Popover**, **Kbd**,
**Meta** (sans 12 muted; brass, negative for a small error, wrap; a div that is a meta line takes the
`loki-meta` class instead of a hand-set fontSize and colour), **Title**, **Dot**, **Empty**, **Banner**, **Toast**.

The tone names predate the Slack look and are kept for compatibility. What they render now: `quiet` muted ink
on a hairline · `paper` fg ink · `brass` the accent blue ink (an interactive action; it no longer means
"needs you") · `positive` Slack's affirmative, green filled with white ink · `negative` red ink. Buttons are
semibold. Chips, meta, banners and labels are the sans at 12, no caps, no tracking; titles are sans bold. Kbd
stays mono. Selection and hover use distinct neutral steps; neither the accent nor the badge is spent on a
selection. A one-off is `className`/`style` on the primitive; a one-off that repeats becomes a modifier.
Button and Field share one height scale (sm 28 · md 36 · touch 44); a field and the button beside it always
share a size. Widgets on the sheet keep `@loki/kit`; app chrome never ships into that surface. What stays
hand-built: the rail (`.loki-rail`), the chat bubble, the board picker's rows, the phone's tab bar, the switch.
The Slack layout added its own blocks (2026-09-23): **ListRow** (a lead, the title bold when unread, a preview,
the time or the red badge, hover actions; `aria-current` on the chosen one), **ListSection** (a folding
heading with a count and actions), **TabRow** (an ARIA tablist with roving focus, the underline tabs),
**PaneHeader** (the pane's name line and tab row) and **EmptyPane**.

## Signature

The window has no native title bar (2026-09-23): the title bar is an overlay with its title hidden, the
traffic lights sit over the rail, and loki draws the top edge itself — a 28px **title strip** that drags the
window and zooms on a double click, with nothing interactive in it (`TitleStrip`, 0px in a browser tab). The
window title is still set, for the Window menu, Mission Control and screen readers: the desk's name (with
"· archived" or "· deleted"), "Inbox · n waiting", "Board · n open", "Agents", or "Settings" while Preferences
is up. There is no top bar of search or history. Each pane draws its own header instead, Slack's: a 48px name
line (a `#` and the desk's name, or the agent's face and name) with a quiet aside and the actions on the
right, and under it a tab row. The name line drags the window too, so anything clickable in it is a real
button. A desk's header carries its agent with the live word (working, writing, needs approval, asked you), pin,
archive and a "More desk actions" menu: Mark as done (⌘⇧↵) or Mark as not done first, Rename… (Letta's
conversation summary, so the main chat has none), then the rest with their keys; the sheet's own actions (⌘⇧A
arrange, ⌘0 fit, ⌘⇧0 1:1) join that menu on the Desk tab. Two earlier forms were dropped on 2026-09-06: a
drafting title block (DESK · DRAWN BY · STATUS · SCALE) and then a custom 40px bar with a header line.

**Windows and Linux (preview, plan 014).** There the window is undecorated and the strip is Slack's for those
systems: 32px, the height Windows gives its caption buttons, on `--loki-panel`. At its left a ☰ button the rail's
width opens the Mac's menu bar as a popover: the menu titles (the `menuSpec()` groups), each opening its items
beside it, keys written Ctrl, Alt, Shift, with the header menus' keyboard manners; at its right minimise, maximise (Restore, with the two-square glyph, while maximised) and close,
46px wide, flat and full height, square because they run to the window's edge. Hover is `--loki-hover`; close
alone hovers red (`--loki-attention`), the one place the red is not a badge, because that is what close does on
both systems. The strip sits on `LAYER.strip`, above sheets, so the window buttons stay usable while a dialog is
up, as a system title bar would. The strip drags; double click maximises. The rest of the window is the Mac's.

The conversation is the signature surface. The Messages tab draws the thread in Slack's anatomy: a 36px face
and bold name at the start of each run, the body under the name, the message's **time** quiet after the name
(and in the face's column on hover for a run's later rows), a sticky **day pill** ("Today", "Yesterday", a date)
opening each calendar day, a red **New** line before the first message you have not seen, and a small hover
toolbar that holds only what loki does to a message (copy as markdown). A message with no known time shows none.
**Widget rows** sit among the messages by time, one quiet line with a tile icon in the face's column: "friday
added Revenue chart · 14:49", the widget's title in the link blue while it is still on the desk; choosing one
opens the Desk tab framed on that widget. Tool and event lines sit in the message column under the text they
follow. **The message box** (2026-09-24, after Claude's, one for the phone and the desktop) is one rounded field
on the well, the text on top and a row inside it: a round "+" (attach images), the **model pill** (the model's
name in the ink, its effort after it in the muted colour, only when the model offers levels), then the mic
(only where dictation works) and a round send, Slack's green once there is something to send and a muted
circle while the box is empty; every control in the row is one height (28 here, 36 on the phone with a 44
target). The pill opens **Select model**: a popover over the box here (↑↓ Home End, Enter, Esc or a click away
closes, focus returns to the pill; ⌘⇧M opens it too), a bottom sheet on the phone (grip, a round × at the top
left, the title centred). Both show a card of the short list (the harness's featured models and the current
one; each row the name, its own description or else its handle, a check in the accent on the current one),
then Effort › (that model's levels) and More models › (the rest, filtered by provider or name). The
permission mode stays under the box, beside approve and deny. The model and effort chips that sat in that
row until 2026-09-24 are gone.

## Shell (2026-09-06; Slack layout 2026-09-23)

List and detail, as Slack's desktop: a 48px **rail**, a **list column** beside it, and the **pane** in the rest.

- **Rail.** Six sections in Slack's labelled-icon style (Desk, Inbox, Board, Agents, Learn, Settings), a red
  count badge on what needs you (the inbox's waiting count, open tasks, due cards), and at the foot the column
  toggle and Settings. The pane is the window's one `main`; the rail is its navigation.
- **List column.** Desk, Board, Agents and Learn list their items in a second column (`ListColumn`), 260px by
  default, dragged or arrowed on its edge between 220 and 420, shown or hidden with ⌘⇧D (in the Inbox, which has
  no column, ⌘⇧D stays Deny) or the rail's toggle.
  A window under 1100 wide folds it away until asked for, without touching the saved choice. Each section's
  list mounts on first visit and then stays, hidden, so its scroll and folds survive switching. The column's
  48px header (the section's name and a "+") sits level with the pane's header. Inbox has no column: the pass
  is the whole pane. Settings has none either: it is a sheet.
- **Desk sidebar.** A filter ("Find a desk…", by desk or agent name; ↓ into the rows, ↑↓ between them, ↵ opens
  the first match), then **Pinned**, then one folding section per agent with its own "+", then a folded
  **Archived**. A row is `#` and the desk's name: a red badge (and bold) when it waits on you, a green dot while
  its agent works, and for a desk whose agent has finished a small ring after the name, bold as well while there
  is news since you last looked. **Viewed is not done**: opening a desk un-bolds it, but the ring (and its Inbox
  card) stay until you act or Mark as done; bold and ring is new, the ring alone is "viewed, not done", neither is
  done. The phone reads the same marks through the mod. Hover shows pin and archive; a right click opens the row
  menu (open, Mark as done or not done, Rename…, pin, archive or restore). When a desk that waits on you is scrolled out of view, a red "Needs you"
  pill at the top or bottom edge scrolls it back. Scroll and folds are kept across restarts. The sidebar
  replaced the desks tree drawer (2026-09-23, approved by the user); the tree lives on only as the Board's
  assign-to-desk picker.
- **Desk pane.** A desk opens on **Messages** with the composer focused, from anywhere (the sidebar, search,
  the Inbox's Enter or O, Agents, Learn). **Desk** is the tab beside it: today's sheet edge to edge with the
  chat as a viewport **inset** (framing centres in the uncovered part, toggling the chat slides the sheet by its
  width), the camera, arranging and the widget keys unchanged. The Desk tab hides the list column and keeps the
  rail. Esc, or the Messages tab, returns to the thread at the scroll it was left at, and focus to what it last
  held there. Both views are one conversation with one draft: a half-written reply follows you across the tabs.
  Only the view on screen draws the composer. Each desk remembers its tab for ⌘[ ⌘]; an open always lands on
  Messages. The pane stays mounted, hidden, behind the other sections, so the desk link, the camera and the
  thread's scroll keep their state; its panels inherit that hiding and never set themselves visible.
- **Agents** is Slack's DMs: the column lists agents (face, name, live dot, the last thing it said, a red badge
  for what waits in the Inbox); the pane shows the chosen agent with a tab row for its pages (Profile, Memory,
  Changes, Reflection, Skills). **Board** lists its views (all tasks, each status with its count, each agent);
  "all" is the four-column board, the rest a single list, with today's keys; a remembered agent view whose agent
  is gone says so and asks for a new pick. **Learn** lists Review, Leads, All cards and Deleted. With nothing chosen, a pane shows one quiet line saying what to pick.
- **Search (⌘K).** A sheet from anywhere over desks, agents, waiting Inbox items and the app's pages
  (sections and each Preferences page), from what the app already has; it does not search message text, and
  says so. An empty query lists recent places; ↑↓ move, ↵ opens the top result, Esc or ⌘K closes it.
- **Preferences.** Settings opens as a large sheet over the whole window, rail included: a named page list on
  the left (an ARIA tab list; focus follows the page), the page on the right, sentence case, confirmations as sheets. ⌘, (or ⌘6) toggles it, ⌘1-5 close it
  and go, ⌘[ ⌘] step its pages; every other dialog still blocks the shell's keys.
- **Inbox** keeps its screen (the Slack look only); Enter or O on a card opens its desk on Messages.

## Phone (Slack mode, 2026-09-23)

The phone is its own presentation, not the desktop shrunk: Slack's September 2026 mobile app is the
reference for type, colour, rows, sheets and navigation (plan `docs/plans/2026-09-22-012`). The boundary is
the `.loki-phone` root. Everything below applies under it and nowhere else. The desktop took the same Slack
direction later that day (above), but keeps its own palettes and layout; shared chat pieces take phone looks
only through optional props (`touch`, `layout`, `draft`) that default to the desk's behaviour; the message
box is one for both, its sizes set by `touch`.

- **Tokens.** `app/src/phone/phone.css` owns them. `.loki-phone` redeclares every `--loki-*` role with Slack's
  dark values and `:root[data-theme="light"] .loki-phone` with its light ones, and adds the `--phone-*` scales
  (text 11 · 13 · 15 · 17 · 20 · 28, radii 8 · 12 · 24 · pill, space 4–24, the 44 touch size, layers, durations).
  The accent is link blue, the unread badge is red, affirmative is green; the faces are the system sans, mono
  only for code. `data-palette` never reaches the phone: System, Light and Dark are its only choices.
  `test/tokens.test.ts` fences the file (literal colours only in custom properties, sizes and radii on the
  scales, every selector under `.loki-phone`, no serif or mono presentation).
- **Safe areas.** Each bottom inset has one owner. On a tab the floating dock (TabBar.tsx) sits on the home
  indicator and publishes `--phone-nav-clearance`; the one scroll owner adds it once at its end
  (`.loki-phone-scroll::after`) and a fixed bottom stops above it (`.loki-phone-above-nav`). With the navigation
  hidden — a conversation, the Inbox pass, any page — the composer or the decide buttons pad themselves with
  `--phone-safe-bottom`. Nothing else adds bottom space, so there is never a band under the capsule.
- **One scroll owner.** The document never scrolls (`html:has(.loki-phone-shell)` pins it); the shell is
  `100dvh` over `100svh` over fixed inset. Each screen has exactly one vertical scroller: the page's
  `Scroll`, or the thread inside a conversation or card. Headers, notices, composers and decide buttons are
  intrinsic flex rows outside it, with `min-height: 0` on the column so the scroller is the part that gives.
- **Keyboard.** Where the on-screen keyboard only shrinks the visual viewport (iOS), `viewport.ts` sets
  `data-keyboard` with `--phone-viewport-top` and `--phone-viewport-height` from `visualViewport`, and the shell
  fits the visible part with no bottom inset; the notice steps aside and a question or approval scrolls inside
  itself before the box would leave the screen. Without `visualViewport` the layout still works at the
  shrunken layout height.
- **Controls.** One outlined icon set (`icons.tsx`, 24 box, 1.8 stroke); no text glyphs or emoji as controls.
  Every target is 44 × 44, a smaller glyph getting its area from an `::after`. Focus flashes as on the Mac, in the
  link colour; a field's flash goes round its whole pill (Search, the composer). The routes' one `main` holds
  whatever screen is up; the dock is the `primary` navigation beside it. Gestures (swipe a card, long-press a
  row) always have a visible button that does the same.

## Rules

- Blue is for interaction, red for attention, green for the affirmative. The red badge is spent only on what
  is unread or waits on the human; no colour is decoration.
- Structure encodes truth: no numbering, eyebrows, or dividers that do not carry information.
- Chrome is rounded on the radius scale; nothing on screen is a square plate unless it runs edge to edge.
- Sentence-case sans for every label; mono only for code, data and keys.
- Reduced motion is respected globally; focus is a 2px accent-blue flash that settles on a muted ring (controls) or nothing (text fields).
- No real money amounts on screen, in the repo, or in recordings (R9).

## Tried and dropped

- The drafting table (2026-09-06 to 2026-09-23): brass `--loki-accent` for anything that needs the human,
  verdigris and oxblood, New York for display, Avenir Next Condensed caps tracked 0.14em for title-block
  labels, mono meta tracked 0.06em, square plates with only sheet things rounded, a 1px inset brass focus
  hairline. Retired on 2026-09-23 for Slack, by the user's decision, on the desktop as on the phone.
- Blue `#5b7cfa` as the accent (before 2026-09-06): read as any dark dashboard next to the drafting table.
  Slack's blue came back with Slack's whole system, where it reads as Slack, not as a dashboard.
- Oxblood `#c0665b` (drafting table): 4.20:1 on a panel, under AA for the 12px error strings it carried. Lifted to `#cf7266`
  (4.97:1 on panel, 4.62:1 on panel-header) on 2026-09-08.
- Dimming *text* with opacity (kbd hints at 0.6, done cards at 0.6): the muted grey fell to 2.75:1. Text that
  is secondary is `--loki-muted`; opacity is for icons at rest.
- A blurred veil under the new-desk sheet, and a square sheet: the only glass and the only square dialog in
  the product; both fell in line with the other sheets.
- Side stripes (a 3px red border on the phone's banner, a 2px accent one on a settings note): a leading
  dot or nothing carries the same meaning.
- "arrange" as a title-block cell labelled "sheet": an action inside a block of facts; moved to a plate.
- The native title bar as the only header (2026-09-06 to 2026-09-23): the window's own bar named the view and
  loki drew no chrome above the sheet. Retired with the Slack layout, by the user's decision: the title bar is
  hidden, loki draws a drag strip, and each pane has a header with its name, actions and tabs.
- The desks tree as a drawer over the sheet (2026-09-06 to 2026-09-23): ⌘K or the rail's desk icon opened a
  centred list of every desk (waiting, pinned, recent, the rest), filtered by agent chips, with ⌘P pin, ⌘E
  archive and ⇧↵ open-with-chat. Replaced by the always-there desk sidebar (grouped by agent, pinned on top) and
  ⌘K search; the tree survives only as the Board's picker, without the switching, pinning or archiving.
- A desk that opened on its canvas (to 2026-09-23): the conversation floated on the widgets and switching
  desks meant summoning the drawer. A desk now opens on Messages; the canvas is its Desk tab.

## Backlog

The review of 2026-09-08 (`docs/research/2026-09-08-ui-review.md`) scored 26/40 on heuristics and 13/20 on
the code audit. Closed the same day: the primitive vocabulary; focus rings; contrast; reduced motion; the
mod's desk block and Letta's skill bodies rendering as the user's words (they are event rows now); modal
sheets (aria-modal, Tab loop, initial and return focus); the combobox pattern on the desks tree and the model
picker; keyboard access to board cards (roving tabindex in per-column listboxes) and widget frames (arrows
nudge, Alt-arrows resize, Enter frames the camera, a polite announcement). Left, in order: confirmations for
forget / remove / disable and an undo on archive; the jargon and error-string pass; the archive fold inside
the board picker's listbox is still unreachable while its search box owns Tab. The desktop's 1100-wide floor
(R31 of plan 013) now holds: the inbox card and the four board columns fit beside the rail and the list column.
