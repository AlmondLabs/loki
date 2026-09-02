# loci widget kit — authoring API

The vocabulary for widgets on the loci canvas. Two consumers: `loci_render`
instantiates these types with data; authored modules (U6) compose the same
components in custom layouts.

## Contract

Every kit component receives:

- `data` — the widget's payload (shapes below). Lives in the desk store;
  the single source of truth on the mod side.
- `onSet(path, value)` — writes a dot-path into `data` and syncs it to the
  store. This is how user gestures become agent-readable state (`loci_state`).

Display components ignore `onSet`. Controls must write through it — never
hold interactive state only in React.

## Types

| type | data shape | notes |
|---|---|---|
| `info-card` | `{ lines: string[] }` | plain text lines |
| `stat` | `{ value, label?, unit?, delta? }` | big number; delta colors ▲/▼ |
| `slider-control` | `{ label, value, min, max, step?, unit? }` | writes `value` on release, not per-tick |
| `list-card` | `{ items: [{ text, done? }] }` | checkboxes write `items.N.done` |
| `chart-card` | `{ kind: "line"\|"bar"\|"area", points: [{ x, y }] }` | recharts; 180px tall |

## Design tokens

Use CSS variables, never hardcoded colors: `--loci-bg/panel/border/fg/muted/
accent/accent-soft/positive/negative`, `--loci-radius`, `--loci-font/mono`.
Light carries meaning: accent = interactive or agent-touched; muted = chrome;
positive/negative only for real valence, not decoration.

## Rules for authored widgets

- Compose kit components where possible; custom JSX where needed.
- All persistent state through `onSet`; assume the module can be remounted
  at any moment with fresh `data`.
- No network calls from widgets; data comes from the agent via the store.
- No real money amounts. Ever. (Synthetic finances only — repo hard rule.)
