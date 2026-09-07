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
**10.5** meta (mono details) · **12** small · **13.5** body · **15** row title · **17** card title ·
**22** display · **28** hero. Faces: New York for display, Avenir Next Condensed for labels, the
system face for reading, SF Mono for data. Tracking: 0.06em on mono meta, 0.14em on labels.

Radii: **6** controls · **8** rows · **12** cards and sheets · **999** pills; circles use half their size.
Shadows: `--loki-shadow-sheet` (modals), `--loki-shadow-float` (popovers), `--loki-shadow-panel` (the
chat), `--loki-shadow-low` (small plates). Stacking: `LAYER` in `app/src/kit/layers.ts` (panel 100,
rail 110, modal 200, toast 300); small inline z-indexes are for stacking inside one component only.

`test/tokens.test.ts` fails the build when an inline style leaves these scales.

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
- "arrange" as a title-block cell labelled "sheet": an action inside a block of facts; moved to a plate.
