---
title: A website that lets people use loki before they install it
date: 2026-11-02
status: active
---

# A website that lets people use loki before they install it

## Why

loki has a README and no website. People deciding whether to install a desktop app for their agents want to see what
it is like to use, and a page of screenshots or a video tells them less than a minute of using it. The repository is
public, so GitHub Pages can host a site for free.

## What changes

1. **`site/`, a page built from loki's own components.** Its own Vite entry beside `app/`, importing the app's React
   components, tokens and stylesheets with made-up data and no daemon behind them. When the app's look changes, the
   next build of the site changes with it.
2. **Live demos, not pictures.**
   1. The hero puts a canvas beside the headline: kit widgets (a plan, a checklist, a slider, a chart, a stat) the
      visitor can drag, tick and slide, and the line "what you did rides along on your next message" shows what the
      agent would be told.
   2. The inbox section runs the real Inbox deck (`CatchUp`) over a handful of made-up chats: Next, Archive, Approve,
      an answer, a reply that the made-up agent answers by streaming a canned reply.
   3. The suggestions section runs the real suggestion cards over a chat whose agent suggests two messages: send
      now lands the message in its chat and that chat's agent answers, save as draft leaves it in that chat's box,
      change chat points it elsewhere (the app's own choices, without the search), reject drops it.
   4. The phone section runs the phone's own Inbox in a phone's outline over its own copy of the chats: swipe right
      for next, left to archive. The outline is transformed, so the phone's fixed layers stay inside it.
   5. The Learn section runs Learn's own list column and review deck over four made-up cards and two leads, with
      the real scheduler; starting a lead says what the app would open.
3. **Then what loki is built on**: four short facts (any model provider, memory you can read, on your own computer,
   open source) and the download again at the end.
4. **Published by a workflow.** `npm run build:site` builds to `site/dist`; `.github/workflows/site.yml` publishes it
   to GitHub Pages on every merge to `main` (Pages must be switched on once, in the repository's settings).

## Decisions for review

1. **The demo data is made up and generic**: agents, chats and people with invented names, nothing from a real
   machine, since the repository is public.
2. **The site follows `product.md`**: quiet, precise, the app's own look; no glassy dark SaaS chrome. What makes it
   rich is that it works.
3. **Kit widgets render directly on the page**, not in the app's sandboxed widget frame: the site's widgets are its
   own code, so the frame's isolation buys nothing, and the frame needs a server to compile widget files.
4. **Relative asset paths** (`base: "./"`), so the same build works at `almondlabs.github.io/loki/` and at a custom
   domain later.

## Tests

1. The made-up chat store answers the deck's reads, turns a reply into a streamed answer and carries out a
   suggestion's send, draft and change chat; the made-up Learn grades, deletes, restores and dismisses
   (`test/site-demo.test.ts`).
2. `npm run build:site` runs in CI, so a change to the app that breaks the site fails the PR.
