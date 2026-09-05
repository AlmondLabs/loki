---
name: loci
description: Furnish the user's loci canvas (browser widget desk) by writing widget files. Use when the user asks to see something on the canvas/desk, to visualize data, to add a control they can operate, or when a live visual beats prose. Also use to read what the user did on the desk.
---

# loci — the desk is a directory

The canvas is a browser tab that renders files. There is no render tool. To put
something on the desk, write a file. To change it, edit the file. To remove it,
delete the file. Vite hot-reloads the tab within a second.

```text
~/.letta/loci/widgets/<desk>/<name>.json    # a kit widget
~/.letta/loci/widgets/<desk>/<name>.tsx     # a custom React widget
~/.letta/loci/widgets/shared/…              # widgets that belong to no conversation
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
import { Stat } from "@loci/kit";

export const title = "Trip budget";                    // title bar; defaults to the file name
export const data = { days: 5, spent: [10, 20, 5] };   // initial data, optional

export default function Widget({ data, onSet }: { data: any; onSet: (path: string, value: unknown) => void }) {
  const total = useMemo(() => data.spent.reduce((a: number, b: number) => a + b, 0), [data.spent]);
  return (
    <div className="grid gap-2">
      <Stat data={{ value: total, label: "spent", unit: "units" }} onSet={onSet} />
      <button className="text-loci-accent text-xs" onClick={() => onSet("days", data.days + 1)}>+1 day</button>
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
- Compose `@loci/kit` components where they fit. Tailwind classes work.
  Prefer the tokens: `bg-loci-panel text-loci-fg text-loci-muted text-loci-accent
  text-loci-positive text-loci-negative`, or CSS vars `--loci-*`.
- No network calls from widgets. Data comes from you, through the file.

## How you hear back

- **Automatically:** what the user did on the desk since your last turn (moves,
  slider values, checkboxes, closes, render errors) is appended to their next
  message inside `<loci-desk>` tags.
- **On demand:** `desk_state` returns every widget with its data *as the user
  left it*, its position, and any build or runtime `error`.
- **Camera:** `loci_camera({ widgetId })` glides the user's view to a widget;
  `{ widgetIds: [...] }` frames several together. Targets are highlighted
  briefly. New files glide automatically.

There is no `loci_render` or `loci_author` tool. If you remember them from an
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
- Write only inside the widgets directory. The loci repo itself is the desk,
  not the furniture.
