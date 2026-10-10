# loki · the execution model

loki runs its agents itself. A small Rust shell opens the window and keeps one long-lived Node process running,
loki's **daemon**, which holds every agent, every chat and every tool. This document is the map: which processes
run on your machine, what each one owns, the path a message takes, and where each piece lives in the repo.

Until October 2026 loki sat on top of Letta Code and ran inside its `letta server` process. Plan 017
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
4. **The canvas: what you see.** loki's own mod, running inside the daemon, owns each chat's widgets, gestures, the
   board, Learn and the sockets the app connects to. The React app renders it in three clients: the desktop window, a
   browser tab on the same machine, and a paired phone.

Only the first lives elsewhere. The memory, the hands and the canvas are all on your machine, in one process.

## Which of these are processes

```text
loki (Rust shell, Tauri)                          the window, tray, dock badge, global shortcut
└── node daemon.mjs --loki-daemon                 loki's daemon: one process for every agent
      --dir ~/.loki --mod …/loki-mod.mjs
      --token-file ~/.loki/token
    ├── pi-durable Harness per agent              ~/.loki/stores/<agentId>.sqlite
    ├── loki's mod (canvas, board, Learn, /ws)    listens on 127.0.0.1:41414, and 0.0.0.0:41415 when the phone is on
    └── children: bash commands, background tasks, git, bd, ripgrep
```

1. **The shell starts the daemon and keeps it alive.** At launch it finds Node 22.19 or newer (`node.rs`), stops a
   daemon an earlier loki left behind (`procs.rs`, matched by its command line and start time), and starts a new
   one (`harness.rs`). A release build runs the installed bundle, `~/.loki/daemon/daemon.mjs`; a development build
   runs the checkout's `daemon/main.ts` with `mod/boot.ts`. The daemon's output is appended to
   `~/.loki/logs/daemon.log`.
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
5. **There are no other long-lived processes.** No Letta, no app-server, no port 41600. The children are short-lived
   or belong to a chat: an agent's bash commands and background tasks, `git` for memory commits, `bd` for the board,
   `rg` for search when it is installed.

The model is a remote service, not a process on your machine.

## Inside the daemon

`daemon/main.ts` wires these pieces together, in this order: the lock, the keychain, the stores, the extensions
every chat gets, the chats, then the mods.

1. **The kernel (`daemon/kernel/`).** The only code that imports pi-durable. Each agent has one pi-durable
   `Harness` over one SQLite file, `~/.loki/stores/<agentId>.sqlite`, opened on first use. pi-durable saves every
   model step and tool result before it is shown, so a turn cut off by a crash resumes from its last save when the
   store reopens. One file per agent spreads the writes, and a storage failure closes only that agent's chats; the
   store manager reopens it. pi-durable numbers its own conversations, so a document in each store maps loki's chat
   ids (`local-conv-…`, and `default` for an agent's main chat) to them. Keeping the old id format means chats
   imported from Letta keep their ids, and with them their widgets, Inbox marks, pins and board stamps.
2. **Agent records and memory (`daemon/store/agents.ts`, `daemon/memory.ts`).** Under `~/.loki/backend`, in the
   layout Letta's local backend used: `agents/<id>.json` for the record, `memfs/<id>/memory/` for the memory repo.
   Keeping the layout let the importer copy agents as they were and let the Agents page read them unchanged. The
   memory repo's `system/` files go into the prompt; the rest is listed by path. Each change is a git commit, by
   the agent, or by "Reflection".
3. **Models and keys (`daemon/providers.ts`, `daemon/credentials.ts`).** Every provider pi-ai knows. Credentials
   (API keys, or the tokens from signing in with ChatGPT) are kept in the OS keychain through `@napi-rs/keyring`,
   one entry per provider under the service "loki". A key is tried before it is kept. Anthropic's subscription
   sign-in is not offered, because pi-ai implements it by presenting itself as Claude Code; an Anthropic API key
   works instead. Without a reachable keychain, keys come from environment variables only, and the log says so.
4. **Approvals and questions (`daemon/approvals.ts`, `daemon/ask.ts`).** A hook before every tool call decides by
   the chat's permission mode (GLOSSARY.md: Permission mode) whether to ask. The question goes to every client
   following the chat and the first answer wins. The answer is saved with the tool call, so a turn resumed after a
   crash never asks twice. `AskUserQuestion` shows a question card the same way.
5. **Tools.** pi-durable's own `read`, `write`, `edit` and `bash`; loki's `ls`, `find`, `grep` and `view_image`
   (`daemon/tools.ts`); web search over DuckDuckGo's plain HTML results, which need no key
   (`daemon/web-search.ts`); the memory tools.
6. **Skills (`daemon/skills.ts`).** The prompt lists every skill the agent has by name and description: the global
   ones in `~/.agents/skills` and the agent's own in its memory's `skills/` folder. The `Skill` tool hands over a
   skill's full text when the agent needs it. The chat folder's `AGENTS.md` (or `CLAUDE.md`) is a section of its
   own.
7. **Subagents (`daemon/subagents.ts`).** The `Agent` tool runs a helper in a child conversation that the call owns,
   with the parent's model, tools, folder and permission mode. Aborting the call aborts the helper. Helpers are not
   agent records, so they never appear in the Agents list.
8. **Background and scheduled tasks (`daemon/background.ts`, `daemon/schedule.ts`).** A background bash command
   keeps running after its turn; the agent reads its output, writes to it, waits on it or stops it, and its chat
   gets a `<task-notification>` when it ends. Scheduled prompts are kept in `~/.loki/state/crons.json` and checked
   once a minute; a slot missed while loki was closed fires once at the next start.
9. **Reflection (`daemon/reflection.ts`).** Once a chat has been quiet, and the agent's settings say so, a hidden
   chat of the same agent with only the memory tools reads what happened and updates memory. It never runs during a
   turn, so it never competes with you for the model.
10. **The mod registry (`daemon/mods/`).** loki's mod API, version 1 (`daemon/mods/api.ts`): a mod registers tools
    and prompt sections, gets a say before a tool runs, transforms the person's message before it is sent, and
    listens to turn events. Each mod becomes one pi-durable extension shared by every agent's store, so one install
    reaches every chat. loki's own mod (`mod/index.ts`) is loaded first; then any file in `~/.loki/mods`. Editing a
    mod reloads it in place: work already under way finishes on the old code and the next step uses the new. A mod
    built for a newer major API version is refused.
11. **The chats (`daemon/chat-backend.ts`, `daemon/chats.ts`, `daemon/chat-events.ts`).** `DaemonChats` runs chats
    for the mod's chat frames: open, send, steer, abort, approve, answer, models, agents, providers, reflection,
    memory and skills. A message sent while the chat is busy waits its turn. pi-durable's events become loki's chat
    events and are pushed to every socket. `ChatProjection` keeps a synchronous view of every chat (its details and
    its entries as thread steps), kept current from each store's commits. It exists because the mod asks about
    chats often and needs an answer at once (the chat list, the Inbox, a thread's page, Learn's cursor), while
    pi-durable answers asynchronously.
12. **The import from Letta (`daemon/import/`).** A one-time, repeatable import, run from Settings › loki › Import.
    It copies agents (with their memory's git history), every conversation under its Letta id, keys into the
    keychain, permission modes and folders onto chats, schedules and Learn's cursors. It refuses while Letta runs and
    never writes to Letta's files. A second run imports only what is missing.

## loki's own mod

`mod/index.ts` is loki's product code: everything that is not a chat. It runs inside the daemon on the same mod API
any other mod uses, and the daemon hands it the chats as its host (`chats` to read, `chat` to run).

1. **The canvas.** Widget files in `~/.loki/widgets/<desk>/` (`.json` kit widgets and `.tsx` React components),
   watched and pushed to the app; each chat's geometry and widget change log.
2. **Gestures.** What you did on the canvas since the last turn, appended to your next message by the mod's message
   transform, with any board tasks assigned to the chat.
3. **The agent's tools.** `desk_state` (the canvas as you left it), `loki_camera` (move your view to a widget) and
   `loki_task` (the board).
4. **The board.** Tasks for later in beads, through `bd`.
5. **Learn.** The card writer and leads; it asks the agent in a hidden writer chat of its own, so no chat you read is
   touched.
6. **The sockets.** The WebSocket server on `127.0.0.1:41414` for the desktop window and a browser tab, and the LAN
   listener on `0.0.0.0:41415` for paired phones (off by default).

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
`core/frames.ts` (GLOSSARY.md: Frame, Frame table).

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
3. The mod's router hands it to `DaemonChats.send`. Every mod's message transform runs; loki's own appends what you
   did on the canvas since the last turn and the board tasks assigned to this chat.
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

## Where things live on disk

Everything is under `~/.loki` (`LOKI_DIR` overrides it, for tests and a second loki). On first start the shell
renames an old `~/.letta/loki` to `~/.loki` and leaves a link at the old path (a symlink, or a junction on
Windows), so paths written in agents' memories and old widget references still resolve (`src-tauri/src/root.rs`).

1. `token`: the capability token the shell, the page and the daemon share.
2. `daemon.lock`: the pid of the daemon serving this folder.
3. `daemon/`, `mod/`, `app/`: the installed daemon bundle, mod bundle and phone canvas (release builds).
4. `stores/<agentId>.sqlite`: each agent's chats, in pi-durable's SQLite format.
5. `backend/`: agent records (`agents/`) and memory repos (`memfs/<id>/memory/`).
6. `widgets/<desk>/`: the files agents write onto the canvas.
7. `state/`: small JSON files: schedules (`crons.json`), pins, the Inbox's marks (`attention.json`), the LAN switch,
   paired devices, each chat's canvas, and a record of the import from Letta.
8. `mods/`: mods of your own, loaded after loki's.
9. `logs/`: `daemon.log` (the daemon's output, appended across restarts) and `events.jsonl` (the local usage
   events).

Outside it: the global skills in `~/.agents/skills` (loki's own skill is installed at `~/.agents/skills/loki`),
and provider credentials in the OS keychain.

## Where the code lives

1. `daemon/`: the daemon. `main.ts` wires it; `kernel/` is the only door to pi-durable; `store/` the agent records;
   `mods/` the mod API and registry; `import/` the import from Letta; the rest one file per capability
   (approvals, providers, memory, tools, skills, subagents, background, schedule, reflection, chats).
2. `mod/`: loki's own mod. `index.ts` wires it; `server.ts` and `lan.ts` hold the ports; `bridge.ts` routes each
   frame to its handler under `frames/` (one module per feature: chats, desks, seen marks, history, folders, Learn,
   the board, agents, the phone listener); `desk-store.ts`, `persist.ts` and `widgets-fs.ts` keep each chat's canvas
   and watch widget files; `widget-log.ts` keeps each chat's widget change log; `chat-source.ts` reads chats from the
   daemon's projection; `seen.ts` keeps the done and viewed marks and the focus weights; `gestures.ts` turns what you
   did into the message note; `tasks.ts`, `pins.ts`, `folders.ts`, `agents.ts`, `reflection.ts`, `skills.ts` and
   `recall.ts` back the board, pins, folders, the Agents pages and Learn; `pairing.ts`, `devices.ts`,
   `tailscale.ts` and `static.ts` are the phone listener; `boot.ts` re-bundles the mod on each reload in a checkout.
3. `core/`: pure TypeScript both halves import (no I/O, no framework). `desk-core.ts` (the shared vocabulary),
   `frames.ts` (the frame table) with `frame-types.ts`, `harness.ts` (recognising harness markup in transcripts,
   including imported Letta history), `attention/` (the Inbox: the chat client, the attention model, queue and focus
   ranking, `useAttention`; `thread.ts` is the ThreadModel and `pi-steps.ts` reads Pi's messages as its steps), and
   `recall/` (Learn's cards and scheduling).
4. `app/src/`: the canvas. `boot.tsx` picks the surface; `shell/` is the desktop frame (rail, Chats sidebar, ⌘K
   search, keymap, Welcome, Preferences host); `desk/` a chat's pane (Messages and Canvas tabs, widget frames);
   `chat/` the thread and composer; `board/`, `agents/`, `recall/` (Learn) and `settings/` the other sections;
   `phone/` the phone; `shared/` logic both surfaces share; `components/` the chrome primitives; `kit/` the tokens
   and the widget kit (`@loki/kit`).
5. `src-tauri/src/`: the Rust shell. `lib.rs` wires it and supervises the daemon; `harness.rs` starts and stops it;
   `node.rs` finds Node; `procs.rs` finds a leftover daemon; `root.rs` moves the root to `~/.loki`; `install.rs`
   puts the bundles and the skill in place; `widgets.rs` transpiles `.tsx` widgets; `native.rs` and `menu.rs` the
   Mac's tray, badge, shortcut and menu bar.
6. `scripts/`: `dev.ts` (`bun start`), `build-mod.ts` (the daemon and mod bundles the app ships), `trial.ts` (the
   timing trial), `pi-import-check.ts` (checks the import against real Letta logs), `cask.ts`, `release.ts` and
   `analytics.ts`.
7. `test/` (bun) and `test-node/` (Node: SQLite stores, resuming after a crash, mods from a folder).

## One codebase, three systems

Windows and Linux are preview builds of the same code, with a few seams where the systems differ. Each seam is one
place, and the Mac's side of it is what shipped first.

1. **The page learns the system once.** The shell's init script puts `os` (`macos`, `windows`, `linux`) in
   `window.__LOKI__`; `platform` in `app/src/desk/env.ts` reads it, or a browser tab's user agent. Keys, chrome,
   copy and gating read that one value; `core/` stays system-free (`test/core-portability.test.ts`).
2. **Keys come from the keymap.** `formatKeys` in `app/src/shell/keymap.ts` writes ⌘ ⌥ ⇧ on the Mac and Ctrl,
   Alt, Shift elsewhere; a binding whose Mac key the other system keeps for itself carries its own keys there
   (`keysOn`), and a label that only fits there its own label (`labelOn`). `osWords.ts` holds the other
   per-system words (this Mac, this PC, this computer; Finder, File Explorer).
3. **Mac extras exist only on macOS.** The tray, dock badge, global shortcut and native menu bar are compiled under
   `cfg(target_os = "macos")` with Mac-only dependencies; dictation, phone pairing and Tailscale are hidden in the
   page, which says the feature "isn't on Windows yet" (or Linux) where it would appear.
4. **loki's own title strip.** The window is undecorated on Windows and Linux; `TitleStrip` in
   `app/src/shell/Sidebar.tsx` draws ☰ (the Mac's menu groups) and minimise, maximise and close.
   `tauri-plugin-single-instance` keeps one loki per user, and Linux runs under XWayland (`GDK_BACKEND=x11` unless
   set).
5. **Finding a leftover daemon.** `procs.rs` reads the process list through `sysinfo` on every system and matches
   the daemon's command line (`--loki-daemon` and loki's token file).
6. **Finding Node and other programs.** `node.rs` looks at `LOKI_NODE_BIN`, then PATH, then the folders a GUI app
   does not see on its short PATH: Homebrew's prefixes, volta, nvm, fnm and npm's global bin, and on Windows the
   nodejs.org installer's folder, nvm-windows, fnm and scoop. Nothing new enough becomes Welcome's Node step, with
   this system's usual install line. The mod finds `bd` and `tailscale` through `mod/programs.ts`, which tries each
   `PATHEXT` name on Windows.
7. **Home and folders.** `~` is `USERPROFILE` on Windows (what Node's `os.homedir()` reads), `HOME` elsewhere; the
   old-root link and the skill link fall back to a junction where Windows refuses a symlink.
8. **Builds.** CI runs the bun tests, the Node tests and `cargo test` on macOS, Ubuntu and Windows; a release builds
   the `.dmg`, the NSIS `-setup.exe`, and the AppImage and `.deb` on one runner each ([RELEASING.md](RELEASING.md)).
