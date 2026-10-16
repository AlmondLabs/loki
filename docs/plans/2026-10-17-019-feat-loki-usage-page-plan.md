---
title: Usage Page - Plan
type: feat
date: 2026-10-17
topic: usage-page
execution: code
---

# Usage Page - Plan

## Goal

- **Objective:** The person can see what their agents cost and where it goes, without a terminal: how much over a
  day, a week, a month or three, which agents and models spent it, and how much went to loki's own background work
  (reflection, Learn, the memory review) rather than to their chats.
- **Means:** The daemon keeps a small hourly ledger of every model call's tokens and cost, fed by the totals
  pi-durable already keeps per chat. A new Preferences page, **usage**, reads it over the mod's socket; the phone
  shows the same page under More.
- **Inspiration:** t3code's Usage view (pingdotgg/t3code, `docs/user/usage.md`): cost and tokens by period, split
  by token type, cache savings, a model breakdown, all labelled as estimates. Its pooled subscription limits, hub
  accounts and custom prices are out of scope here (Scope Boundaries).
- **Execution profile:** One branch per unit, `feat/usage-…`, each its own PR with every check run on CI's toolchain.

## Problem Frame

Every model response already carries its token counts and cost: pi-ai prices each call from its model table
(`usage.cost.input`, `output`, `cacheRead`, `cacheWrite`, `total`), pi-durable adds them into each chat's
`pi.usage` document by model and by tool, and the daemon writes a `turn_finished` line per turn into
`~/.loki/logs/events.jsonl` with the turn's tokens and total cost. None of it reaches the screen. The only way to see
spend is `npm run analytics` in a terminal, and nobody can see what the background passes cost, which is the
question their always-on design raises.

## Decisions

- **KD1. A Preferences page, not a rail section.** Usage is checked now and then, not daily, so it does not earn a
  rail spot; ⌘K finds it like any page. It sits second, after **loki**. The phone gets it under More. (user-directed,
  2026-10-17: chosen over a rail section, a tab on Agents, and Preferences plus a line on each agent's profile.)
- **KD2. Dollars show plainly, and R9 is narrowed.** The house rule "no real money amounts on screen, in the repo, or
  in recordings" (plan 001 R9) exists to keep the person's own finances out of widgets, fixtures and recordings.
  Model spend is the stated exception: the Usage page shows estimated dollars. Fixtures and tests still use made-up
  numbers. (user-directed, 2026-10-17: chosen over hiding amounts until asked and over tokens and shares only.)
  R9's wording changes in the same PR as the page, everywhere it appears: `docs/plans/2026-09-01-001-feat-loki-plan.md`
  (a dated note, not a rewrite), `docs/design.md`, `docs/CONTRIBUTING.md`, `docs/manual.md` and `README.md`.
- **KD3. Estimates, labelled as such.** The figures are what the same calls cost at the provider's API prices, from
  pi-ai's model table. A ChatGPT or other subscription sign-in is billed by plan, not per token, so the page says
  "est." and the manual says what that means. A model pi-ai has no price for counts its tokens and shows its cost as
  unknown, never as zero.
- **KD4. The ledger is the daemon's own file, fed by `pi.usage`, not by analytics.** `turn_finished` has the time
  and the origin but only the total cost, misses compaction's model calls, and is switched off with
  `LOKI_ANALYTICS=0`; the Usage page is the person's own record and must not depend on product analytics. `pi.usage`
  counts every call (turns, helpers, compaction) with cost split by category, but per chat with no time. So the
  daemon watches each store's commits (as `daemon/telemetry.ts` already does) and, when a chat's `pi.usage` grows,
  adds the difference to the current hour's row in `~/.loki/state/usage.json`, remembering each chat's last totals.
- **KD5. A row is one hour, one agent, one model, one origin.** Origin is the chat's kind: **chats** (the person's
  chats, scheduled prompts and background notices included), **helpers** (subagent conversations), **reflection**,
  **learn** and **doctor** (the passes' hidden chats). Hours are UTC, so the client buckets days in its own time
  zone. Rows older than 400 days are dropped, which keeps the file small (a few thousand rows a year).
- **KD6. History before the ledger comes from `events.jsonl`, once.** On the first start with the ledger, the
  daemon seeds it from the `turn_finished` lines it can read (tokens, total cost, agent, model, origin, time), and
  records every chat's current `pi.usage` as already counted, so nothing is counted twice. Seeded hours have a total
  cost but no split by category; the page shows that part as **other**. Days before analytics existed, or with it
  switched off, are simply empty.
- **KD7. Cache savings are computed, not stored.** For each row the daemon also stores what the cache reads would
  have cost as plain input (cache-read tokens at the model's input rate); savings are that minus what they did cost.

## Requirements

- R1. Preferences › **usage** shows, for the past 24 hours, 7, 30 or 90 days (7 by default, remembered per device):
  the estimated total cost, total tokens, and a chart by day (by hour for 24 hours).
- R2. Tokens are split into input, cache read, cache write and output; reasoning is shown as part of output, never
  added on top.
- R3. Cost is split by the same categories, plus **other** for seeded history (KD6). Cache savings show beside it.
- R4. Breakdowns by **agent**, **origin** (KD5) and **model**, each sorted by cost, each row with its cost, tokens and
  share. Choosing a row filters the page to it; the filter shows as a chip with ×.
- R5. A model with no known price shows "no price" for its cost and is left out of the totals, with a line under the
  total saying how many tokens that is.
- R6. The page updates while it is open: a new hour's calls appear within a few seconds of their turn ending.
- R7. The phone shows the same figures under More › **Usage**, sentence case, one column.
- R8. Words on screen follow docs/style.md §6: desktop lowercase ("usage", "by origin", "est."), phone sentence case,
  no exclamation marks.
- R9. Nothing leaves the machine: the ledger is a local file, read only by the daemon and the app.

## Scope Boundaries

- Not in scope: subscription limits and reset windows (pi-ai exposes none), several accounts or machines, custom
  prices and model mapping, a per-agent line on the Agents profile (KD1's alternative; easy to add later as a link
  into this page with a filter), exporting the data.
- Not changed: `turn_finished`, `npm run analytics`, and `pi.usage` itself.

## Mechanism

- **Frame.** `usage_summary { since_day, until_day, time_zone }` → `{ rows: UsageRow[], models: { [model]: { priced:
  boolean } }, seeded_until: string | null }`. Rows come back hourly and the app buckets them, so the time zone is
  only for the server to trim the edges. A push, `usage`, tells open pages that the current hour changed.
- **`UsageRow`** (core, snake_case as loki's data is): `hour` (ISO, UTC), `agent_id`, `model`, `origin`,
  `input_tokens`, `cache_read_tokens`, `cache_write_tokens`, `output_tokens`, `reasoning_tokens`, `cost` (`input`,
  `cache_read`, `cache_write`, `output`, `other`, `total`) and `cache_read_as_input`. There is no call count:
  pi-durable's totals count tokens and cost, not calls.
- **Where the code goes.** `daemon/usage.ts` (the ledger: diffing `pi.usage`, rows, pruning, the seed), wired in
  `daemon/main.ts` beside the telemetry; the frame in `core/frames.ts` and `mod/frames/`; the pure bucketing and
  breakdowns in `core/usage.ts` so desktop and phone share them; the page in `app/src/settings/usage.tsx` and the
  phone screen in `app/src/phone/usage.tsx`.

## Units

1. **The ledger** (`daemon/usage.ts`, tests): follow every store's commits, diff each chat's `pi.usage` against its
   last totals, add to the hour's row, save `state/usage.json` (debounced), prune past 400 days. Tests with a faux
   model: a turn, a helper, a compaction and a reflection run each land in the right origin; a restart counts
   nothing twice; a model without a price is marked unpriced.
2. **The seed** (`daemon/usage.ts`, tests): read `events.jsonl` and `events.jsonl.1` once, turn `turn_finished`
   lines into rows with their cost as **other**, mark every chat's current totals as counted, record `seeded_until`.
3. **The frame and the shared model** (`core/usage.ts`, `core/frames.ts`, `mod/frames/`): `usage_summary` and the
   `usage` push; bucketing by day in a time zone (DST included), breakdowns, shares, the unpriced line. Tests for
   each.
4. **The desktop page** (`app/src/settings/usage.tsx`, `pages.ts`, search): R1–R6 and R8, on the design scales
   (`test/tokens.test.ts`). Screenshots in the PR use made-up numbers.
5. **The phone screen and the docs** (`app/src/phone/usage.tsx`, More): R7. The manual's Settings list gains
   **usage**; R9 is narrowed everywhere it appears (KD2); architecture.md names the ledger.

## Verification

- Each unit's tests, plus the full checks (format, lint, typecheck, test, test:node, both builds, smoke) on CI's
  toolchain, Windows included.
- By hand: run a few turns in two agents, one with a background pass due; open Preferences › usage and the phone's
  Usage; check the totals against `npm run analytics` for the same period (they differ only by compaction, which the
  ledger counts and `turn_finished` does not).
