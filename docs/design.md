# loki · visual direction

**Subject.** A memory palace your agent furnishes. One person's desks, seen at a
glance: what the agent built here, who built it, what is waiting on you.

**Direction: a drafting table at night.** The canvas is a sheet on an architect's
table. Chrome is title-block lettering; the desk's identity is the window's own
title, drawn by macOS; anything that needs a human is brass.

## Tokens (`app/src/kit/tokens.css`)

| role | value | why |
| --- | --- | --- |
| ground `--loki-bg` | `#12151b` ink-slate | cool, not black; dots read as drafting paper |
| panel / header | `#1a1e27` / `#1f2430` | one step up, never glossy |
| rule `--loki-border` | `#2b313d` | hairline cells |
| text `--loki-fg` | `#e7e3d8` paper | warm against the cool ground |
| brass `--loki-accent` | `#c9a45c` | needs you: approvals, unread, catch-up count |
| verdigris `--loki-positive` | `#6fb3a4` | live, finished, allow |
| oxblood `--loki-negative` | `#c0665b` | deleted, failed, deny |

Type roles: **display** New York / ui-serif for room names (desk and
conversation titles); **label** Avenir Next Condensed, caps, tracked 0.14em, for
title-block lettering, widget names, eyebrows; **body** the system face;
**mono** SF Mono for ids, paths, commands, the drawing scale.

## Signature

There is no top chrome of our own. The **native title bar** shows the desk's
name (with "· archived" or "· deleted" when that is the case), "Inbox · n
waiting", or "Settings", and changes as you move. Who drew the desk is in the
tree and the chat; the sheet's actions are on the keys (⌘⇧A arrange, ⇧1 fit,
⌘0 1:1) and listed in Settings. Two earlier forms were dropped on 2026-09-06:
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
