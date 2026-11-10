# Security

loki is a local desktop app. Everything it runs is on your machine, and almost everything it talks to is on your
machine or chosen by you: your model providers, your MCP servers, and, when you switch them on, your phone, your
other Macs, and the Gmail, Slack and Jira accounts you connect. The rest (web search, the update check, npm for an ACP adapter) is listed under
[What leaves the machine](#what-leaves-the-machine).

## What runs where

- **The shell** (`src-tauri`, Rust) opens the window, writes the capability token, installs the daemon and mod
  bundles under `~/.loki` on each launch, and starts loki's daemon on the machine's own Node (22.19 or newer). It
  restarts the daemon when it exits and stops it when loki quits. It relays nothing: the page talks to the daemon
  itself.
- **The daemon** (`daemon/`, TypeScript on Node) is one long-lived process that runs as you, with your permissions. It
  holds every agent, chat and tool, runs the agents' commands on your machine, and hosts loki's mod (`mod/`) and any
  mod you add in `~/.loki/mods`. A mod is code that runs in the daemon with the same privileges, so add only mods you
  trust.
- **The token.** The daemon's mod serves the app's socket and files on `127.0.0.1:41414` (`LOKI_PORT`), loopback
  only; the page itself comes from the shell. Every request, HTTP or WebSocket, must carry the token from
  `~/.loki/token` (32 random hex characters, mode 0600, written once; on Windows the file is under `%USERPROFILE%` and
  relies on the profile folder's own permissions), except `/health` (liveness, the open chat ids and a few counts)
  and the MCP sign-in callback described below. Requests without it are refused. Only something that can read your
  files can connect.
- **The page** (`app/`, React) runs in the system WebView (WebKit on the Mac, WebView2 on Windows, WebKitGTK on
  Linux). Its only Tauri permissions are the core defaults, set-title, set-theme, hide, start-dragging (the title
  strip that moves the window), minimise, maximise, close and is-maximised (the window buttons loki draws on Windows
  and Linux), the system's folder dialog (`dialog:allow-open`, which hands back only the folder you pick), opening
  http(s), `mailto:` and `tel:` links and showing a file in the file manager (`opener:default`, see
  `src-tauri/capabilities/default.json`), and loki's own shell commands (its log, the daemon's status and a retry, the
  badge, the global key, the menu). It cannot read files or run programs.
- **Children of the daemon.** The agents' bash commands and background tasks, `git` for memory commits and for
  refreshing a skill from its upstream repo, `rg` for search, `bd` only to read the open tasks once when Tasks gave
  way to suggestions (the beads store is read, never written), the local MCP servers you list, and the ACP agents you
  choose for a chat (Claude Code, Cursor's CLI, or your own in `~/.loki/state/acp.json`). On the Mac it also runs
  `osascript` for the folder chooser, `sips` to shrink images, `scutil` for the computer's name and `caffeinate`
  (below); `open`, `xdg-open` or `rundll32` open an ACP agent's sign-in page, and `taskkill` stops a task on Windows.
  An ACP chat reaches loki's own tools through one MCP endpoint on a random loopback port, with a key per chat, kept
  in memory only, that names the chat.
- **Provider sign-ins.** While you sign in to a provider in the browser, its sign-in code listens on loopback for the
  redirect (127.0.0.1:1455 for ChatGPT and Codex, 1456 for Radius, a random port for OpenRouter) for up to ten
  minutes.

## The phone, over the LAN

Mac only for now: on Windows and Linux Preferences › Phone says pairing isn't there yet and offers no switch,
so the listener stays off.

Preferences › Phone puts a second listener on the local network so a phone can use loki (its Home, Inbox,
Agents and chats). The model:

- **Off by default.** Nothing listens beyond loopback until you switch "reachable on this Wi‑Fi" on. The
  choice is persisted (`~/.loki/state/lan.json`) and the rail shows a green dot on the settings
  icon while it is on.
- **The page's code is public while it is on.** The listener (`0.0.0.0:41415`, `LOKI_LAN_PORT`) serves the
  canvas build to anyone on the same network, unauthenticated: that is the app's JavaScript and a `/health` answer
  (the build id and the number of connected phones), nothing else. Every
  *action* — the `/ws` socket, uploads, agent faces — needs a paired device.
- **Pairing.** "pair a phone" mints a six-character code (alphabet without 0/O/1/I) that lives ten minutes
  and is kept in memory only. `POST /pair {code, name}` on the LAN redeems it and answers with a
  per-device token in an `HttpOnly; SameSite=Lax` cookie, so the page's JavaScript never sees it.
  Only the token's SHA-256 is stored (`~/.loki/state/devices.json`). Too many wrong codes from one address are
  refused for a while (429). A code may be redeemed more
  than once inside its ten minutes, each time as a separate device, because an iOS home-screen app has
  its own cookie jar and has to pair again after "Add to Home Screen".
- **Forget a phone in Preferences › Phone.** Each device is listed with when it was last seen; "forget" deletes it
  and closes its sockets. `POST /unpair` from the phone does the same for itself.
- **Plain http.** A LAN `http://` origin is not a secure context, so there is no service worker and no
  TLS; the traffic — transcripts, approvals, your replies — is readable by anyone on the network path. On
  a network you do not trust (cafés, hotels, offices you do not run), do not switch it on; if you need
  the phone there, put both devices on a Tailscale network and use that route (below).

## The phone, over Tailscale

When Tailscale runs on the Mac, Preferences › Phone offers the tailnet as the route and the QR carries the
Mac's MagicDNS name. The model changes in one place:

- **The tailnet replaces the Wi‑Fi as the boundary.** The listener still binds `0.0.0.0:41415`, but the
  device that reaches it by the tailnet name is one you signed into Tailscale yourself, and the traffic
  between the two is WireGuard-encrypted end to end, whatever network either sits on. Who may reach the
  Mac at all is decided by your tailnet's ACLs, not by whoever shares the café's Wi‑Fi.
- **Pairing still gates every device.** A tailnet peer gets the same public page as a Wi‑Fi client and
  nothing more until it redeems a code from Preferences › Phone; forgetting a phone works the same. Reaching
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
  answered only for requests that arrive over Tailscale (a `100.64.0.0/10` peer that reached this Mac's own tailnet
  address, or `tailscale serve`); over the Wi‑Fi they get 403, also on a Wi‑Fi that hands out `100.x` addresses of
  its own. They use the phone listener's port, which stays up while any Mac is paired even with the
  phone switch off; the phone's routes and the canvas then answer 404 and no phone's cookie opens anything.
- **Pairing is mutual and needs a code.** A Mac shows a six-character code that lives ten minutes, separate from the
  phone's codes, with the same wrong-code limit, and pairs one Mac: its first use spends it, since a paired Mac
  receives this Mac's mods and MCP servers. Each Mac mints a 32-byte token for the other: it keeps only the
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
- **ACP chats.** A chat on an ACP agent gets the servers the agent has on as their whole entries, `${keychain:…}`
  values filled in, env and headers included; the ACP agent starts and connects to them itself, and signs in itself
  to one that wants OAuth. Its own copy of those values is then as safe as that agent keeps it.
- **Where secrets live.** Either in the system keychain (Preferences › MCP servers' "keep … values in this computer's keychain";
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
  answered "always allow" for it (kept in `~/.loki/state/approvals.json`, taken back in Preferences › Chat); a server
  can mislabel a tool, so treat a server you do not trust as you would its shell commands, and use strict mode,
  which asks for everything, always-allowed tools included.

## Suggestions

An agent can suggest a message for any chat, of any agent, on any of your Macs, but it never sends one: you send it,
save it as a draft, or reject it, and that decision is the approval. So `chat_list`, `suggestion_create`,
`suggestion_list` and `suggestion_withdraw` never ask, in any permission mode (`NEVER_ASK` in `daemon/approvals.ts`),
on loki's engine and on an ACP agent alike. `chat_list` shows an agent the names, folders, labels and purpose lines of
your open chats, never their messages. A sent suggestion arrives in its chat as your message, with a mark naming the
chat it came from, and runs under that chat's own permission mode. A background pass cannot suggest.

## Accounts: Gmail, Slack and Jira

The Inbox can show the mail, Slack threads and Jira tickets waiting for you (plan 067, plan 2026-11-10-1451). An account is connected in Preferences ›
Accounts, belongs to one agent, its owner, and lives on the Mac that connected it. **Agents never send.** loki sends
one thing only: a reply you type yourself on an outside card (plan 068). That reply goes through the
`account_thread_reply` frame, which only your own devices send, to `mod/outside-threads.ts`, the one caller of each
client's send call (`GmailClient.sendReply`, `SlackClient.postReply`; a test checks there is no other). No agent tool
is given those calls, so an agent's reply reaches Gmail or Slack only as a draft you approved, which you then send
yourself.

- **Gmail sign-in.** A loopback OAuth sign-in with PKCE, like an MCP server's: Google's page opens in your browser and
  comes back to `http://127.0.0.1:<port>/accounts/google/callback` on the loopback server only, which acts only on
  the one-time `state` of a sign-in loki started in the last 10 minutes (`mod/google-signin.ts`). loki asks for
  `gmail.modify`, `openid` and `userinfo.email`. `gmail.modify` reads mail, changes labels, writes drafts and sends;
  loki keeps agents from sending by giving no agent tool the send call in `mod/gmail.ts`, not by the scope.
- **What loki changes in Gmail.** Only labels, and only on your move on a card (plan 070): read removes UNREAD,
  later adds UNREAD to the thread's newest incoming message, archive and a hand-off remove INBOX and UNREAD, label
  adds a label of yours that you pick, and undo puts back exactly the labels the move changed. Each touches messages
  up to the card's newest only. loki lists the account's labels for the picker and never creates, renames or deletes
  one; nothing deletes or moves mail to the trash. A label move or an undo that names TRASH, SPAM, SENT, DRAFT or
  CHAT leaves that label alone, whichever device sent it.
- **Whose Google app.** By default the shared Desktop client of loki's own Google Cloud project, whose id and secret
  ship in the source (`mod/google-app.ts`), as Google intends for a desktop client: they identify the app, not you, and
  grant nothing without your sign-in. You may use a Google app of your own instead; its id and secret are kept in the
  keychain with that account's tokens.
- **Slack session.** loki makes no Slack app and needs no admin: on macOS it reads the Slack desktop app's own session,
  the desktop token (`xoxc-…`) from its Local Storage and the `d` cookie from its Cookies database, decrypted with the
  "Slack Safe Storage" key, which macOS asks you once to let loki read from the keychain (`mod/slack-session.ts`).
  Slack's files are copied to a private temporary folder to be read, since Slack locks them while it runs, and that
  copy is removed at once. The session stays in the daemon's memory and is never written anywhere; loki reads it again
  when Slack refuses it.
- **What loki calls in Slack.** Only the methods in `SLACK_METHODS` (`mod/slack.ts`): reading conversations, users,
  activity and counts, marking a DM read (read, archive and a hand-off; later and undo write nothing to Slack), listing, writing and deleting drafts, and `chat.postMessage` for your own
  reply, which no agent tool reaches; nothing edits, deletes or schedules a message. Calls go only to
  `https://slack.com` or a workspace's own `https://<name>.slack.com` address, so the token never goes anywhere else.
- **Jira token.** A Jira Cloud site is connected with your Atlassian email and a classic API token you make yourself
  (plan 2026-11-10-1451). loki first asks the address you typed, without the token, where the site's API lives, and
  then sends the token only to that host over `https`, as basic authentication, and only when it is an
  `*.atlassian.net` host, where every Jira Cloud site's API lives; an answer naming any other host is refused before
  the token leaves the Mac (`mod/frames/accounts.ts`, `mod/jira.ts`). The token is kept in the keychain with the site's host and your email, never in a state file. A
  token Jira refuses marks the account as wanting a new one; loki does not try it again until you reconnect.
- **What loki calls in Jira.** It reads: who you are, the tickets you watch, and each ticket's comments and history.
  It writes one thing: a comment you type yourself on a Jira card, posted through `account_thread_reply` and
  `mod/outside-threads.ts`, the one caller of `JiraClient.postComment` (a test checks there is no other). Read, later,
  undo and a hand-off write nothing to Jira, and nothing changes a ticket's status, fields, watchers or other
  comments. An agent's proposed comment, once you approve it, waits in the card's box for you to send.
- **What reaches the model.** Mail, Slack and Jira text reaches your model provider only when you hand a thread to its
  owner (`mod/handoff.ts`), or when the owning agent reads it with its account tools (`account_list`, `account_read`,
  `account_search`), which only the owner's chats are offered and which check ownership on every call. Either way the
  text is fenced as a stranger's content, not instructions, with anything inside it that could pass for loki's own
  tags made inert. The Inbox card itself is drawn in the app and goes to no model.
- **A mail drawn on its card.** A mail's HTML is drawn for you only, in a frame sandboxed with no scripts or forms and
  its own policy allowing only images, styles and fonts (`app/src/desk/mail-html.tsx`); scripts, frames,
  objects, base and refresh tags are also removed before it is drawn. Remote images load, so a sender can tell the
  mail was opened and from which address, as in Gmail. A link opens in your browser, and only `http`, `https` and
  `mailto` links open. The frame may ask for a new window, which is how a click reaches the Mac's shell, but the shell
  opens no window: it hands a web or mail address to the browser and drops anything else (`src-tauri/src/lib.rs`). The HTML goes to no model: agents read the mail's text.
- **What loki keeps on disk.** Each thread's record (its sender, subject and last few lines,
  `state/account-threads/`) and the ledger of your moves on outside cards (`state/inbox-ledger.jsonl`, plan 069:
  sender, subject, the kind of mail and what you did) stay on the account's Mac, mode 0600, and go to no model or
  server. So do the people each mailbox has mail with (`state/mail-people.json`, plan 076: names and addresses from
  the From, To and Cc headers loki already reads, for the recipients line's suggestions, forgotten when the account is
  disconnected) and a mail reply waiting out its 10-second undo (`state/outbox.json`, mode 0600, which holds it only
  until it is sent). They are under `~/.loki`, which an agent with file tools can read and write. So each held reply
  carries a seal made with a key kept in the keychain (`outbox-key`), and a restart sends only replies whose seal
  holds: an entry written into the file by anything else is dropped unsent, and without a keychain no held reply is
  sent after a restart.
- **Recipients, forward and From (plan 076).** They ride on `account_thread_reply`, the frame only your devices send.
  The mod checks each address is one line, refuses more than 100 people, and sends only from an address Gmail lists
  as one you send from. A forward reads the forwarded mail's own files from Gmail and attaches them, refusing more
  than 17 MB. Agents get none of this: an approved agent draft still goes to the thread's own people.
- **Residual risks.** A fence asks the model to treat text as content; it cannot make it. An owner that also has shell
  or file tools could be steered by mail written to do so, so give an account to an agent whose permission mode you
  are comfortable with for anything a stranger can write to you, and use strict mode for it if in doubt. An owner may
  propose a reply in any thread of its accounts (plan 071), not only one you handed it, so mail could steer it to
  propose a reply somewhere you did not ask; the approval card, which names the thread and who the reply goes to, is
  the gate, and an approved reply is still only a draft to that thread's own people. Account
  secrets share the keychain service "loki" with provider keys, so anything that may read one of loki's keychain
  entries may read the others.

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
- **Gmail tokens**, and the id and secret of your own Google app when you use one, are in the same keychain, one entry
  per account (`account:<account_id>`), never in a file under `~/.loki`, which your agents can read. A Slack session is
  never kept at all, beyond the daemon's memory.
- **Paired phones and Macs** are kept as the SHA-256 of their tokens only (`~/.loki/state/devices.json`,
  `~/.loki/state/peers.json`, mode 0600).
- **Never in the clear on disk:** provider keys, Gmail tokens and Slack sessions. The capability token is a file readable by you alone.

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
  (`stores/`), agent records and memory repos (`backend/`), widgets, small state files (`state/`, the usage ledger
  `state/usage.json` among them), your mods (`mods/`), Learn's cards, files you attach (`uploads/`), the pictures in
  messages (`chat-images/`), and logs (`logs/daemon.log`, `mod.log`). The beads store of the retired Tasks (`tasks/`)
  stays where it was; loki reads it only to move each open task into a suggestion once, and never writes it.
  [architecture.md](architecture.md) lists every path. Store backups made before a migration (`stores/backup-…/`) hold whole copies of your chats; delete them once
  you are happy.
- The Inbox's accounts: their records and owners (`state/accounts.json`), the last few messages of each waiting
  thread as plain text, for its card (`state/account-threads/`), hand-offs under way (`state/handoffs.json`), your
  agents' reply proposals (`state/reply-proposals.json`), the names and addresses each mailbox has mail with
  (`state/mail-people.json`) and a mail reply during its undo (`state/outbox.json`). No token or session is among them.
- Outside it: the global skills in `~/.agents/skills`, and provider, MCP and account secrets in the keychain.
- Nothing is uploaded, logged remotely, or telemetered. The daemon keeps a local usage log
  (`~/.loki/logs/events.jsonl`: ids and counts, never message text, titles or paths) that only this machine reads:
  `npm run analytics`, and the usage page's ledger once, to seed its history; `LOKI_ANALYTICS=0` turns it off.

## What leaves the machine

1. Each turn, to the provider of the chat's model, over HTTPS: the prompt, the history and the tool results.
2. The agent's web searches, to DuckDuckGo's plain HTML results, which need no key.
3. Tool calls to your MCP servers, as above.
4. The update check to GitHub, as above.
5. npm's registry, for the pinned Claude Code adapter, the first time a chat uses it.
6. A skill's upstream git repo, when the skill is refreshed from it.
7. A provider's sign-in page in your browser, when you sign in to it.
8. With the phone or other Macs switched on, what those sections describe, inside your network or tailnet.
9. With an account connected, calls to Google (sign-in, token refresh and the Gmail API) and to Slack (`slack.com`
   and your workspaces' `*.slack.com` addresses) and to your Jira sites (the address you typed, once, then the site's
   API host), as [Accounts](#accounts-gmail-slack-and-jira) describes; mail, Slack and Jira text then goes to your
   model provider only through a hand-off or the owner's account tools.
10. Whatever your agent's own commands, its ACP agent and your widgets' images reach.

## Reporting

Open a private security advisory on the repository (Security → Report a vulnerability). Please do not include
tokens, transcripts, or agent memory files in the report.
