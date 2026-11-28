# Plan: Fix Subagent Thread Reloading and Multi-Worker Navigation

## Context

1. Opening a subagent conversation loaded history into `ChatStore`, which displayed briefly before disappearing behind `"Loading the thread…"`. Subagent chats are hidden (`hidden: true`, `subagent_for: parentChatId`), so `listConversations()` excludes them. Live subagent events triggered an unknown-chat `reload()`, and `pruneUnknownKeys()` deleted subagent keys from `liveMap` and `threadsRead` whenever the conversation list changed.
2. Desktop multi-subagent navigation was obscured and lacked keyboard/step controls: the Workers panel used `loki-canvas-pane-messages`, pulling `.loki-workers-bar` and `.loki-worker-meta` underneath the floating `.loki-pane-header`. Desktop also had no keyboard shortcuts or Prev/Next step controls, and phone had no sibling switcher bar when viewing a worker chat.

## Changes

- **`core/attention/chat-store-helpers.ts`, `core/attention/chat-store.ts`**: Recognize subagent keys as known whenever their `parentChatOfSubagent` parent chat is in `known`; preserve subagent keys across `pruneUnknownKeys()` while the parent exists; avoid scheduling unknown-chat reloads for live subagent events; prune child subagent keys when archiving or removing the parent conversation.
- **`app/src/workspace/canvas-pane.tsx`, `app/src/components/components.css`**: Use `loki-canvas-pane-workers` on the Workers panel so it sits below `.loki-pane-header`.
- **`app/src/workspace/pane.ts`, `app/src/shell/keymap.ts`, `app/src/shell/shell.tsx`, `app/src/workspace/workers-pane.tsx`, `app/src/chat/chat.css`**: Add `activeWorkerChat` / `stepWorkerChat` helpers, `worker.toggle` (`⌘\`), `worker.prev` (`⌘⇧[`), `worker.next` (`⌘⇧]`), arrow/Home/End navigation and horizontal scrolling in the Workers pill bar, and Previous/Next Worker buttons with an `n / total` indicator when multiple workers exist.
- **`app/src/chat/workers-header.tsx`, `app/src/phone/conversation-screen.tsx`, `app/src/phone/phone.tsx`**: Render a scrollable sibling worker switcher in `WorkersHeader` when viewing a subagent chat on phone, replace history route when switching siblings so Back returns to the parent chat, and subscribe to the parent chat on deep links/reloads.

## Verification

- `bun run format:check`, `bun run lint`, `bun run typecheck`
- `bun run test` (including `test/chat-store.test.ts`, `test/canvas-pane.test.ts`, `test/keymap.test.ts`, `test/workers-ui.test.ts`, `test/tokens.test.ts`), `bun run test:node`, `bun run build:app`, `bun run build:mod`, `bun run smoke`
