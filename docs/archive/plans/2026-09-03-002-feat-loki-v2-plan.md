---
title: Loki v2 — files as desk
type: feat
date: 2026-09-03
supersedes: 2026-09-01-001-feat-loki-plan.md
status: implemented (spike level); demo polish pending
---

# Loki v2 — files as desk

## Why

v1 proved the four risky integrations. The architecture review on 2026-09-03 found that most of it
existed to work around constraints that no longer hold:

- The build step existed because the plan assumed Letta's Node could not run TypeScript. Both the
  desktop app (Electron 38, Node 22.22) and the CLI strip types natively.
- The custom authoring pipeline (esbuild spawn, import map, vendor shims, `ModuleHost`, `moduleRev`)
  existed to hot-load agent code. A Vite dev server does exactly that, with HMR, for files the agent
  writes with the tools it already has.
- The store/patch protocol and `loki_render`/`loki_author` tools existed so the agent could express
  through a mod. Once the desk is a directory, the agent expresses by writing files, and the mod keeps
  only what a mod alone can do.

## Decisions (with Deepak, 2026-09-03)

- **D1. One desk per conversation**, created lazily on first widget, plus a `shared` desk. Rooms in
  one palace was rejected: hundreds of conversations make a single surface unnavigable.
- **D2. Return path = attach at `turn_start`.** Gestures since the last turn ride on the user's next
  message. `desk_state` remains for on-demand reads. Store-only and inject-immediately rejected.
- **D3. Files only.** No render tool. `.json` for kit widgets, `.tsx` for custom. Tools shrink to
  `desk_state` and `loki_camera`. The vocabulary moves into `skills/loki/SKILL.md`.
- **D3 note (2026-09-03, first live test).** Ira, whose memory is full of v1, called `loki_render` and Letta closed it as an unknown tool. Decision: no compatibility shims; a fresh conversation (and the skill's explicit "there is no loki_render") is the fix.
- **D4. Vite, not Next.** Same architecture; `import.meta.glob` discovers widget files across desks
  in one line, and a single-page canvas needs none of Next's server surface.
- **D5. No manual build.** The shim imports `mod/boot.ts`, which bundles the mod's own files with esbuild into a uniquely named file on every activate (node_modules external). Importing `mod.ts` directly was tried first and failed on `/reload`: Node's ESM cache kept every *imported* module stale even though the entry had a fresh query. Vite compiles the app on demand.
- **D7. Widget files live outside the repo** (`~/.letta/loki/widgets`). They are user data, they survive
  a reinstall, and Tailwind's scanner honors .gitignore so a gitignored in-repo folder can never be styled.
- **D6. Agent-owned vs server-owned split is load-bearing.** The agent owns file content. The mod
  owns geometry and a gesture *overlay* on data. The overlay is cleared when the file changes: the
  agent's write is the latest intent, and the gesture was already reported.

- **D8 (2026-09-03, evening). Chat rides Letta's app-server.** Letta's harness hosts a documented WebSocket
  protocol (`runtime_start`, `input`, `stream_delta`, `update_loop_status`). Verified live against Desktop's
  embedded server: an outside loopback client with no auth subscribed to a Desktop-driven conversation and
  received 314 stream events including 64 assistant token chunks. The mod discovers the server's random port
  among its own process's listening sockets (`lsof -p`), confirms it with `app_server_info`, subscribes per desk,
  and mirrors the transcript into the canvas chat with streaming. Canvas sends go in as `input` and are queued
  by Letta when busy. This retires the 1.2 s idle heuristic. The conversation-handle path stays as fallback.
  Considered and rejected for chat: custom channels (replies only via `MessageChannel`, no streaming).
- **Desktop limitation.** Inside Desktop the mod reports `events.lifecycle: false`, so `conversation_open`
  never fires and the tab does not follow conversation switches; `/canvas` carries the conversation id instead.

- **D9 (2026-09-03, late).** `loki_camera` frames one or many widgets, can dwell before returning, and targets
  glow for a few seconds. A `/tour` command was built and then dropped as unnecessary. The chat panel is
  full-height, fades to 12% when idle, and renders markdown. Also added today: ⌘K desk switcher with titles and
  archived/deleted status, closed-widget tray, Figma-style pan/zoom, dot grid.

- **D10 (2026-09-03, late). Placement.** New widgets take the first free spot (reading order, wrapping at a row
  width) given every rectangle already on screen; the tab reports rendered sizes via a `measure` message so the
  packing uses real heights. Shared widgets avoid every desk's widgets since they appear on all of them. An
  `arrange` action (button, ⌘⇧A) re-packs the current desk around the shared widgets and frames the result;
  it is reported to the agent as desk activity.

- **D11 (2026-09-04).** Frame controls: focus (client-side zoom-to, front, highlight), minimise (the old close;
  tray relabelled), trash (mod deletes the file; layout forgotten; reported to the agent). App-server discovery
  gained a `ps`-based route because `/usr/sbin` is not on a GUI app's PATH, which had silently dropped Desktop
  back to the conversation-handle chat.

- **D12 (2026-09-05). Catch Up.** An attention model in the mod subscribes to the last week's human
  conversations on the app-server (subagents filtered by "agent still exists" and "a human typed here"), folds
  control_request / loop status / turn_finished / deltas with the backend files, keeps seen markers, and answers
  approvals via `approval_response`. The canvas shows a count chip and a card deck (⌘⇧K). Verified on real
  traffic: 22 items classified, keyboard flow, seen persistence, count in the tab title.

- **D13 (2026-09-05). Catch Up moved to the browser.** The app-server exposes everything Catch Up needs
  (`agent_list` already hides subagents, `conversation_list`, `conversation_messages_list`, `runtime_start`,
  approvals), but refuses any unauthenticated upgrade with an Origin header, so browsers cannot connect directly.
  The mod now runs a dumb WebSocket tunnel at `/appserver` and a seen-marker store; the model, transcript
  parsing (`shared/harness.ts`), and the deck all live in the app and iterate on Vite's hot reload. `mod/attention.ts`
  was deleted.

## Shape

```text
agent ──Write/Edit──▶ ~/.letta/loki/widgets/<desk>/<name>.json|.tsx
                              │ fs.watch + esbuild syntax check        │ Vite HMR
                              ▼                                        ▼
                     mod: manifest, layout, overlay  ◀── WS /loki ──  canvas tab
                              │ turn_start                             gestures, errors
                              ▼
                     <loki-desk> block on the user's next message
```

## What was removed

`src/` (store, ws, server, author, tools, persist), `web/` (ModuleHost, vendor shims, import map),
`scripts/build.mjs`, `dist/`, `docs/kit.md`, the duplicated client reducer. Replaced by `mod/`,
`shared/desk-core.ts`, `app/`, `skills/loki/`.

## Open items before the clip

- Live verification in Letta Desktop: `/canvas`, HMR on a written widget, `turn_start` attach,
  chat, tab-follows-conversation.
- Seed desk in safe domains (R9 unchanged).
- Demo runbook.
- Canvas chat sends bypass `turn_start`; desk activity attaches only to app-side turns. Decide whether
  chat sends should carry it too.
- Packaging manifest (`package.json#letta`) once the demo is recorded.
