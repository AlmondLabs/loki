# Security

loki is a local desktop app. Everything it talks to is on your machine.

## What runs where

- **The shell** (`src-tauri`, Rust) opens a window, finds or starts a Letta harness, and relays
  app-server frames between the page and that harness over a loopback WebSocket. The page never holds
  the harness token; the Rust side sends it as a bearer header.
- **The mod** (`mod/`, TypeScript) runs *inside* the Letta harness with that process's privileges. It
  serves widget files and desk state on `127.0.0.1:41414` (`LOKI_PORT`). Every request, HTTP or
  WebSocket, must carry the token from `~/.letta/loki/token` (mode 0600, generated once). Requests
  without it get 403.
- **The page** (`app/`, React) runs in the system WebView at `tauri://localhost`. Its only Tauri
  permissions are the core defaults, set-title, hide, and opening URLs in the system browser (see
  `src-tauri/capabilities/default.json`). It cannot read files or run programs.

## Agent-written code

The point of loki is that your agent writes widgets: `.tsx` files under `~/.letta/loki/widgets/`. The
shell transpiles them on request at `loki://localhost/widgets/…` and the page runs them. **A widget runs
with the page's privileges**, which means: it can call the mod with the page's token (desk state, other
widgets' files) and reach the network (`connect-src https:`), but nothing outside the WebView. Treat
widgets the way you treat the agent's shell commands: the permission mode you choose per conversation
(strict, standard, accept edits, unrestricted) governs whether the agent may write files at all.

The page's Content Security Policy (in `src-tauri/tauri.conf.json`) allows scripts only from the app
itself and the `loki://` transpiler: no remote scripts, no `eval`.

## What loki downloads

Only when the Mac has no Letta Code: the current Node 22 tarball from nodejs.org, verified against
`SHASUMS256.txt` from the same site, and `@letta-ai/letta-code` at the pinned release from
registry.npmjs.org (npm verifies package integrity). Both land under the app's data directory. No other
downloads, ever; no telemetry.

## What loki reads

- Letta's local backend under `~/.letta/` (agents, conversations, memory filesystems, pins,
  permission modes), read-only except for pins and the files it owns under `~/.letta/loki/`.
- The board in `~/.letta/loki/board` through the `bd` binary.
- Nothing is uploaded, logged remotely, or telemetered. The only network traffic is what your agent's
  provider connection and widgets initiate.

## Reporting

Open a private security advisory on the repository (Security → Report a vulnerability). Please do not
include tokens, transcripts, or agent memory files in the report.
