# loci · visual direction

**Subject.** A memory palace your agent furnishes. One person's desks, seen at a
glance: what the agent built here, who built it, what is waiting on you.

**Direction: a drafting table at night.** The canvas is a sheet on an architect's
table. Chrome is title-block lettering; the desk's identity is a title block in
the sheet corner; anything that needs a human is a brass plate.

## Tokens (`app/src/kit/tokens.css`)

| role | value | why |
| --- | --- | --- |
| ground `--loci-bg` | `#12151b` ink-slate | cool, not black; dots read as drafting paper |
| panel / header | `#1a1e27` / `#1f2430` | one step up, never glossy |
| rule `--loci-border` | `#2b313d` | hairline cells |
| text `--loci-fg` | `#e7e3d8` paper | warm against the cool ground |
| brass `--loci-accent` | `#c9a45c` | needs you: approvals, unread, catch-up count |
| verdigris `--loci-positive` | `#6fb3a4` | live, finished, allow |
| oxblood `--loci-negative` | `#c0665b` | deleted, failed, deny |

Type roles: **display** New York / ui-serif for room names (desk and
conversation titles); **label** Avenir Next Condensed, caps, tracked 0.14em, for
title-block lettering, widget names, eyebrows; **body** the system face;
**mono** SF Mono for ids, paths, commands, the drawing scale.

## Signature

The **title block** (`app/src/desk/TitleBlock.tsx`), top-right like a sheet
corner: DESK · DRAWN BY · STATUS · SCALE. Every cell is a fact about the desk;
SCALE is the live zoom as a drawing ratio (1:1, 1:2, 2:1). Actions live on
separate **plates** (arrange, catch up), never inside the block.

## Rules

- Brass is spent only on things that need the human. No brass decoration.
- Structure encodes truth: no numbering, eyebrows, or dividers that do not carry information.
- Rounded corners belong to things on the sheet (widgets, panels). Sheet chrome (title block, plates) is square.
- Reduced motion is respected globally; focus rings are brass hairlines.
- No real money amounts on screen, in the repo, or in recordings (R9).

## Tried and dropped

- Blue `#5b7cfa` as the accent: read as any dark dashboard. Brass ties to the room-plate motif and leaves blue free for data.
- "arrange" as a title-block cell labelled "sheet": an action inside a block of facts; moved to a plate.
