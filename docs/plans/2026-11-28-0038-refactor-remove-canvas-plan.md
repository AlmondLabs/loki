# Plan: Completely Remove the Canvas & Widget System

Remove loki's 2D canvas, sandboxed widget runtime/compiler, widget file watcher, canvas layout persistence, canvas wire frames, `<canvas>` prompt section, and widget-only dependencies (`react-zoom-pan-pinch`, `recharts`, and runtime `esbuild` in Electron), leaving loki's linear **Messages**, **Workers**, **Flow**, **Memory**, **Learn**, **Agents**, and **Phone** workflows intact and leaner.

## Architecture Changes
- **`core/chat-scope.ts`**: Extract shared chat-scope utilities (`Scope`, `SHARED_SCOPE`, `MAIN_CHAT_ID`, `MAIN_SCOPE_PREFIX`, `isMainChat`, `mainChatAgent`, `scopeFor`, `backendName`, `conversationDirName`) from `core/canvas-core.ts` and remove all layout/gesture/widget types and math.
- **`core/frames/` & `mod/frames/`**: Remove canvas/widget frames (`gesture`, `measure`, `arrange`, `trash`, `widget_status`, `canvas_get`, `canvas`, `state`, `widgets`, `camera`, `widget_change`, `BY_SCOPE`, `widget_log` on `history`, `widgets` on `peer_chat` and `ChatSummary`). Relocate `chats_list`, `pin_set`, `models_recent_add`, `chat_meta`, `switch_chat`, `chats`, `models_recent`, `models_usual` into `core/frames/chats.ts` and `mod/frames/chats.ts`. Add `agent_id` to `chat_meta` and emit `chat_meta` in `welcomeFrames()` on connect.
- **`daemon/` & `mod/`**: Delete `mod/canvas-store.ts`, `mod/widgets-fs.ts`, `mod/widget-log.ts`, `mod/persist.ts`, `mod/frames/canvas.ts`. Remove `canvas_read`, `canvas_focus`, `<canvas>` prompt section, `canvas` script namespace, `widgetsDir` approval exemption, `paths.widgets`, and Learn lesson widget generation.
- **`app/`, `desktop/`, `site/`, `skills/loki/`**: Remove 2D canvas surface/viewport/camera, widget iframe host/compiler (`app/src/frame/`, `desktop/scheme.ts` `/widgets/` route), `@loki/kit`, inline widgets, floating chat drawer (`chat-window.tsx`, `use-chat-layout.ts`, Settings "Chat panel"), `skills/loki/`, and `site/src/hero-canvas.tsx`. Keep `Messages` and `Workers` tabs in `CanvasPane`, showing tabs only when a chat has workers.
- **Dependencies & packaging**: Remove `react-zoom-pan-pinch` and `recharts` from `package.json`, and stop copying/unpacking `esbuild` into the Electron desktop bundle (`scripts/build-desktop.ts`, `electron-builder.yml`).

## Verification
- Format, lint, typecheck, `build:app`, `build:site`, `build:mod`, `build:desktop`, full Vitest suite, Node tests, and `smoke`.
