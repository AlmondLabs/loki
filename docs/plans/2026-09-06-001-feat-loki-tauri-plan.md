# loki as a Tauri app — plan of record

Decided 2026-09-06 with Deepak: loki becomes a native macOS app (Tauri 2) around the
existing React canvas. The Letta harness stays the only other process; the mod stays
inside it. Vite, port discovery, the browser and (eventually) the tunnel go away.

## Shape

    loki.app (Tauri)                              letta server --listen … (harness, sidecar)
      Rust core ── bearer-token WebSocket ─────▶    app-server
        · supervises the harness                    loki mod (in-process, Node)
        · watches ~/.letta/loki/widgets,              · turn_start: attach gestures
          transpiles TSX → ESM (oxc), serves          · desk_state / loki_camera
          loki://widgets/…                            · desk layout + WS bridge (phase 1–2)
        · transcripts, folders, git branch, picker
        · tray · dock badge · global shortcut
      WebView: app/ as it is today

## Phases

- **P0 — the window.** Tauri scaffold in `src-tauri/`; the built app loads from `app/dist`;
  the webview talks to the mod's existing WS on 127.0.0.1:41414 (token read by Rust,
  injected at startup). Desktop keeps running the harness. *Milestone: the desk in a window.*
- **P1 — the link.** Rust holds the app-server socket with `Authorization: Bearer`, forwards
  frames to the webview as events, sends via a command. Finds Desktop's harness (lsof) or
  spawns `letta server --listen ws://127.0.0.1:41600/ws --ws-auth capability-token`. The
  tunnel and discovery leave the mod. *Milestone: chat and Catch Up without Vite or tunnel.*
- **P2 — widgets.** Rust watches the widgets tree, transpiles `.tsx` with oxc, serves
  `loki://widgets/<desk>/<name>.js`; React/kit reach widgets through an import map to shim
  modules backed by the app's own copies. Vite is no longer needed at runtime. Tailwind in
  widgets is dropped (kit + tokens). *Milestone: an agent-written widget appears in the app.*
- **P3 — native.** Menu-bar item and dock badge with the waiting count, global shortcut for
  Catch Up, launch at login, folder picker via Tauri dialog. *Milestone: badge and ⌥Space.*
- **P4 — the file bus (optional).** Gestures/layout/camera as files; the mod loses its server.

## Decisions

- D1 Tauri 2 + Rust, one window, dark, overlay title bar; identifier `dev.deepak.loki`.
- D2 The app-server socket lives in Rust (tokio-tungstenite), not a plugin: headers, reconnect,
  and one place to log the protocol.
- D3 Widget transpile: oxc (Rust-native). Fallback if oxc proves awkward: esbuild sidecar.
- D4 Never two harnesses on one backend: prefer an already-running Desktop harness; spawn our
  own only when none is found; stop ours on quit.
- D5 Vite stays for developing loki (`tauri dev` points at it); users never run it.
- D6 The React app stays framework-agnostic: an `env` layer decides mod URL, token, widget URL.

## Not doing

- Bundling the Letta CLI; loki finds `letta` on PATH (volta) and says so if missing.
- Signing/notarisation beyond ad-hoc for personal use.
