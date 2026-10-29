---
title: The error in words, and lint that keeps one way per job
date: 2026-10-30
status: active
---

# The error in words, and lint that keeps one way per job

## Why

Plan 054 gave three jobs one helper each, but nothing stops a copy from being written again. One already was:
`savedDrafts` in `core/attention/use-attention.ts` kept its own listener set. Plan 054's conversion never applied to
it (the script that did the conversions stopped partway through), though #168 listed it among the converted ones. A
fourth job had the most copies of all: the error turned into words, `err instanceof Error ? err.message : String(err)`,
written out 68 times in 45 files, and a private `messageOf` in two of them.

## What changes

1. **`core/errors.ts`**: `messageOf(err)`, used in place of all 68 copies and the two private ones. The app's console
   forwarder (`app/src/desk/env.ts`) uses it for an Error too.
2. **`savedDrafts`** uses `Listeners`.
3. **Two lint rules** (`no-restricted-syntax` in `eslint.config.mjs`, over `core/`, `daemon/`, `mod/` and `app/src/`):
   - a `new Set` of callbacks points to `Listeners`;
   - the error-to-words expression points to `messageOf`.
4. **`docs/architecture.md`**'s "One way per job" names `messageOf` and says which jobs lint checks.

## Left as it is

1. **Hand-written serial queues and burst timers** stay a convention: `p.then(resolve, reject)` and an ordinary
   timer have the same shape, so a selector would catch legitimate code.
2. **Two places that wrap an error, not word it**: `daemon/providers.ts` and `mod/lan.ts` turn an unknown into an
   `Error`, which is a different job.
3. **Build scripts and the Vite config** are outside the rule: they do not import from `core/`.

## Checked

1. A probe file with one of each copy fails lint with each rule's message; the tree passes.
2. The whole suite runs unchanged.
