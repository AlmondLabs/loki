# loki · visual direction

**Subject.** A memory palace your agent furnishes. One person's desks, seen at a
glance: what the agent built here, who built it, what is waiting on you.

**Direction: a drafting table at night.** The canvas is a sheet on an architect's
table. Chrome is title-block lettering; the desk's identity is the window's own
title, drawn by macOS; anything that needs a human is brass.

## Tokens (`app/src/kit/tokens.css`)

Colour: ink-slate ground `--loki-bg`, panels `--loki-panel` / `--loki-panel-header`, hairlines
`--loki-border`, paper `--loki-fg`, `--loki-muted`; brass `--loki-accent` (with `--loki-accent-soft`,
`--loki-brass-soft`, `--loki-brass-glow`) for anything that needs the human; verdigris `--loki-positive`;
oxblood `--loki-negative`. Three more surfaces: `--loki-well` (inputs), `--loki-bubble` (the agent's
speech), `--loki-veil` (behind a sheet). No literal colour appears in a component; the agent chip's
hue is the one computed colour.

Type scale, in px, used as plain numbers in inline styles: **9.5** micro (labels, kbd, rail) ·
**10.5** meta (mono details) · **11** label (`.loki-label`) · **12** small · **13.5** body · **15** row title ·
**17** card title · **22** display · **28** hero. Faces: New York for display, Avenir Next Condensed for labels, the
system face for reading, SF Mono for data. Tracking: 0.06em on mono meta, 0.14em on labels.

Radii: **6** controls · **8** rows · **12** cards and sheets · **999** pills; circles use half their size.
Shadows: `--loki-shadow-sheet` (modals), `--loki-shadow-float` (popovers), `--loki-shadow-panel` (the
chat), `--loki-shadow-low` (small plates). Stacking: `LAYER` in `app/src/kit/layers.ts` (panel 100,
bubble 101, rail 110, modal 200, capture 210, toast 300), never arithmetic on one; small inline z-indexes
are for stacking inside one component only.

Focus is one rule in `tokens.css`: a 1px brass outline, inset, on every button, field, link and tabindex.
Nothing sets `outline: none`. Reduced motion zeroes every CSS duration *and delay*; JS-driven glides
(the camera) go through `glide()` in `app/src/kit/motion.ts`.

`test/tokens.test.ts` fails `bun test` when a style leaves these scales. It reads every `.tsx`, `.ts`
and `.css` under `app/src` (colours, sizes, radii, tracking, faces, shadows, layers, outlines), checks that
every `var(--loki-*)` is defined and used and every `loki-*` class has a rule, and that `index.html` and
the manifest carry `--loki-bg`.

## Primitives (`app/src/ui/`, 2026-09-08)

The chrome is built from one vocabulary, with every state in `ui/ui.css` and never inline: **Button** (tone
quiet · paper · brass · positive · negative; size sm 28 · md 36 · touch 44; bare, block, kbd), **IconButton**
(24 · 28 · 36 · 40; danger goes oxblood on hover), **NavButton** (a page down the left; the reading face, not
the serif), **Chip** (active is paper, brass only for what needs the human, tone for a status badge, static,
tag, touch, label, float), **Field** / **TextArea** (sm · md · touch; mono, bare, large, inline), **Row**
(selected, dense, touch, flush), **Sheet** (veil, aria-modal, Escape, click-out, focus returned; top or
bottom), **Popover**, **Kbd**, **Meta**, **Title**, **Dot**, **Empty**, **Banner**, **Toast**. Selection and
hover are the header tint; brass is never spent on a selection. A one-off is `className`/`style` on the
primitive; a one-off that repeats becomes a modifier. Button and Field share one height scale (sm 28 · md 36 ·
touch 44); a field and the button beside it always share a size. Widgets on the sheet keep `@loki/kit`; app chrome
never ships into that surface. What stays hand-built: the rail (`.loki-rail`), the chat bubble, the tree's
rows (the hover swap CSS needs the div), tabs with an underline, the phone's tab bar, the switch.

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
settings; icons only, condensed caps beneath), one view in the rest. The desks
**tree** is a drawer over the sheet, grouped by agent, with the same attention
dot the inbox would give each desk (brass filled: waits on you; brass ring:
finished unread; muted ring: running). The chat stacks on the sheet's left edge,
edge to edge, and is treated as a viewport **inset**: framing centres in the
uncovered part, and toggling the chat slides the sheet by its width. The inbox
is a view, not a veil — the sheet stays mounted behind it.

## Rules

- Brass is spent only on things that need the human. No brass decoration.
- Structure encodes truth: no numbering, eyebrows, or dividers that do not carry information.
- Rounded corners belong to things on the sheet (widgets, panels). Sheet chrome (plates) is square.
- Reduced motion is respected globally; focus rings are brass hairlines.
- No real money amounts on screen, in the repo, or in recordings (R9).

## Tried and dropped

- Blue `#5b7cfa` as the accent: read as any dark dashboard. Brass ties to the room-plate motif and leaves blue free for data.
  (`app/public/icon.svg` and the PNG icons still carry it; redraw them in brass.)
- Oxblood `#c0665b`: 4.20:1 on a panel, under AA for the 12px error strings it carried. Lifted to `#cf7266`
  (4.97:1 on panel, 4.62:1 on panel-header) on 2026-09-08.
- Dimming *text* with opacity (kbd hints at 0.6, done cards at 0.6): the muted grey fell to 2.75:1. Text that
  is secondary is `--loki-muted`; opacity is for icons at rest.
- A blurred veil under the new-desk sheet, and a square sheet: the only glass and the only square dialog in
  the product; both fell in line with the other sheets.
- Side stripes (a 3px oxblood border on the phone's banner, a 2px brass one on a settings note): a leading
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
still clips the rail's width) and the phone's remaining sub-44px targets; `.loki-label` back to title-block
facts only; the jargon and error-string pass; the archive fold inside the tree's listbox is still unreachable
while the search box owns Tab.
