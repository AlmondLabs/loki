---
title: Archiving a chat the window has not opened
date: 2026-11-01
status: active
---

# Archiving a chat the window has not opened

## Why

Archiving a chat from the Inbox could fail every time, with only "not archived" on the card. The Inbox archives by the
chat's id, and the chat client has to find the chat's agent to name it on `chat_update`. It knows the agent of a chat
it has opened, created or sent to in this window; for the rest it asks `agentOf`, which read the chat list through a
closure made when the client was, before any list had come. So a chat not opened since the window loaded had no agent,
the client threw "which agent's chat is …?", and nothing reached the daemon.

## What changes

1. **The caller names the agent.** `archiveConversation` and the client's `updateConversation` take the chat's agent
   when the caller has it. The Inbox card, the sidebar row and the phone's list and chat all have it, so they pass it;
   the lookup is left for callers that do not.
2. **The lookup reads the list now.** `agentOf` reads the chat list through a ref kept current, the way `use-desk`
   already holds `desks` and `send`.
3. **A refusal says why.** The Inbox shows "not archived: <reason>" instead of "not archived".

## Tests

1. The client sends the agent it is given for a chat it has never met, and still refuses without one.
2. The store hands the agent through to the client on an archive and takes the chat off the list.
