# Security

loki is a local desktop app. Everything it talks to is on your machine — unless you switch on the phone
listener, described below.

## What runs where

- **The shell** (`src-tauri`, Rust) opens a window, finds or starts a Letta harness, and relays
  app-server frames between the page and that harness over a loopback WebSocket. The page never holds
  the harness token; the Rust side sends it as a bearer header.
- **The mod** (`mod/`, TypeScript) runs *inside* the Letta harness with that process's privileges. It
  serves widget files and chat state on `127.0.0.1:41414` (`LOKI_PORT`). Every request, HTTP or
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
Agents and chats). The model:

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

## Other Macs, over Tailscale

Plan 023 lets your Macs running loki share their agents. Nothing reaches any host outside your tailnet, and no
server or account is involved.

- **Tailnet only.** Pairing (`/peer/pair`), a Mac's hello and unpairing, and a paired Mac's socket on `/ws` are
  answered only for requests that arrive over Tailscale (a `100.64.0.0/10` peer, or `tailscale serve`); over the
  Wi‑Fi they get 403. They use the phone listener's port, which stays up while any Mac is paired even with the
  phone switch off; the phone's routes and the canvas then answer 404 and no phone's cookie opens anything.
- **Pairing is mutual and needs a code.** A Mac shows a six-character code that lives ten minutes, separate from the
  phone's codes, with the same wrong-code limit. Each Mac mints a 32-byte token for the other: it keeps only the
  token's SHA-256 (`~/.loki/state/peers.json`, mode 0600) and keeps the token the other Mac minted for it in the
  keychain. Forgetting a Mac on either side tells the other when it can, and a Mac whose token is refused checks and
  forgets too.
- **A paired Mac can introduce another.** So every Mac is paired with every other, a Mac paired with two Macs
  introduces them: the Mac being joined mints an invite (32 random bytes, for the joining Mac's id only, single use,
  two minutes, in memory only) when a Mac it is already paired with asks, and the joining Mac redeems it over the
  tailnet as it would a code. A paired Mac thus vouches for another, the trust it already has (it can read and drive
  every chat). A Mac you forgot on purpose is kept in `~/.loki/state/peers-forgotten.json` and never invited back;
  pairing it again by code clears that.
- **A paired Mac is not the desktop.** Its socket may send only the frames marked for Macs (`PEER_FRAMES`): chat,
  history, canvas and folder frames for chats that live on this Mac, and the sync frames. Never pairing, device or
  phone settings. A phone's frame is checked against the phone's own limits on its own Mac before it is passed on.
- **What travels.** Over WireGuard, between your Macs: chats you open on the other Mac, agent records and memory
  (as git bundles), Inbox marks, pins, label colours, Learn's files, your MCP server entries and your mods, and files
  you attach to a chat that lives on the other Mac. A synced mod is code, and it runs on every paired Mac. Never
  travels: provider keys and sign-ins, MCP secrets (mcp.json holds `${keychain:…}` references only), the "always
  allow" list, browser profiles, agents' own files.
- **Staying awake.** While a Mac is paired, loki runs `/usr/bin/caffeinate -s -w <pid>`: no idle sleep on power
  while the daemon runs; no setting is changed and a closed lid still sleeps.

## MCP servers

- **What loki starts.** Exactly the local servers listed in `~/.loki/mcp.json` (`command` and `args`, run as you,
  with the usual environment plus the entry's `env`), for as long as the daemon runs, and nothing else. A server is
  as trusted as any program you run: it gets your permissions and whatever its `env` holds. loki installs none.
- **Where secrets live.** Either in the system keychain (Settings › MCP's "keep values in this computer's keychain";
  the file then holds `${keychain:<name>}` and the value is read only when the server starts), or in
  `~/.loki/mcp.json` itself, as you write them. loki writes the file readable by you alone (mode 600).
- **What reaches a server.** Only the arguments of the tool calls your agents make to it. A remote server is
  reached only at the `url` you gave, and, when it asks for a sign-in, the authorization server its own metadata names.
- **OAuth sign-ins.** A remote server without an Authorization header of its own may ask for one (PKCE, as MCP's
  authorization spec has it). loki registers itself as a client with the callback
  `http://127.0.0.1:41414/mcp/oauth/callback`, a route on the loopback server only (never the LAN listener) that
  takes no token, since a browser redirect carries none: it acts only on the one-time `state` of a sign-in loki
  started, and a used or unknown state does nothing. Tokens, the registration and the PKCE verifier are kept in the
  system keychain (`mcp-oauth.<server>.*`); sign out forgets the tokens.
- **Permissions.** A tool runs without asking in standard mode only when its server marks it read-only, or when you
  answered "always allow" for it (kept in `~/.loki/state/approvals.json`, taken back in Settings › Chat); a server
  can mislabel a tool, so treat a server you do not trust as you would its shell commands, and use strict mode,
  which asks for everything, always-allowed tools included.

## Agent-written code

The point of loki is that your agent writes widgets: `.tsx` files under `~/.letta/loki/widgets/`. The
shell transpiles them on request at `loki://localhost/widgets/…` and the page runs them. **A widget runs
with the page's privileges**, which means: it can call the mod with the page's token (chat state, other
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
- Tasks in `~/.loki/tasks` through the `bd` binary.
- Nothing is uploaded, logged remotely, or telemetered. The mod keeps a local usage log
  (`~/.letta/loki/logs/events.jsonl`: ids and counts, never message text, titles or paths) that only
  `npm run analytics` on this machine reads; `LOKI_ANALYTICS=0` turns it off. The only other network traffic is
  the two checks above and what your agent's provider connection, its MCP servers and widgets initiate.

## Reporting

Open a private security advisory on the repository (Security → Report a vulnerability). Please do not
include tokens, transcripts, or agent memory files in the report.
