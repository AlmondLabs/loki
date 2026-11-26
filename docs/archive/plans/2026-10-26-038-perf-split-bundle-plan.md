---
title: Load each surface, the chart and Preferences when they are used
date: 2026-10-26
status: active
---

# Load each surface, the chart and Preferences when they are used

## Why

The audit of 2026-10-25 (plans 032, 033 and 035 took its first three parts) found the app is one script of 1.83 MB
(585 KB gzipped) that every client loads and parses before anything shows:

1. **Both surfaces, everywhere.** `app/src/boot.tsx` imports the desktop `Shell` and the phone's `Phone` and mounts
   one of them, so a phone parses the whole desktop and the desktop the whole phone.
2. **The chart library for one card.** `recharts` (with `es-toolkit`, `decimal.js-light` and `@reduxjs/toolkit`, which
   it brings) is the largest package in the script, bigger than `react-dom`. The page reaches it through the widget
   kit (`app/src/kit/index.tsx`) for `ChartCard` alone, which most canvases never show.
3. **Preferences before anyone opens it.** The Settings sheet and its pages (and `qrcode`, for pairing a phone) load at
   start, though it is opened now and then.

## What changes

1. **`boot.tsx` imports only the surface it mounts** (`import()` of `shell/shell` or `phone/phone`), so each is its own
   chunk and what they share is a third.
2. **`ChartCard` draws its chart from its own module** (`app/src/kit/chart-view.tsx`), loaded the first time a chart
   card shows, behind a `Suspense` holding the card's height so nothing jumps. The widget frame's runtime is bundled
   whole by esbuild (`app/src/frame/build.ts`, no splitting), so there the import stays inline, and widgets that import
   `recharts` themselves get it at once as before.
3. **Preferences loads when it opens** (`lazy` in `app/src/shell/views.tsx`). The parts of Settings that Welcome and
   ⌘K search use stay in the desktop chunk.

Nothing on screen changes, except that the first chart card on a canvas, and the first opening of Preferences, wait
for their chunk: read from disk in the Mac app, from the Mac over the network on a phone.

## Not in this change

1. **The widget frame.** Every widget's sandboxed iframe still loads its own 793 KB runtime (React, ReactDOM,
   `recharts` and the kit, inlined because a sandboxed frame cannot fetch from the page's server), and the Canvas
   tab's frames stay mounted behind the Messages tab. Sharing that runtime or mounting frames only when seen changes
   how widgets live, so it gets a plan of its own.
2. **Other sections** (Agents, Tasks, Learn) are smaller and opened often; splitting them saves little against a
   wait on each first open.

## Measured

`npm run build:app` before and after, and what a client loads before it draws (the entry, `boot`, the surface it
mounts, and every chunk those import statically):

|                       | before                | after                 |
| --------------------- | --------------------- | --------------------- |
| the desktop at start  | 1,828 KB (585 gzipped) | 1,097 KB (365 gzipped) |
| a phone at start      | 1,828 KB (585 gzipped) | 979 KB (324 gzipped)  |
| the chart, when shown | (at start)            | 398 KB (115 gzipped)  |
| Settings, when opened | (at start)            | 109 KB (37 gzipped)   |

What every client still loads at start is what drawing needs: `react-dom` (541 KB before minifying), the chat and
its markdown, and the surface itself.

The widget frame's runtime grows from 793 KB to 813 KB: esbuild bundles the chart's `import()` into it (as a
`Promise.resolve()`, so the frame still fetches nothing), and wraps the module to run it later. That is the price of
one kit for the page and the frame; the frame's own plan (above) is where its size is dealt with.

## Tests

`test/bundle-split.test.ts`: `boot.tsx` imports neither surface statically and loads both by `import()`; the kit
reaches `recharts` only through `chart-view.tsx`; `views.tsx` loads the Settings sheet by `import()`; a chart card
renders a placeholder of the chart's height while its chart loads. A build is the real test of the split, so the
sizes above were read from one.
