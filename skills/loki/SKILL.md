---
name: loki
description: Furnish the user's loki canvas (browser widget desk) by writing widget files. Use when the user asks to see something on the canvas/desk, to visualize data, to add a control they can operate, or when a live visual beats prose. Also use to read what the user did on the desk.
---

# loki — the desk is a directory

The canvas is the loki app (or a browser tab) that renders files: each conversation's
desk is its **Desk** tab, beside the **Messages** tab that shows the conversation.
There is no render tool. To put something on the desk, write a file. To change
it, edit the file. To remove it, delete the file. Vite hot-reloads the tab
within a second.

```text
~/.letta/loki/widgets/<desk>/<name>.json    # a kit widget
~/.letta/loki/widgets/<desk>/<name>.tsx     # a custom React widget
~/.letta/loki/widgets/shared/…              # widgets that belong to no conversation
```

`<desk>` is this conversation's desk id. `desk_state` returns it as `desk` and
the absolute directory as `widgetsDir`. Call `desk_state` first if you do not
know it. Widget id = `<desk>/<name>`.

## Kit widget (.json)

```json
{ "type": "stat", "title": "Sleep", "data": { "value": 7.2, "unit": "h", "label": "last night", "delta": 0.4 } }
```

| type | data |
|---|---|
| `info-card` | `{ lines: string[] }` |
| `stat` | `{ value, label?, unit?, delta? }` |
| `slider-control` | `{ label, value, min, max, step?, unit? }` |
| `list-card` | `{ items: [{ text, done? }] }` |
| `chart-card` | `{ kind: "line"\|"bar"\|"area", points: [{ x, y }], yLabel? }` |

## Custom widget (.tsx)

```tsx
import { useMemo } from "react";
import { Stat } from "@loki/kit";

export const title = "Trip budget";                    // title bar; defaults to the file name
export const data = { days: 5, spent: [10, 20, 5] };   // initial data, optional

export default function Widget({ data, onSet }: { data: any; onSet: (path: string, value: unknown) => void }) {
  const total = useMemo(() => data.spent.reduce((a: number, b: number) => a + b, 0), [data.spent]);
  return (
    <div className="grid gap-2">
      <Stat data={{ value: total, label: "spent", unit: "units" }} onSet={onSet} />
      <button className="text-loki-accent text-xs" onClick={() => onSet("days", data.days + 1)}>+1 day</button>
    </div>
  );
}
```

- Must `export default` a React component. Props: `{ data, onSet }`.
- `onSet(path, value)` writes a dot-path into `data`. Use it for every user
  interaction; never keep interactive state only in React. The write is what
  makes the gesture visible to you.
- You never position widgets. New files are placed automatically in free space
  next to what is already there; the user can tidy the desk with one click.
- You never set a width either. A frame sizes itself to your content up to about
  760px, then reflows below that; the user can drag a frame's corner to pin a
  size. So author fluid content: no fixed pixel widths, no wide fixed grids that
  assume a big canvas. Let text wrap, size things in % or rem, and a single
  readable column beats a poster that only fits on a wide screen. Content wider
  than the frame scrolls rather than being clipped, but scrolling is a fallback,
  not a layout.
- Compose `@loki/kit` components where they fit. Tailwind classes work.
  Prefer the tokens: `bg-loki-panel text-loki-fg text-loki-muted text-loki-accent
  text-loki-positive text-loki-negative`, or CSS vars `--loki-*`. The accent is the
  link / interactive blue (links, toggles, the one series in a chart). Red
  `bg-loki-attention text-loki-on-attention` is only for a badge that needs the
  user; green `bg-loki-affirm text-loki-on-affirm` fills the one go button.
  Use the sans reading face; `font-loki-mono` only for code and raw data.
- No network calls from widgets. Data comes from you, through the file.

## How you hear back

- **Automatically:** what the user did on the desk since your last turn (moves,
  slider values, checkboxes, closes, render errors) is appended to their next
  message inside `<loki-desk>` tags.
- **On demand:** `desk_state` returns every widget with its data *as the user
  left it*, its position, and any build or runtime `error`.
- **Camera:** `loki_camera({ widgetId })` glides the user's view to a widget;
  `{ widgetIds: [...] }` frames several together. Targets are highlighted
  briefly. New files glide automatically.
- **In the thread:** each widget you add, change or remove shows as a line in the
  user's Messages tab; clicking it opens the Desk tab on that widget. No need to
  narrate where a widget went.

There is no `loki_render` or `loki_author` tool. If you remember them from an
earlier version, forget them: write the file.

## After writing a widget

Call `desk_state`. If the widget has an `error`, fix the file and check again.
A syntax error is caught before the tab sees it; a runtime error shows in the
widget's frame and in `error`.

## Rules

- No real money amounts on screen, in files, or in recordings. Synthetic
  finances only. Real data in safe domains only (travel, chores, sleep, gym).
- A widget the user minimised sits in the desk tray; its file still exists and
  `desk_state` marks it `minimisedByUser`. Rewrite the file if you want it back.
  A widget the user trashed is gone: its file was deleted.
- Write only inside the widgets directory. The loki repo itself is the desk,
  not the furniture.

## Tasks for later: the board (`loki_task`)

The user keeps a board of tasks for later (beads, one board shared by every agent
and folder; the loki app shows it). You touch it only through `loki_task`, never
with `bd` directly, and only when asked — "park this", "make a task for…", "file
the follow-ups" — or when you are wrapping up with explicit follow-ups. Never
file tasks silently in the middle of unrelated work.

```
loki_task { action: "create", title, description, labels?, priority? }   → { filed: "lk-…" }
loki_task { action: "list", all? }         tasks assigned to this conversation, or filed here unassigned (all: every open task)
loki_task { action: "comment", id, text }  progress note
loki_task { action: "close", id, reason }  done
```

- Title: one imperative line. Description: what, why, where to look — enough for
  someone starting cold. Priority 0 (urgent) to 4 (someday), default 2. The
  source conversation, desk and folder are stamped for you; the folder's name
  becomes a label.
- Always tell the user the id you filed.
- When the user assigns tasks to your conversation from the board, they arrive
  inside `<loki-tasks>` on their next message. Pick one up when the message is
  about it or when asked to work the board; otherwise acknowledge in a line and
  carry on. Close it through `loki_task` when done.
