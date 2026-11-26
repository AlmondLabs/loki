---
title: Cursor as a built-in ACP agent
date: 2026-10-29
status: active
---

# Cursor as a built-in ACP agent

## Why

pi-ai has no sign-in for Cursor, so loki's own models can't use a Cursor subscription. Cursor's CLI speaks ACP
(`cursor-agent acp`), so a chat can run on it the way it runs on Claude Code (plan 020), with the models Cursor offers
and the person's own Cursor login.

It can already be added by hand in Settings › Engines, but it doesn't work: Cursor opens no session until the client
calls ACP `authenticate` with its `cursor_login` method, and loki never calls `authenticate`. `session/new` fails with
"Authentication required" even when the person is logged in.

Grok Build (`grok agent stdio`) has the same `authenticate` step, but it isn't built in: pi-ai already signs in to xAI
(a device-code login with the `grok-cli:access` scope), so Grok models work on loki's own models. Once `auth_method`
exists, Grok Build can still be added by hand.

Checked on this Mac, Cursor CLI 2026.06.19: `initialize` lists `cursor_login`; `authenticate` with it answers in about
15 seconds; `session/new` then returns Agent, Plan and Ask modes and a `model` config option with Cursor's models, which
loki already reads.

## What changes

1. **`auth_method` on an agent** (`daemon/acp/agents.ts`): the method loki asks the agent to sign in with, by ACP
   `authenticate`, right after `initialize`. Optional, so an agent without it starts as before. It's kept in
   `state/acp.json` like the other fields.
2. **`login` on an agent**: the command the person runs to sign in, shown in Settings › Engines when the agent says it
   is signed out (`claude /login`, `cursor-agent login`).
3. **Cursor built in** beside Claude Code: `cursor-agent acp`, `auth_method: "cursor_login"`. Like Claude Code, an entry
   with its id in `state/acp.json` overrides it, and **reset** puts it back.
4. **An agent whose command isn't installed and that has never run stays out of the model picker**, so Cursor isn't a
   quick pick on a Mac without it. Settings › Engines still lists it as not found.
5. **Editing an agent keeps the fields the form doesn't show** (`env`, `auth_method`, `login`).

## Checked

1. The fake agent, set to need `authenticate`, opens no session without `auth_method` and works with it.
2. A real `cursor-agent acp` through `AcpProcess` signs in (about 4 seconds), opens a session and answers a prompt on
   Auto. On a Free Cursor plan, Cursor's default model (Composer) answers "Upgrade your plan to continue", or the error
   `RetriableError: WritableIterable is closed`, as the turn's reply; picking Auto or a Grok model in the picker
   works. `--trust` isn't needed.
3. The picker leaves out an agent whose command isn't found until it has run.
