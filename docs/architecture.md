# loki · the execution model

loki runs its agents itself. A small Rust shell opens the window and keeps one long-lived Node process running,
loki's **daemon**, which holds every agent, every chat and every tool. This document is the map: which processes
run on your machine, what each one owns, the path a message takes, and where each piece lives in the repo.

Until October 2026 loki sat on top of Letta Code and ran inside its `letta server` process; nothing of Letta is left
in it now. Plan 017
(`docs/plans/2026-10-09-017-refactor-loki-pi-harness-plan.md`) moved it onto its own daemon, built on Earendil's
Pi libraries. The reason was speed and control: every turn passed through Letta's app-server and local backend,
whose protocol and mod API were unversioned and changed on Letta's schedule. The measured trial
(`docs/research/2026-10-pi-trial.md`) gated the move. With the same model and prompts, the daemon's median time to
first token was 1,375 ms against Letta's 2,651 ms. Its harness overhead per turn was 7 ms against 101 ms, and the
gap from a tool result to the next model request was 1 ms against 23 ms.

## The four responsibilities

Picture the agent as a worker with a brain, a memory, a pair of hands and a canvas. Each is a separate job, and
knowing which job a piece of code does tells you where it runs.

1. **The model: the thinking.** A provider's language model (Anthropic, OpenAI, Google, OpenRouter, a local
   Ollama, or another provider pi-ai knows). It turns the prompt and the tool list into the next move: text, a tool
   call, or both, streamed back. It keeps no state, so every request carries the whole story. It always lives at
   the provider, reached over HTTPS with a key or sign-in from Settings › Providers.
2. **The memory: what persists.** Each agent's chats are saved in a SQLite store, and its memory is a git repo of
   markdown files. Both are files under `~/.loki`, owned by the daemon.
3. **The hands: the tools.** Shell commands, file reads and edits, search, web search, subagents, background and
   scheduled tasks. They run inside the daemon (or as its child processes) on your machine, under the chat's
   permission mode, because this is the machine that has your files.
4. **The canvas: what you see.** loki's own mod, running inside the daemon, owns each chat's widgets, gestures,
   suggestions, Learn and the sockets the app connects to. The React app renders it in three clients: the desktop window, a
   browser tab on the same machine, and a paired phone.

Only the first lives elsewhere. The memory, the hands and the canvas are all on your machine, in one process.

## Which of these are processes

```text
loki (Rust shell, Tauri)                          the window, tray, dock badge, global shortcut
└── node daemon.mjs --loki-daemon                 loki's daemon: one process for every agent
      --dir ~/.loki --mod …/loki-mod.mjs
      --token-file ~/.loki/token
    ├── pi-durable Harness per agent              ~/.loki/stores/<agentId>.sqlite
    ├── loki's mod (canvas, Learn, /ws)           listens on 127.0.0.1:41414, and 0.0.0.0:41415 when the phone is on
    └── children: bash commands, background tasks, git, ripgrep
```

1. **The shell starts the daemon and keeps it alive.** At launch it finds Node 22.19 or newer (`node.rs`), stops a
   daemon an earlier loki left behind (`procs.rs`, matched by its command line and start time), and starts a new
   one (`harness.rs`). A release build runs the installed bundle, `~/.loki/daemon/daemon.mjs`; a development build
   runs the checkout's `daemon/main.ts` with `mod/boot.ts`. The daemon's output is appended to
   `~/.loki/logs/daemon.log`. A checkout's daemon keeps up with its sources (`daemon/dev-reload.ts`, plan 024): it
   reloads the mod when `mod/` or `core/` changes, and a change to `daemon/` or `core/` makes a restart due
   (`restart_due`), which the window offers; `daemon_restart` stops it cleanly for the supervisor to start again.
2. **A daemon that dies is started again, with backoff.** The supervisor (`supervise_daemon` in `lib.rs`) waits one
   second, doubling with each exit in the last minute, never more than thirty. A daemon that crashes at start
   therefore does not spin. Quitting loki stops the daemon and the supervisor leaves it down.
3. **Only one daemon serves a folder.** The daemon takes `~/.loki/daemon.lock` (a file holding its pid) before it
   opens any store, because pi-durable has no lock of its own and two owners of one store would run the same tool
   calls twice. A second daemon exits with code 3; its shell leaves the first one serving and tries again every 30
   seconds, in case that one was a leftover that later dies. This is how a dev build beside the installed app shares
   one daemon.
4. **The daemon dies with loki.** On Windows it runs with no console window inside a Job Object that ends the whole
   tree when loki's handle closes. On Linux it is started with the parent-death signal. On the Mac, where neither
   exists, a leftover from a crash is found and stopped at the next launch.
5. **There are no other long-lived processes.** The children are short-lived
   or belong to a chat: an agent's bash commands and background tasks, `git` for memory commits,
   `rg` for search when it is installed, and `bd`, only to read the open tasks once when Tasks gave way to
   suggestions. The exception is the MCP servers you list in `~/.loki/mcp.json`: each local
   one runs as long as the daemon does, restarted with backoff if it exits.

The model is a remote service, not a process on your machine.

## Inside the daemon

`daemon/main.ts` wires these pieces together, in this order: the lock, the keychain, the stores, the extensions
every chat gets, the chats, then the mods.

1. **The kernel (`daemon/kernel/`).** The only code that imports pi-durable. Each agent has one pi-durable
   `Harness` over one SQLite file, `~/.loki/stores/<agentId>.sqlite`, opened on first use. pi-durable saves every
   model step and tool result before it is shown, so a turn cut off by a crash resumes from its last save when the
   store reopens. One file per agent spreads the writes, and a storage failure closes only that agent's chats; the
   store manager reopens it. pi-durable numbers its own conversations, so a document in each store maps loki's chat
   ids (`local-conv-…`, and `default` for an agent's main chat) to them. A chat keeps its id for life, and its
   widgets, Inbox marks, pins and suggestions are keyed by it. An update that changes what a store holds migrates
   it on open, after a whole copy (`daemon/store-backup.ts`): pi-durable's own schema, to
   `stores/backup-schema-<version>-<date>/`; and loki's entries, in `daemon/store-migration.ts`, one pass of
   rewrites over a store's entries in one transaction (old tool names, and the shapes chats imported from Letta
   carried), versioned per store in `stores/migrations.json`. It replaced `store-tool-names.ts` and its
   `tool-names.json`. Chats on an ACP agent keep their agent's own names and shapes.
2. **Agent records and memory (`daemon/store/agents.ts`, `daemon/memory.ts`).** Under `~/.loki/backend`:
   `agents/<id>.json` for the record, `memfs/<id>/memory/` for the memory repo. The memory repo's `system/` files go
   into the prompt; the rest is listed by path. Each change is a git commit, by the agent, or by "Reflection".
   `daemon/agent-migration.ts` migrates the records and memory once, noted in `state/migrations.json`.
3. **Models and keys (`daemon/providers.ts`, `daemon/credentials.ts`).** Every provider pi-ai knows. Credentials
   (API keys, or the tokens from signing in with ChatGPT) are kept in the OS keychain through `@napi-rs/keyring`,
   one entry per provider under the service "loki". A key is tried before it is kept. Anthropic's subscription
   sign-in is not offered, because pi-ai implements it by presenting itself as Claude Code; an Anthropic API key
   works instead. Without a reachable keychain, keys come from environment variables only, and the log says so.
4. **Approvals and questions (`daemon/approvals.ts`, `daemon/ask.ts`).** A hook before every tool call decides by
   the chat's permission mode (glossary.md: Permission mode) whether to ask. The question goes to every client
   following the chat and the first answer wins. The answer is saved with the tool call, so a turn resumed after a
   crash never asks twice. `user_ask` shows a question card the same way.
5. **Tools.** pi-durable's own `read`, `write`, `edit` and `bash`; loki's `ls`, `find`, `grep` and `image_view`
   (`daemon/tools.ts`); web search over DuckDuckGo's plain HTML results, which need no key
   (`daemon/web-search.ts`); the memory tools. `daemon/extensions.ts` installs the built-in extensions in one ordered
   list, the permission gate first, and each of loki's tools declares its kind (read, edit or command) on its own
   definition (`daemon/tool-kinds.ts`). The memory, schedule and question tools, and the mods' tools, are written once
   as `ChatTool`s (`daemon/chat-tools.ts`), so a chat on an ACP agent runs the same ones. Each chat runs commands in a `ChatEnv` (`daemon/tool-results.ts`), pi-durable's
   own environment except that `bash` output past its limits is saved to the chat's `tool-results` folder, where
   MCP's big results go too.
6. **Skills (`daemon/skills.ts`).** The prompt lists every skill the agent has by name and description: the global
   ones in `~/.agents/skills` and the agent's own in its memory's `skills/` folder. The `skill` tool hands over a
   skill's full text when the agent needs it. The chat folder's `AGENTS.md` (or `CLAUDE.md`) is a section of its
   own.
7. **Subagents (`daemon/subagents.ts`).** The `subagent` tool runs a helper in a child conversation that the call owns,
   with the parent's model, tools, folder and permission mode. Aborting the call aborts the helper. Helpers are not
   agent records, so they never appear in the Agents list.
8. **Background and scheduled tasks (`daemon/background.ts`, `daemon/schedule.ts`).** A background bash command
   keeps running after its turn; the agent reads its output, writes to it, waits on it or stops it, and its chat
   gets a `<task-notification>` when it ends. Scheduled prompts are kept in `~/.loki/state/crons.json` and checked
   once a minute; a slot missed while loki was closed fires once at the next start.
9. **The background passes (`daemon/passes.ts`).** Reflection (`daemon/reflection.ts`) keeps each agent's memory;
   Learn (`daemon/learn.ts`) writes the person's cards. Same process, different objectives: once a minute the runner
   looks over the chats, and a chat quiet for half an hour with new material past a pass's cursor is due for it
   (reflection also takes a chat right after its context is compacted). A run takes all of one agent's due chats at
   once, each chat's new stretch its own part (up to 80,000 characters; a chat that does not fit whole waits for the
   next batch), so a pass sees what recurs or conflicts across conversations; an agent gets a batch at most every two
   hours, so chats gather, unless a chat was compacted or the last batch left some behind. Cursors stay per chat and
   move only when a run succeeds. A run works as the agent in that pass's hidden chat for the agent, cleared first,
   never while a chat in it is busy, one run at a time across all agents, and is measured (`pass_finished`, with the
   chats it read). The memory review (`/doctor`, `daemon/doctor.ts`) shares the queue and the hidden-chat run but reads
   the agent's whole memory instead of chats, and runs only when asked; its commits are authored "Doctor". Their settings and cursors are in `~/.loki/state/passes.json` and
   `pass-cursors.json`.
10. **The mod registry (`daemon/mods/`).** loki's mod API, version 1 (`daemon/mods/api.ts`): a mod registers tools
    and prompt sections, gets a say before a tool runs, transforms the person's message before it is sent, and
    listens to turn events. Each mod becomes one pi-durable extension shared by every agent's store, so one install
    reaches every chat. loki's own mod (`mod/index.ts`) is loaded first; then any file in `~/.loki/mods`. Editing a
    mod reloads it in place: work already under way finishes on the old code and the next step uses the new. A mod
    built for a newer major API version is refused.
11. **MCP (`daemon/mcp/`).** One `@modelcontextprotocol/client` per server in `~/.loki/mcp.json` (`servers.ts`: local
    over stdio, remote over Streamable HTTP, restarted with backoff, tools re-read when a server says they changed).
    `index.ts` registers every tool as `mcp__<server>__<tool>` in one `loki.mcp` extension, with an `mcp` prompt
    section (servers and tool names) and `mcp_search` (`search.ts`, BM25 over names, descriptions and parameters,
    or `select:`). A chat's pi-durable tool filter hides every MCP tool until `mcp_search` returns `addTools` for it;
    loki's engine (`LokiEngine`) sets the filter before each run (the chat's `mcpKnown` tells a loaded tool from a new one) and
    empties it on /clear and compaction. Results map to text and images; big ones spill to files (`results.ts`).
    A remote server with no Authorization header signs in with OAuth (`oauth.ts`, the SDK's provider interface):
    an unauthorized connect is the `signin` state, Settings opens the authorization page, and the browser comes back
    to the mod's loopback route (`oauthCallbackRoute` in `mod/server.ts`), which hands the code to `McpTools.finishAuth`.
12. **The chats (`daemon/chat-backend.ts`, `daemon/engine.ts`, `daemon/loki-engine.ts`, `daemon/chats.ts`,
    `daemon/chat-events.ts`).** `DaemonChats` runs chats for the mod's chat frames: open, send, steer, abort,
    approve, answer, models, agents, providers, the passes, memory and skills. It finds each chat's engine and hands
    every per-chat call to it through one interface (`Engine`), with two adapters: `LokiEngine` on pi-durable, and
    `AcpEngine` (item 14). `DaemonChats` keeps only the rules about which engine a chat runs on: chosen before the
    first message, fixed after it. On loki's engine, a message sent while the chat is busy waits its turn, or with
    `steer` joins it; pi-durable's events become loki's chat events and are pushed to every socket. `ChatProjection` keeps a synchronous view of every chat (its details and
    its entries as thread steps), kept current from each store's commits. It exists because the mod asks about
    chats often and needs an answer at once (the chat list, the Inbox, a thread's page, Learn's cursor), while
    pi-durable answers asynchronously.
13. **The usage ledger (`daemon/usage.ts`).** What every model call cost, by hour, agent, model and origin (the
    person's chats, helpers, or a background pass), in `state/usage.json`, for the usage page. pi-durable adds each
    call's tokens and cost into its conversation's `pi.usage` but keeps no time, so the ledger follows each store's
    commits and adds what grew to the commit's hour. It remembers each chat's last totals in the same file, so a
    restart counts nothing twice, and takes the totals of chats it has never seen as history. That history comes in
    once from analytics instead: on its first start the ledger reads the `turn_finished` lines from before it began
    (`seeded_until` in the file), their cost as `other` since a line has only the total. It does not depend on
    analytics otherwise: `LOKI_ANALYTICS=0` leaves it on.
14. **ACP agents (`daemon/acp/`, plan 020).** A chat whose engine is an ACP agent runs there instead of on
    pi-durable: its engine is `AcpEngine` (`daemon/acp/engine.ts`), which hands its send, stop, mode, model and
    commands to `AcpChats`. Each agent is one process
    (`process.ts`, on `@agentclientprotocol/sdk`, started on first use and again after it exits), offered no files
    or terminals; each chat is a session on it, loaded again after a restart. What the agent reports
    (`session/update`) becomes chat events and, as each message completes, `pi.user`, `pi.assistant` and
    `pi.tool-result` entries in the chat's own store, written without pi (`AgentStore.appendEntries`), so the
    projection, the Inbox, history and the passes read it as any chat; its reported usage goes into `pi.usage` for
    the ledger. Its permission requests are `Approvals.ask` cards. The agent's persona, memory and skills go in its
    system prompt (`prompt.ts`). loki's own tools reach the session through `loki-tools.ts` (plan 044): an MCP
    endpoint on a loopback port, one HTTP server per session with a key that names the chat, running the same tool
    bodies as on pi-durable (`ChatTool`, `daemon/chat-tools.ts`). The MCP servers the agent has on are handed over
    as their configs (`McpTools.acpServers`) and the agent connects to them itself; one that wants a sign-in asks
    for its page (a URL elicitation), shown as a card and opened in the Mac's browser (`open-url.ts`). The agents are Claude Code (through npx, pinned) and the person's own in
    `state/acp.json` (`agents.ts`); what each last offered (models, modes, commands) is kept in
    `state/acp-offered.json` for the picker. Settings › Engines shows how each stands.

## loki's own mod

`mod/index.ts` is loki's product code: everything that is not a chat. It runs inside the daemon on the same mod API
any other mod uses, and the daemon hands it the chats as its host (`chats` to read, `chat` to run). The host also
hands it the memory repos and their queue (`memory`, plan 046). The mod is bundled apart from the daemon, so a daemon
module with state of its own, imported there, would be a second copy; `test/build-mod.test.ts` keeps the queue out of
the mod's bundle.

1. **The canvas.** Widget files in `~/.loki/widgets/<desk>/` (`.json` kit widgets and `.tsx` React components),
   watched and pushed to the app; each chat's geometry and widget change log. A `.tsx` widget is agent-written code,
   so the app runs each in its own sandboxed iframe (`sandbox="allow-scripts"`, an opaque origin, `connect-src
   'none'`): it never sees the daemon token, the page or the network, and talks to the page only by `postMessage`,
   which `app/src/desk/widget-bridge.ts` checks (its data, `onSet`, its size, focus, and http(s) links). The frame
   document is `app/src/frame/`, served as `/widget-frame.html`; the shell sets the token only in the top-level page,
   since Tauri also runs its init script in subframes on Windows.
2. **Gestures.** What you did on the canvas since the last turn, appended to your next message by the mod's message
   transform.
3. **The agent's tools.** `canvas_read` (the canvas as you left it), `canvas_focus` (move your view to a widget),
   `chat_list` (the agents and open chats on this Mac and the paired Macs, with each chat's purpose line), and
   `suggestion_create`, `suggestion_list` and `suggestion_withdraw`. These four are marked read-only and listed in
   `NEVER_ASK` (`daemon/approvals.ts`), so no mode asks about them, and a call from a background pass fails.
4. **Suggestions** (`mod/suggestions.ts`). A chat's suggestions live on its own record, in its store on its home Mac,
   so they persist with no file of their own and move with the chat. That Mac carries out every action: a client
   sends `suggestion_decide` (send, draft, reject) or `suggestion_retarget`, routed by the chat like any chat frame;
   the mod moves the suggestion from pending to sending to its end in one step under the chat's lock, so the first
   action wins. A send is a `chat_send` request to the target's Mac that waits for its reply, with the suggestion's
   id as its `send_id` and a `<loki-suggested/>` mark in its context; a saved draft is a field on the target chat's
   record. `suggestion_add` exists only for `mod/task-migration.ts`, which turns each open task into a suggestion on
   its source chat's Mac once.
5. **Learn.** The cards, leads and lessons on disk and the section's frames; the cards are written by the daemon's
   Learn pass, in a hidden chat of the agent's own, so no chat you read is touched.
6. **The sockets.** The WebSocket server on `127.0.0.1:41414` for the desktop window and a browser tab, and the LAN
   listener on `0.0.0.0:41415` for paired phones (off by default). `mod/sockets.ts` holds both, and every push
   names who it is for: everyone, this Mac's tabs, or the paired Macs only (plan 052).
7. **The chat list and the inbox** (`mod/chat-listing.ts`). Which of this Mac's chats show, and what each row says.
   One rule decides which chats are the person's own: not hidden, not a background pass's, of an agent the person
   has, never a helper agent's. The chat list also shows archived chats, lessons and canvases with no chat; the
   inbox shows only open chats. Both lists, a paired Mac's view of this one and the `desk_title` push read their
   rows here.

## The ports, and why there are two

Both listeners belong to loki's mod inside the daemon. Each is guarded.

| port | listener | trusts | serves |
| --- | --- | --- | --- |
| 41414 | loopback (`mod/server.ts`) | the token in `~/.loki/token`, carried as `?t=` | `/ws` (every frame), `/health`, `/uploads`, agent faces |
| 41415 | LAN, off by default (`mod/lan.ts`) | a per-device `HttpOnly` cookie from pairing | the built canvas as a single-page app, `/pair`, `/me`, `/unpair`, and the same `/ws`, `/uploads` and faces |

1. **Why a socket at all.** The daemon runs in Node and the app runs in a browser context (the WebView, a tab or a
   phone). A socket is the only bridge between them. Every client speaks the same protocol over it, chats included.
2. **Why the token.** The shell writes `~/.loki/token` (mode 0600) and hands it to the page before any script runs;
   the daemon is told its path with `--token-file`. Only something that can read your files can connect.
3. **Why a second port for the phone.** A token in a URL is fine on one machine and useless on a network. The LAN
   listener serves the page to anyone (it is public code) but lets a device in only after `POST /pair` with a code
   from Settings › Phone, answered by a cookie the page's JavaScript never sees. The desktop token is refused there.
   From the canvas's side the difference is one flag: the served page carries `window.__LOKI__ = {lan: true}`,
   `boot.tsx` mounts `<Phone/>` instead of `<Shell/>`, and the same hooks connect to `/ws` with the cookie.
4. **Tailscale.** When Tailscale runs on the machine, the same 41415 listener is reached by the tailnet name, and
   `tailscale serve` can front it with https inside the tailnet. There is no third port of loki's own.

## One protocol

Every client speaks loki's frame protocol on `/ws`, and every frame is declared once in the frame table,
`core/frames.ts` (glossary.md: Frame, Frame table).

1. **Requests** (`history_get`, `chat_send`, `chat_approve`, `recall_grade` …) carry a `requestId` and are answered by
   their reply or by one `error`.
2. **Sends** (`gesture`, `seen_mark`, `lan_set` …) are answered by the pushes they cause.
3. **Pushes** (`desk`, `widgets`, `seen`, `chat_event`, `recall_changed` …) arrive unasked.

The table also says which frames a paired phone may send, and parses each frame before its handler sees it.
`mod/bridge.ts` routes a frame to its handler under `mod/frames/`; the chat frames' handler (`mod/frames/chat.ts`)
passes them to the daemon's `DaemonChats`. On the app's side, `FrameChatClient` (`core/attention/chat-client.ts`)
is the chat half of `useAttention`. One protocol replaced two: the desktop shell no longer relays anything, and a
browser tab and the phone no longer need a tunnel.

The UI calls a desk a chat and its widget surface the Canvas tab; the code and the wire keep the name desk. The
Inbox's marks live here too: `seen_mark` and `seen_unmark` are done and not done, `viewed_mark` is a look, and
`focus_add` reports engagement the mod cannot see. Each change pushes `seen`, so the desktop and a phone read the
same marks from the mod's `attention.json`.

## Following one message

You type in the chat box and press Enter.

1. The page shows your words at once and records them as your own send, so the echo is not shown twice.
2. It sends a `chat_send` request on `/ws` with your text, any images, and a context note with the local time and
   working folder.
3. The mod's router hands it to `DaemonChats.send`, which hands it to the chat's engine. On loki's own (`LokiEngine`),
   every mod's message transform runs; loki's own appends what you
   did on the canvas since the last turn.
4. The kernel submits the message to the agent's Harness. pi-durable saves it, renders the prompt sections
   (instructions, mod sections, the agent's memory, then history, in that order so the provider's prompt cache
   holds), and streams a request to the provider through pi-ai.
5. The model streams back thinking, text or tool calls. pi-durable saves each step; the daemon turns its events into
   chat events and pushes them as `chat_event` to every client following the chat.
6. Before a tool runs, the approval hook checks the permission mode. If you are needed, an approval card appears on
   every client, and the first answer wins. The tool runs on your machine, and its result goes into the next request.
7. The page's ThreadModel folds the steps into rows: the reply types out, tool markers appear, the status updates.
8. When the turn ends, the chat's Inbox card and sidebar reflect it. Later, once the chat is quiet, reflection may
   update the agent's memory.

If the daemon dies mid-turn, the shell starts it again, the store reopens, and the turn resumes from its last saved
step. A tool that was mid-run and is not safe to repeat is reported to the model as interrupted.

## Several Macs

Plan 023 (`docs/plans/2026-10-18-023-feat-loki-multi-mac-plan.md`) lets one person's Macs share their agents. Each
Mac still runs its own daemon over its own `~/.loki`, and every chat still has exactly one writer: the Mac it lives
on, its **home**. The Macs talk to each other directly over the tailnet; there is no server. `mod/peering.ts` wires
every piece below once and hands the rest of the mod what it needs: the routes for the listener, the router for the
bridge, Settings › Macs' frames, and the lists with the paired Macs' chats in them.

1. **Pairing** (`mod/peers.ts`). A Mac is named by its install id (`state/device-id`) and its own name. Two Macs pair
   with a code over the phone listener's port, tailnet only: each mints a token for the other, keeps its hash in
   `state/peers.json` and the other's token in the keychain. While any Mac is paired the listener stays up with the
   phone switch off (the phone's routes then answer 404), and the daemon holds `caffeinate -s` (`daemon/awake.ts`).
2. **The peer link** (`mod/peer-link.ts`). One socket from each Mac to every paired Mac's `/ws`, with a bearer token,
   reconnecting with backoff. Its first frame, `peer_ping`, also compares the peer protocol (`PEER_PROTOCOL`): a Mac
   on another one is "outdated" and asked nothing. A paired Mac's socket has its own allow-list (`PEER_FRAMES`, the
   `peer` flag in `core/frames.ts`), never the desktop's or the phone's.
3. **Agents** (`daemon/store/agent-sync.ts`, `mod/peer-agents.ts`). Agent ids are the same on every Mac. Each record
   field carries when and where it last changed and the later change wins; `home_mac` is one of them. A delete
   leaves a tombstone (`backend/tombstones.json`). Only an agent's home creates its main chat.
4. **Chats** (`mod/remote-chats.ts`, `mod/chat-directory.ts`, `mod/chat-router.ts`). A chat is a single-writer actor
   at its home; frames are its messages and the peer link carries them one hop. Each Mac lists its own chats and
   every paired Mac's, fetched over the link and marked with their home (`home`, `home_name`, `reachable` on desks and
   Inbox rows); the lists are for showing only. Where a chat lives is the chat directory's: this Mac's chats from its
   store, each paired Mac's from its own word (its list, its `chat_left`), and a chat no one claimed asked for
   (`peer_where`). A Mac that let a chat go keeps a forwarding note and answers a stale frame with an error carrying
   `moved_to`, which the asking Mac follows once. The bridge sends a chat or canvas frame about another Mac's chat
   there as it is (`route`) and passes back the pushes of the Mac the directory names for that chat, so Macs never
   echo each other. A new chat's home is its agent's while that Mac is in reach (`chat_create`'s `home`). Files
   attached here go to the home's uploads first.
5. **Memory** (`daemon/memory-sync.ts`, `mod/peer-memory.ts`). After a repo settles in its queue
   (`daemon/repo-queue.ts`) paired Macs are told (`memory_changed`) and fetch the commits they lack as a git bundle,
   merged in the same queue. A clash keeps the home's text and writes the other side to `conflicts/sync.md`, which
   reflection reads. Background passes read each chat on the Mac it lives on; a moved chat's cursors go with it.
6. **The person's state and config** (`mod/peer-state.ts`). One snapshot, pulled on connect, on `state_changed` and
   every five minutes: marks with times (`unseen` beside `seen`), focus per Mac summed (`combineFocus`), pins and
   label colours with change times, Learn and mods file by file (`mod/recall-sync.ts`), mcp.json entry by entry
   (`daemon/config-sync.ts`). A `state_changed` names the folders that changed (`learn`, `mods`), and only those of
   Learn's and the mods' files come with the small parts; on connect and every five minutes all of it comes.
7. **Moving chats** (`daemon/chat-move.ts`, `mod/chat-moves.ts`). Once after pairing, and when an agent's home is
   set, a Mac takes over the idle chats of agents homed on it: copied out, imported under the same id, then hidden on
   the old Mac with its schedules stopped. `chat_move` moves one chat by hand: routed to the Mac it lives on, which
   asks the target to take it (`peer_chat_take`) the same way. `ChatMoves` holds both sides of a move and is the
   peer frames' `moves`; its tests join two of them with an in-memory link.
8. **What wakes each syncer** (`mod/peer-sync.ts`). The links hand every status and push to `PeerSync`, where each
   syncer (agents, memory, moves, state, group, directory) names the pushes that wake it, what it does when a Mac
   comes into reach, and the syncer it waits for: agents, then their memory, then the chats that move with them;
   the rest side by side. A failure is logged (`peers:sync-failed`) and stops no other syncer. A chat moved by hand, or started away from its agent's
   home, is `placed` (its ChatInfo) and the hand-over skips it. A chat coming back to a Mac that let it go sets the
   hidden copy aside under a new key first (`AgentStore.retireChat`).

## Where things live on disk

Everything is under `~/.loki` (`LOKI_DIR` overrides it, for tests and a second loki).

1. `token`: the capability token the shell, the page and the daemon share.
2. `daemon.lock`: the pid of the daemon serving this folder.
3. `daemon/`, `mod/`, `app/`: the installed daemon bundle, mod bundle and phone canvas (release builds).
4. `stores/<agentId>.sqlite`: each agent's chats, in pi-durable's SQLite format; `stores/migrations.json`, each
   store's migration version; and `stores/backup-…/`, whole copies made before a migration.
5. `backend/`: agent records (`agents/`) and memory repos (`memfs/<id>/memory/`).
6. `widgets/<desk>/`: the files agents write onto the canvas.
7. `state/`: small JSON files: schedules (`crons.json`), pins, the Inbox's marks (`attention.json`), the LAN switch,
   paired devices, each chat's canvas, and which migrations of records and memory have run (`migrations.json`).
8. `mods/`: mods of your own, loaded after loki's.
9. With paired Macs (plan 023): `state/peers.json` (the Macs and their token hashes), `backend/tombstones.json`
   (agents deleted anywhere), `state/mcp-sync.json` and `recall/.sync.json`, `mods/.sync.json` (what was seen last,
   to notice changes), and in each agent's memory `conflicts/sync.md` while a clash waits for reflection.
10. `logs/`: `daemon.log` (the daemon's output, appended across restarts) and `events.jsonl` (the local usage
   events).

Outside it: the global skills in `~/.agents/skills` (loki's own skill is installed at `~/.agents/skills/loki`),
and provider credentials in the OS keychain.

## One way per job

A few jobs come up everywhere. Each has one helper in `core/`, so code that does the job looks the same wherever it is
(plans 054 and 059). Lint flags a hand-written listener set and a hand-written error message; a queue or a burst
timer written by hand stays a convention, as its shape is also ordinary code:

1. **Telling others something changed**: `Listeners` (`core/listeners.ts`). `add` returns the way to stop, and `emit`
   tells everyone.
2. **Async work one piece at a time**: `serialQueue()`, or `keyedQueue()` for one queue per repo, chat or provider
   (`core/serial.ts`). A failure never blocks the next piece.
3. **A burst of calls as one run**: `coalesce` when a steady stream should still run every so often (a redraw, a
   write), `debounce` when it should wait for quiet (a folder still being written) (`core/timers.ts`). Per desk,
   `ScopeDebouncer`.
4. **Talking to the daemon from the app**: a chat's calls through `ChatStore`, settings through `daemonCalls`.
5. **An error in words**: `messageOf(err)` (`core/errors.ts`).
6. **Something with a real and a test version**: an interface it is given (a `Pick` of the real class, or a small
   interface), rather than a class it builds. `DaemonChats` still builds its two engines itself.

## Where the code lives

1. `daemon/`: the daemon. `main.ts` wires it; `kernel/` is the only door to pi-durable; `store/` the agent records;
   `mods/` the mod API and registry; the rest one file per capability
   (approvals, providers, memory, tools, skills, subagents, background, schedule, the passes, reflection, Learn, chats).
2. `mod/`: loki's own mod. `index.ts` wires it, and `peering.ts` the paired Macs; `server.ts` and `lan.ts` hold the ports, and `sockets.ts` pushes to them; `bridge.ts` routes each
   frame to its handler under `frames/` (one module per feature: chats, desks, seen marks, history, folders, Learn,
   suggestions, agents, the phone listener); `desk-store.ts`, `persist.ts` and `widgets-fs.ts` keep each chat's canvas
   and watch widget files; `widget-log.ts` keeps each chat's widget change log; `chat-source.ts` reads chats from the
   daemon's projection; `seen.ts` keeps the done and viewed marks and the focus weights; `gestures.ts` turns what you
   did into the message note; `suggestions.ts` and `task-migration.ts` keep the suggestions and move Tasks into them
   once; `pins.ts`, `folders.ts`, `agents.ts`, `reflection.ts`, `skills.ts` and `recall.ts` back pins, folders, the
   Agents pages and Learn; `pairing.ts`, `devices.ts`,
   `tailscale.ts` and `static.ts` are the phone listener; `boot.ts` re-bundles the mod on each reload in a checkout.
3. `core/`: pure TypeScript both halves import (no I/O, no framework). `desk-core.ts` (the shared vocabulary),
   `frames.ts` (the frame table) with `frame-types.ts`, `daemon-calls.ts` (the settings and agent calls over it), `harness.ts` (recognising harness markup in transcripts),
   `attention/` (the Inbox: the chat client, the attention model, queue and focus
   ranking, `chat-store.ts` with every chat's state and calls, and `useAttention` over it; `thread.ts` is the ThreadModel and `pi-steps.ts` reads Pi's messages as its steps), and
   `recall/` (Learn's cards and scheduling).
4. `app/src/`: the canvas. `boot.tsx` picks the surface; `shell/` is the desktop frame (rail, Chats sidebar, ⌘K
   search, keymap, Welcome, Preferences host); `desk/` a chat's pane (Messages and Canvas tabs, widget frames);
   `chat/` the thread, composer and suggestion cards; `agents/`, `recall/` (Learn) and `settings/` the other sections;
   `phone/` the phone; `shared/` logic both surfaces share; `components/` the chrome primitives; `kit/` the tokens
   and the widget kit (`@loki/kit`).
5. `src-tauri/src/`: the Rust shell. `lib.rs` wires it and supervises the daemon; `harness.rs` starts and stops it;
   `node.rs` finds Node; `procs.rs` finds a leftover daemon; `install.rs`
   puts the bundles and the skill in place; `widgets.rs` transpiles `.tsx` widgets; `native.rs` and `menu.rs` the
   Mac's tray, badge, shortcut and menu bar.
6. `scripts/`: `dev.ts` (`npm start` and `npm run dev`), `build-mod.ts` (the daemon and mod bundles the app ships), `trial.ts` (the
   timing trial), `smoke.ts` (the built bundle in a scratch home), `cask.ts`, `release.ts` and
   `analytics.ts`.
7. `test/` (vitest, on Node) and `test-node/` (Node's own runner: SQLite stores, resuming after a crash, mods from a folder).

## One codebase, three systems

Windows and Linux are preview builds of the same code, with a few seams where the systems differ. Each seam is one
place, and the Mac's side of it is what shipped first.

1. **The page learns the system once.** The shell's init script puts `os` (`macos`, `windows`, `linux`) in
   `window.__LOKI__`; `platform` in `app/src/desk/env.ts` reads it, or a browser tab's user agent. Keys, chrome,
   copy and gating read that one value; `core/` stays system-free (`test/core-portability.test.ts`).
2. **Keys come from the keymap.** `formatKeys` in `app/src/shell/keymap.ts` writes ⌘ ⌥ ⇧ on the Mac and Ctrl,
   Alt, Shift elsewhere; a binding whose Mac key the other system keeps for itself carries its own keys there
   (`keysOn`), and a label that only fits there its own label (`labelOn`). `os-words.ts` holds the other
   per-system words (this Mac, this PC, this computer; Finder, File Explorer).
3. **Mac extras exist only on macOS.** The tray, dock badge, global shortcut and native menu bar are compiled under
   `cfg(target_os = "macos")` with Mac-only dependencies; dictation, phone pairing and Tailscale are hidden in the
   page, which says the feature "isn't on Windows yet" (or Linux) where it would appear.
4. **loki's own title strip.** The window is undecorated on Windows and Linux; `TitleStrip` in
   `app/src/shell/sidebar.tsx` draws ☰ (the Mac's menu groups) and minimise, maximise and close.
   `tauri-plugin-single-instance` keeps one loki per user, and Linux runs under XWayland (`GDK_BACKEND=x11` unless
   set).
5. **Finding a leftover daemon.** `procs.rs` reads the process list through `sysinfo` on every system and matches
   the daemon's command line (`--loki-daemon` and loki's token file).
6. **Finding Node and other programs.** `node.rs` looks at `LOKI_NODE_BIN`, then PATH, then the folders a GUI app
   does not see on its short PATH: Homebrew's prefixes, volta, nvm, fnm and npm's global bin, and on Windows the
   nodejs.org installer's folder, nvm-windows, fnm and scoop. Nothing new enough becomes Welcome's Node step, with
   this system's usual install line. The mod finds `tailscale` (and `bd`, for the one-time move of open tasks)
   through `mod/programs.ts`, which tries each `PATHEXT` name on Windows.
7. **Home and folders.** `~` is `USERPROFILE` on Windows (what Node's `os.homedir()` reads), `HOME` elsewhere; the
   old-root link and the skill link fall back to a junction where Windows refuses a symlink.
8. **Builds.** CI runs on a PR: the vitest suite on macOS, Ubuntu and Windows, types, lint and the bundles once, and
   `cargo test` on all three when the shell changes (`ci.yml`, `shell.yml`); a release builds
   the `.dmg`, the NSIS `-setup.exe`, and the AppImage and `.deb` on one runner each ([releasing.md](releasing.md)).
