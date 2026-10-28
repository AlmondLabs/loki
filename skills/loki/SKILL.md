---
name: loki
description: Furnish the user's loki canvas by writing widget files. Use when the user asks to see something on the canvas (older chats call it the desk), to visualize data, to add a control they can operate, or when a live visual beats prose. Also use to read what the user did on the canvas.
---

# loki — the canvas is a directory

loki (the app, or a browser tab) renders files: each conversation is a **chat**, and
its canvas is the chat's **Canvas** tab, beside the **Messages** tab that shows the
conversation. "Desk" is the old name for both; if the user or your memory says desk,
they mean the chat's canvas. There is no render tool. To put something on the canvas,
write a file. To change
it, edit the file. To remove it, delete the file. The canvas picks up the change
within a second.

```text
~/.loki/widgets/<desk>/<name>.json    # a kit widget
~/.loki/widgets/<desk>/<name>.tsx     # a custom React widget
~/.loki/widgets/shared/…              # widgets that belong to no conversation
```

`<desk>` is this conversation's canvas id. `canvas_read` returns it as `desk` and
the absolute directory as `widgets_dir`. Call `canvas_read` first if you do not
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
  next to what is already there; the user can tidy the canvas with one click.
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
- No network calls from widgets. Data comes from you, through the file. Each
  `.tsx` widget runs in its own sandboxed frame, so this is enforced: `fetch`,
  WebSockets, `localStorage`, cookies, popups and reaching the page are all
  blocked. A widget has its `data`, `onSet`, React, recharts and `@loki/kit`;
  `https:` images and links work (a link opens in the browser).

## How you hear back

- **Automatically:** what the user did on the canvas since your last turn (moves,
  slider values, checkboxes, closes, render errors) is appended to their next
  message inside `<loki-desk>` tags.
- **On demand:** `canvas_read` returns every widget with its data *as the user
  left it*, its position, and any build or runtime `error`.
- **Camera:** `canvas_focus({ widget_id })` glides the user's view to a widget;
  `{ widget_ids: [...] }` frames several together. Targets are highlighted
  briefly. New files glide automatically.
- **In the thread:** each widget you add, change or remove shows as a line in the
  user's Messages tab; clicking it opens the Canvas tab on that widget. No need to
  narrate where a widget went.

There is no `loki_render` or `loki_author` tool. If you remember them from an
earlier version, forget them: write the file.

## After writing a widget

Call `canvas_read`. If the widget has an `error`, fix the file and check again.
A syntax error is caught before the tab sees it; a runtime error shows in the
widget's frame and in `error`.

## Rules

- No real money amounts on screen, in files, or in recordings. Synthetic
  finances only. Real data in safe domains only (travel, chores, sleep, gym).
- A widget the user minimised sits in the canvas tray; its file still exists and
  `canvas_read` marks it `minimised_by_user`. Rewrite the file if you want it back.
  A widget the user trashed is gone: its file was deleted.
- Write only inside the widgets directory. The loki repo itself is the easel,
  not the painting.

## Work for another chat: suggestions (`chat_list`, `suggestion_*`)

When a piece of work, a side finding or part of the current task, would be done
better in another chat (a themed chat it belongs to, another agent, or a new chat
running in parallel), suggest a message for that chat. Never suggest work you can
do in this chat. The person sends it, saves it as a draft there, or rejects it;
you never send it yourself, and no suggestion asks for approval.

```
chat_list { filter? }                  agents with their Mac, and open chats one line each (purpose, folder, labels, this chat)
suggestion_create { title, text, target }   → "suggested sugg-…"; target { agent_id, conversation_id } or { agent_id, folder }
suggestion_list {}                     this chat's suggestions: status and the chat each now points at
suggestion_withdraw { id }             take back one the person has not acted on
```

- Call `chat_list` first to pick the target, and `suggestion_list` to avoid a repeat.
- One piece of work per suggestion. The text stands alone, as if the person typed
  it there: what to do and why, with absolute paths.
- Name the suggestion in one line of your reply.
