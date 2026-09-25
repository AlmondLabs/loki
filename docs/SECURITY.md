# Security

loki is a local desktop app. Everything it talks to is on your machine — unless you switch on the phone
listener, described below.

## What runs where

- **The shell** (`src-tauri`, Rust) opens a window, finds or starts a Letta harness, and relays
  app-server frames between the page and that harness over a loopback WebSocket. The page never holds
  the harness token; the Rust side sends it as a bearer header.
- **The mod** (`mod/`, TypeScript) runs *inside* the Letta harness with that process's privileges. It
  serves widget files and desk state on `127.0.0.1:41414` (`LOKI_PORT`). Every request, HTTP or
  WebSocket, must carry the token from `~/.letta/loki/token` (mode 0600, generated once; on Windows the
  file is under `%USERPROFILE%` and relies on the profile folder's own permissions). Requests without it
  get 403.
- **The page** (`app/`, React) runs in the system WebView (WebKit on the Mac, WebView2 on Windows,
  WebKitGTK on Linux). Its only Tauri permissions are the core defaults, set-title, set-theme, hide,
  start-dragging (the title strip that moves the window), minimise, maximise, close and is-maximised (the
  window buttons loki draws on Windows and Linux), the system's folder dialog (`dialog:allow-open`, which
  hands back only the folder you pick), and opening URLs in the system browser (see
  `src-tauri/capabilities/default.json`). It cannot read files or run programs.

## The phone, over the LAN

Mac only for now: on Windows and Linux Settings › phone says pairing isn't there yet and offers no switch,
so the listener stays off.

Settings › phone puts a second listener on the local network so a phone can use loki (its Home, Inbox,
Agents and desk conversations). The model:

- **Off by default.** Nothing listens beyond loopback until you switch "reachable on this Wi‑Fi" on. The
  choice is persisted (`~/.letta/loki/state/lan.json`) and the rail shows a green dot on the settings
  icon while it is on.
- **The page's code is public while it is on.** The listener (`0.0.0.0:41415`) serves the canvas build to
  anyone on the same network, unauthenticated: that is the app's JavaScript and nothing else. Every
  *action* — the `/ws` and `/appserver` sockets, agent faces — needs a paired device.
- **Pairing.** "pair a phone" mints a six-character code (alphabet without 0/O/1/I) that lives ten minutes
  and is kept in memory only. `POST /pair {code, name}` on the LAN redeems it and answers with a
  per-device token in an `HttpOnly; SameSite=Lax` cookie, so the page's JavaScript never sees it.
  Only the token's SHA-256 is stored (`~/.letta/loki/state/devices.json`). A code may be redeemed more
  than once inside its ten minutes, each time as a separate device, because an iOS home-screen app has
  its own cookie jar and has to pair again after "Add to Home Screen".
- **Forget a phone in Settings.** Each device is listed with when it was last seen; "forget" deletes it
  and closes its sockets. `POST /unpair` from the phone does the same for itself.
- **Plain http.** A LAN `http://` origin is not a secure context, so there is no service worker and no
  TLS; the traffic — transcripts, approvals, your replies — is readable by anyone on the network path. On
  a network you do not trust (cafés, hotels, offices you do not run), do not switch it on; if you need
  the phone there, put both devices on a Tailscale network and use that route (below).

## The phone, over Tailscale

When Tailscale runs on the Mac, Settings › phone offers the tailnet as the route and the QR carries the
Mac's MagicDNS name. The model changes in one place:

- **The tailnet replaces the Wi‑Fi as the boundary.** The listener still binds `0.0.0.0:41415`, but the
  device that reaches it by the tailnet name is one you signed into Tailscale yourself, and the traffic
  between the two is WireGuard-encrypted end to end, whatever network either sits on. Who may reach the
  Mac at all is decided by your tailnet's ACLs, not by whoever shares the café's Wi‑Fi.
- **Pairing still gates every device.** A tailnet peer gets the same public page as a Wi‑Fi client and
  nothing more until it redeems a code from Settings › phone; forgetting a phone works the same. Reaching
  the Mac and being allowed to act on it stay two separate steps.
- **`tailscale serve`, never Funnel.** The optional https switch runs `tailscale serve` to put a TLS
  front on the listener, reachable only from inside the tailnet, with a certificate Tailscale issues for
  the tailnet name. loki never enables Funnel, which would publish the listener to the internet; if you
  turn Funnel on yourself, the pairing code is the only thing between the world and your inbox.
- **What loki runs.** Only the Tailscale CLI already on the Mac (`tailscale status --json`, `tailscale
  serve status --json`, and `tailscale serve` on and off for the switch). loki does not install Tailscale,
  sign in, or change the tailnet's settings.

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

loki runs the machine's own Letta Code. Only when there is none does it run `npm install -g
@letta-ai/letta-code@latest` from registry.npmjs.org (npm verifies package integrity), with the npm beside
a Node 22.19+ already installed (`npm.cmd` on Windows); it downloads no Node on any system, never runs
`sudo`, and never asks Windows for administrator rights. Without a Node, Welcome names the command to run
yourself (`brew install node`, `winget install OpenJS.NodeJS.LTS`, the distribution's package). Settings › letta asks the
registry for the newest version when you check and installs it the same way when you choose to. The app
also asks GitHub's releases API for a newer loki (every six hours, the stable or nightly channel it came
from) and only links to it: the release page on the Mac, that system's `-setup.exe`, AppImage or `.deb` on
Windows and Linux. It never downloads or installs a loki itself. The Windows and Linux files are unsigned
previews, like the Mac's `.dmg`. No other downloads.

## What loki reads

- Letta's local backend under `~/.letta/` (agents, conversations, memory filesystems, pins,
  permission modes), read-only except for pins and the files it owns under `~/.letta/loki/`.
- The board in `~/.letta/loki/board` through the `bd` binary.
- Nothing is uploaded, logged remotely, or telemetered. The mod keeps a local usage log
  (`~/.letta/loki/logs/events.jsonl`: ids and counts, never message text, titles or paths) that only
  `bun run analytics` on this machine reads; `LOKI_ANALYTICS=0` turns it off. The only other network traffic is
  the two checks above and what your agent's provider connection and widgets initiate.

## Reporting

Open a private security advisory on the repository (Security → Report a vulnerability). Please do not
include tokens, transcripts, or agent memory files in the report.
