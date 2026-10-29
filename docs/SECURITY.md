# Security

loki is a local desktop app. Everything it runs is on your machine, and everything it talks to is on your machine
or chosen by you: your model providers, your MCP servers, and, when you switch them on, your phone and your other
Macs.

## What runs where

- **The shell** (`src-tauri`, Rust) opens the window, writes the capability token, installs the daemon and mod
  bundles under `~/.loki` on each launch, and starts loki's daemon on the machine's own Node (22.19 or newer). It
  restarts the daemon when it exits and stops it when loki quits. It relays nothing: the page talks to the daemon
  itself.
- **The daemon** (`daemon/`, TypeScript on Node) is one long-lived process that runs as you, with your permissions. It
  holds every agent, chat and tool, runs the agents' commands on your machine, and hosts loki's mod (`mod/`) and any
  mod you add in `~/.loki/mods`. A mod is code that runs in the daemon with the same privileges, so add only mods you
  trust.
- **The token.** The daemon's mod serves the app on `127.0.0.1:41414` (`LOKI_PORT`), loopback only. Every request,
  HTTP or WebSocket, must carry the token from `~/.loki/token` (32 random hex characters, mode 0600, written once; on
  Windows the file is under `%USERPROFILE%` and relies on the profile folder's own permissions). Requests without it
  are refused. Only something that can read your files can connect.
- **The page** (`app/`, React) runs in the system WebView (WebKit on the Mac, WebView2 on Windows, WebKitGTK on
  Linux). Its only Tauri permissions are the core defaults, set-title, set-theme, hide, start-dragging (the title
  strip that moves the window), minimise, maximise, close and is-maximised (the window buttons loki draws on Windows
  and Linux), the system's folder dialog (`dialog:allow-open`, which hands back only the folder you pick), and opening
  URLs in the system browser (see `src-tauri/capabilities/default.json`). It cannot read files or run programs.
- **Children of the daemon.** The agents' bash commands and background tasks, `git` for memory commits, `rg` for
  search, `bd` only to read the open tasks once when Tasks gave way to suggestions (the beads store is read, never
  written), the local MCP servers you list, and the ACP agents you choose for a chat (Claude Code, or
  your own in `~/.loki/state/acp.json`). An ACP chat reaches loki's own tools through an MCP endpoint on a random
  loopback port, one per session, with a key that names the chat.

## The phone, over the LAN

Mac only for now: on Windows and Linux Settings › phone says pairing isn't there yet and offers no switch,
so the listener stays off.

Settings › phone puts a second listener on the local network so a phone can use loki (its Home, Inbox,
Agents and chats). The model:

- **Off by default.** Nothing listens beyond loopback until you switch "reachable on this Wi‑Fi" on. The
  choice is persisted (`~/.loki/state/lan.json`) and the rail shows a green dot on the settings
  icon while it is on.
- **The page's code is public while it is on.** The listener (`0.0.0.0:41415`) serves the canvas build to
  anyone on the same network, unauthenticated: that is the app's JavaScript and nothing else. Every
  *action* — the `/ws` socket, uploads, agent faces — needs a paired device.
- **Pairing.** "pair a phone" mints a six-character code (alphabet without 0/O/1/I) that lives ten minutes
  and is kept in memory only. `POST /pair {code, name}` on the LAN redeems it and answers with a
  per-device token in an `HttpOnly; SameSite=Lax` cookie, so the page's JavaScript never sees it.
  Only the token's SHA-256 is stored (`~/.loki/state/devices.json`). A code may be redeemed more
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

## Suggestions

An agent can suggest a message for any chat, of any agent, on any of your Macs, but it never sends one: you send it,
save it as a draft, or reject it, and that decision is the approval. So `chat_list`, `suggestion_create`,
`suggestion_list` and `suggestion_withdraw` never ask, in any permission mode (`NEVER_ASK` in `daemon/approvals.ts`),
on loki's engine and on an ACP agent alike. `chat_list` shows an agent the names, folders, labels and purpose lines of
your open chats, never their messages. A sent suggestion arrives in its chat as your message, with a mark naming the
chat it came from, and runs under that chat's own permission mode. A background pass cannot suggest.

## Agent-written code

The point of loki is that your agent writes widgets: files under `~/.loki/widgets/<chat>/`. A `.tsx` widget is
transpiled by the shell on request (`loki://localhost/widgets/…`) and runs in its own sandboxed iframe
(`sandbox="allow-scripts"`, an opaque origin). The frame's policy allows no fetch, XHR, WebSocket or EventSource
(`connect-src 'none'`), no frames, workers or forms, and images only from `data:`, `blob:` and `https:`; the frame
never sees the daemon token, and talks to the page only by `postMessage`, which the page checks
(`app/src/desk/widget-bridge.ts`). A widget can still show an `https:` image, which tells that server the widget was
shown. Treat widgets the way you treat the agent's shell commands: the permission mode you choose per chat (strict,
standard, accept edits, unrestricted) governs whether the agent may write files at all, and an agent that may run
commands can do anything you can.

The page's Content Security Policy (in `src-tauri/tauri.conf.json`) allows scripts only from the app itself and the
`loki:` transpiler: no remote scripts, no `eval`.

## Secrets

- **Provider keys and sign-ins** are kept in the system keychain (the macOS Keychain, Windows Credential Manager, the
  Secret Service on Linux) through `@napi-rs/keyring`, one entry per provider under the service "loki". A key is
  checked with its provider before it is kept. Without a reachable keychain, keys come from environment variables
  only; `LOKI_KEYCHAIN=0` keeps secrets in memory for the daemon's life, for tests and scratch runs.
- **MCP secrets and sign-ins**, and the tokens of paired Macs, are in the same keychain, as described above.
- **Paired phones and Macs** are kept as the SHA-256 of their tokens only (`~/.loki/state/devices.json`,
  `~/.loki/state/peers.json`, mode 0600).
- **Never in the clear on disk:** provider keys. The capability token is a file readable by you alone.

## What loki downloads

- **Nothing to run itself.** loki never downloads Node, never runs `sudo`, and never asks Windows for administrator
  rights. Without a Node 22.19 or newer, Welcome names the command to run yourself (`brew install node`,
  `winget install OpenJS.NodeJS.LTS`, the distribution's package). The daemon, the mod and the phone's canvas come
  inside the app and are copied to `~/.loki` on launch.
- **Updates are yours to take.** The app asks GitHub's releases API for a newer loki (on launch and every six hours,
  on the stable or nightly channel it came from) and only links to it: the release page on the Mac, that system's
  `-setup.exe`, AppImage or `.deb` on Windows and Linux. It never downloads or installs a loki itself, and the
  daemon never updates itself. The Windows and Linux files are unsigned previews, like the Mac's `.dmg`.
- **Claude Code, when you choose it for a chat.** loki runs the ACP adapter with `npx`, at a version each loki
  release pins (`daemon/acp/agents.ts`), so npm fetches that version from its registry the first time. An ACP agent
  of your own runs the command you wrote for it.

## Where data lives

- Everything loki keeps is under `~/.loki` (`LOKI_DIR` overrides it): each agent's chats in a SQLite store
  (`stores/`), agent records and memory repos (`backend/`), widgets, small state files (`state/`), your mods
  (`mods/`), Learn's cards, and logs (`logs/daemon.log`, `mod.log`). The beads store of the retired Tasks (`tasks/`)
  stays where it was; loki reads it only to move each open task into a suggestion once, and never writes it.
  [architecture.md](architecture.md) lists every path. Store backups made before a migration (`stores/backup-…/`) hold whole copies of your chats; delete them once
  you are happy.
- Outside it: the global skills in `~/.agents/skills`, and provider and MCP secrets in the keychain.
- Nothing is uploaded, logged remotely, or telemetered. The daemon keeps a local usage log
  (`~/.loki/logs/events.jsonl`: ids and counts, never message text, titles or paths) that only `npm run analytics`
  on this machine reads; `LOKI_ANALYTICS=0` turns it off.

## What leaves the machine

1. Each turn, to the provider of the chat's model, over HTTPS: the prompt, the history and the tool results.
2. The agent's web searches, to DuckDuckGo's plain HTML results, which need no key.
3. Tool calls to your MCP servers, as above.
4. The update check to GitHub, as above.
5. With the phone or other Macs switched on, what those sections describe, inside your network or tailnet.
6. Whatever your agent's own commands, its ACP agent and your widgets' images reach.

## Reporting

Open a private security advisory on the repository (Security → Report a vulnerability). Please do not include
tokens, transcripts, or agent memory files in the report.
