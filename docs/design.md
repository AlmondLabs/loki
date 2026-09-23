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
data (diffs, file bodies) and key hints. The layout did not change (see Shell). The foundation (tokens,
primitives, chat classes) moved first; the inline styles in the desktop views follow in a sweep.

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
toasts; circles use half their size. Shadows: `--loki-shadow-sheet` (modals), `--loki-shadow-float` (popovers),
`--loki-shadow-panel` (the chat), `--loki-shadow-low` (small plates). Stacking: `LAYER` in
`app/src/kit/layers.ts` (panel 100, bubble 101, rail 110, modal 200, capture 210, toast 300), never arithmetic
on one; small inline z-indexes are for stacking inside one component only.

Focus is one rule in `tokens.css`: a 2px ring in the accent blue, inset on every button, field and tabindex
(so a clipped list never cuts it off) and offset on links. Nothing sets `outline: none`. Reduced motion zeroes
every CSS duration *and delay*; JS-driven glides (the camera) go through `glide()` in `app/src/kit/motion.ts`.

`test/tokens.test.ts` fails `bun test` when a style leaves these scales. It reads every `.tsx`, `.ts`
and `.css` under `app/src` (colours, sizes, radii, tracking, faces, shadows, layers, outlines), checks that
every `var(--loki-*)` is defined and used and every `loki-*` class has a rule, that `index.html`, the manifest
and the native window carry `--loki-bg`, that every family defines the attention and affirm roles with AA ink,
and that no serif or condensed face, no tracking and no display/label face is left in a stylesheet. Inline
styles still carry the retired tracking and face aliases until the sweep; the test's `LEGACY_INLINE_*` sets
name them and shrink to nothing when it lands.

## Primitives (`app/src/components/`, 2026-09-08; Slack look 2026-09-23)

The chrome is built from one vocabulary, with every state in `components/components.css` and never inline:
**Button** (tone quiet · paper · brass · positive · negative; size sm 28 · md 36 · touch 44; bare, block,
kbd), **IconButton** (24 · 28 · 36 · 40; danger goes red on hover), **NavButton**, **Chip** (active is
neutral, brass the blue pick, attention the red badge, tone for a status badge, static, tag, touch, label,
float), **Field** / **TextArea** (sm · md · touch; mono, bare, large, inline), **Row** (selected, dense, touch,
flush), **Sheet** (veil, aria-modal, Escape, click-out, focus returned; top or bottom), **Popover**, **Kbd**,
**Meta**, **Title**, **Dot**, **Empty**, **Banner**, **Toast**.

The tone names predate the Slack look and are kept for compatibility. What they render now: `quiet` muted ink
on a hairline · `paper` fg ink · `brass` the accent blue ink (an interactive action; it no longer means
"needs you") · `positive` Slack's affirmative, green filled with white ink · `negative` red ink. Buttons are
semibold. Chips, meta, banners and labels are the sans at 12, no caps, no tracking; titles are sans bold. Kbd
stays mono. Selection and hover use distinct neutral steps; neither the accent nor the badge is spent on a
selection. A one-off is `className`/`style` on the primitive; a one-off that repeats becomes a modifier.
Button and Field share one height scale (sm 28 · md 36 · touch 44); a field and the button beside it always
share a size. Widgets on the sheet keep `@loki/kit`; app chrome never ships into that surface. What stays
hand-built: the rail (`.loki-rail`), the chat bubble, the tree's rows (the hover swap CSS needs the div), tabs
with an underline, the phone's tab bar, the switch.

## Signature

There is no top chrome of our own. The **native title bar** shows the desk's
name (with "· archived" or "· deleted" when that is the case), "Inbox · n
waiting", or "Settings", and changes as you move. Who drew the desk is in the
tree and the chat; the sheet's actions are on the keys (⌘⇧A arrange, ⌘0 fit,
⌘⇧0 1:1) and listed in Settings. Two earlier forms were dropped on 2026-09-06:
a drafting title block (DESK · DRAWN BY · STATUS · SCALE) and then a custom
40px bar with a header line — both were chrome justifying itself.

## Shell (2026-09-06)

Under the native title bar, a 48px **rail** of three segments (desk, inbox,
settings; icons only, a small label beneath), one view in the rest. The desks
**tree** is a drawer over the sheet, grouped by agent, with the same attention
dot the inbox would give each desk (red filled: waits on you; a ring: finished
unread; muted ring: running). The layout is unchanged by the Slack look. The chat stacks on the sheet's left edge,
edge to edge, and is treated as a viewport **inset**: framing centres in the
uncovered part, and toggling the chat slides the sheet by its width. The inbox
is a view, not a veil — the sheet stays mounted behind it.

## Phone (Slack mode, 2026-09-23)

The phone is its own presentation, not the desktop shrunk: Slack's September 2026 mobile app is the
reference for type, colour, rows, sheets and navigation (plan `docs/plans/2026-09-22-012`). The boundary is
the `.loki-phone` root. Everything below applies under it and nowhere else. The desktop took the same Slack
direction later that day (above), but keeps its own palettes and layout; shared chat pieces take phone looks
only through optional props (`touch`, `layout`, `draft`, `icons`, `attach`) that default to the desk's
behaviour.

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
  Every target is 44 × 44, a smaller glyph getting its area from an `::after`. Focus is a 2px ring in the
  link colour; a field's ring goes round its whole pill (Search, the composer). The routes' one `main` holds
  whatever screen is up; the dock is the `primary` navigation beside it. Gestures (swipe a card, long-press a
  row) always have a visible button that does the same.

## Rules

- Blue is for interaction, red for attention, green for the affirmative. The red badge is spent only on what
  is unread or waits on the human; no colour is decoration.
- Structure encodes truth: no numbering, eyebrows, or dividers that do not carry information.
- Chrome is rounded on the radius scale; nothing on screen is a square plate unless it runs edge to edge.
- Sentence-case sans for every label; mono only for code, data and keys.
- Reduced motion is respected globally; focus rings are 2px accent-blue rings.
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

## Backlog

The review of 2026-09-08 (`docs/research/2026-09-08-ui-review.md`) scored 26/40 on heuristics and 13/20 on
the code audit. Closed the same day: the primitive vocabulary; focus rings; contrast; reduced motion; the
mod's desk block and Letta's skill bodies rendering as the user's words (they are event rows now); modal
sheets (aria-modal, Tab loop, initial and return focus); the combobox pattern on the desks tree and the model
picker; keyboard access to board cards (roving tabindex in per-column listboxes) and widget frames (arrows
nudge, Alt-arrows resize, Enter frames the camera, a polite announcement). Left, in order: confirmations for
forget / remove / disable and an undo on archive; a breakpoint layer for the desktop (the inbox at 1100 wide
still clips the rail's width); the desktop inline-style sweep to the Slack look (the tokens test's
`LEGACY_INLINE_*` sets); the jargon and error-string pass; the archive fold inside the tree's listbox is still unreachable
while the search box owns Tab.
