# loki · the execution model

loki sits on top of [Letta Code](https://docs.letta.com). To place it you have to know how Letta
runs an agent, because loki is one layer of a four-layer stack. This document is that map: the four
responsibilities, which of them are real processes on your Mac, and the path a message takes.

## The four responsibilities

Picture the agent as a remote worker with a brain, a memory, a pair of hands, and a desk. Four jobs,
and each can live in a different place. That separation is the whole reason the system has moving
parts.

**1. The model — the thinking.** A provider language model such as Claude. It turns the assembled
context and the tool list into the next move: some text, a tool call, or both, streamed back token by
token. It keeps no state of its own, so every call is handed the full story again. It always lives at
a provider, reached with the keys set under Settings › providers.

**2. The Letta server — the memory and the coordination.** This is the stateful agent: its persona,
its memory files, its identity, and the conversation history. It runs the agent loop — gather memory
plus history plus tools, call the model, apply the result and any memory edits. It owns the
git-backed memory filesystem. **This is the layer that "local mode" and "cloud mode" choose between:**
local means it lives on your Mac under `~/.letta/lc-local-backend`; cloud means it lives at
`api.letta.com`.

**3. The harness — the hands.** The `letta` program running as `letta server`. It is a real computer's
worth of capability: it runs the coding tools (shell, file read and edit, search) on an actual
machine, enforces the permission mode, raises approvals, and hosts mods. **Tools always execute
here, never in the cloud brain**, because this is the machine that has your files. loki's mod lives
inside this process.

**4. loki — the desk and the window.** The mod (inside the harness) owns the desk: widget files,
geometry, gestures, the board, pins, and reading agent memory for the Agents page. The Rust shell is
the native window that finds or installs and starts the harness, holds the authenticated socket, and, on
the Mac, draws the tray, dock badge and global shortcut. The canvas renders chat, inbox, board, agents and the
widgets themselves. The same canvas has three clients: the desktop window, a browser tab on the Mac,
and — when Settings › phone is on — a phone on the Wi‑Fi, which the mod serves directly and which has its
own presentation (`app/src/phone/`): Home, Inbox, Agents and More, with a desk's conversation, search and
Learn a page away, and no widget canvas.

## The one rule that removes the confusion

**The brain and the memory can move to the cloud. The hands cannot.** Switching the backend to cloud
moves where the agent remembers (layer 2) and leaves the thinking with the provider (layer 1), but the
tools still run on a machine with your files (layer 3). That single fact reconciles everything else:
"the agent runs in the cloud" is only ever about layers 1 and 2; layer 3 is always a real computer.

In cloud mode the cloud is a coordinator, not an executor. When the model emits a tool call, the cloud
routes it down to a registered *computer* — a machine running `letta server` — which runs it locally
and returns the result. Letta's own words when you register one: "messages will be executed locally on
this computer." Letta can also host its own remote computers and sandboxes; then tools run there
instead of your Mac, but it is still a computer running the harness, never the bare cloud API.

## Which of these are processes

On your Mac, in local mode, there are only two processes that matter, and they are parent and child:

```text
loki (Rust shell)                     ← the desktop window
└── letta server (one Node process)   ← harness + app-server + local backend + loki's mod
```

The surprising part is the child. A single `letta server` process is the harness, the app-server, the
local backend, **and** the host of loki's mod all at once. There is no separate backend daemon in
local mode; the memory is code and files inside that one process. It listens on two ports (below), and
both trace back to it.

On Windows the child is `node …\letta-code\letta.js server` rather than npm's `letta.cmd` shim, started with no
console window inside a Job Object that ends the whole tree when loki's handle closes, so quitting never leaves a
node holding 41600. On Windows and Linux a harness an earlier loki started and left running on 41600 is adopted
and stopped on quit like one it started; the Mac never adopts.

The model is a remote service, not a process on your machine. The Letta *cloud* backend, when you use
it, is a remote service too. The loki mod is not its own process — it is code inside the `letta`
process. So the server and the harness are the same process locally; they only become genuinely
separate in cloud mode, and even then the server half is not on your Mac.

## The two ports, and why the mod needs one

The harness process listens on two loopback ports, each token-guarded — and, only when you switch it
on, a third on the local network, guarded by a per-device cookie:

| port | server | speaks |
| --- | --- | --- |
| 41600 | the app-server (Letta Code) | the agent list, runtime subscriptions, streaming, approvals (the inbox's conversation list is the mod's, from disk) |
| 41414 | loki's mod, loopback | desk state, gestures, each desk's widget change log, the board, agents, pins, folders, done / viewed / snooze marks, Learn, agent faces, and the app-server tunnel |
| 41415 | loki's mod, LAN (off by default) | the canvas build as a single-page app, `/pair` `/me` `/unpair`, and the same `/ws`, `/appserver` and face routes for paired phones |

When Tailscale runs on the Mac the same 41415 listener is reached by the tailnet name instead of the Wi‑Fi
one (`lan_status.via`), and `tailscale serve` can optionally front it with https on 443 inside the tailnet,
forwarding to `127.0.0.1:41415` — no fourth port of loki's own.

The mod exposes its own port because its code runs in Node while the loki UI runs in a browser
context — the WebView or a tab — and Node cannot reach into a browser page any other way. A loopback
socket is the bridge. It carries three things: loki's own protocol (widgets, gestures, board, agents),
which the app-server knows nothing about; static pieces like agent face images; and a `/appserver`
tunnel, because the real app-server refuses browser origins and wants a bearer token a browser cannot
set. In the desktop shell the app-server frames instead ride the Rust side's authenticated link, which
can set that header; the mod's port is still used for everything that is loki's own. A browser tab, and
the phone, use the tunnel.

The phone is the reason for the second mod port. The loopback port trusts a token the page carries in
its URL, which is fine on one machine and useless on a network. The LAN listener trusts nothing by
default: it serves the page to anyone (public code), and lets a device in only after `POST /pair` with a
code from Settings › phone, answered by an `HttpOnly` cookie the page's JavaScript never sees. From the
canvas's side the difference is one flag: the served `index.html` carries `window.__LOKI__ = {lan: true}`,
`modBase()` becomes the page's own origin, `boot.tsx` mounts `<Phone/>` instead of `<Shell/>`, and the
same `useDesk` and `useAttention` hooks connect to `/ws` and `/appserver` with an empty `?t=` — the
cookie does the authenticating. Settings › phone itself speaks to the mod over the loopback socket
(`lan_get`, `lan_set`, `pair_begin`, `devices_list`, `device_forget`) and hears `lan_status`,
`pair_code` and `devices` back.

## Two protocols on one page

The canvas speaks two protocols, and knowing which one owns a thing tells you where to look.

1. **Letta's app-server protocol** (the Rust link or the `/appserver` tunnel; `core/attention/protocol.ts`,
   `app/src/shell/transport.ts`): the agent list, conversations, streaming turns, approvals, models and
   permission modes. A desk's name is Letta's conversation `summary`, so renaming a desk is a
   `conversation_update` over this socket, not a mod frame; archiving and restoring are the same call.
2. **loki's own protocol** (the mod's `/ws`; documented frame by frame at the top of `mod/bridge.ts`):
   `desk`, `state`, `widgets` and `desk_title` sync a desk; `gesture`, `measure`, `arrange` and `trash` come
   back; `widget_change` goes to every socket when a widget is added, changed or removed, and `history_get`
   returns a desk's widget log beside its messages. The Inbox's marks live here too: `seen_mark` /
   `seen_unmark` are done and not done, `viewed_mark` is a look (opening a desk un-bolds it, but its Inbox
   card and the sidebar's ring stay until you act or mark it done), and `snooze_*` is Later; each change
   broadcasts `seen { seen, viewed, snooze, … }`, so the desktop and a phone read the same marks from the mod's
   `attention.json`. Board (`task_*`), Learn (`recall_*`), agents (`agent_get`, `memory_*`,
   `reflection_state`, `skill_*`), folders, pins and the phone listener (`lan_*`, `pair_begin`, `devices_list`,
   `device_forget`) complete it.

## Where the code lives

1. `core/` — pure TypeScript both halves import (no I/O, no framework): `desk-core.ts` (the shared
   vocabulary), `harness.ts` (recognising harness machinery in transcripts), `compat.ts` (the Letta Code
   version range), `attention/` (the Inbox: the app-server client, the attention model, queue, snooze and
   ladder, `useAttention`), `recall/` (Learn's cards and scheduling).
2. `mod/` — the code inside `letta server`. `index.ts` wires it; `gate.ts` lets only the harness that hosts an
   app-server serve the desk; `server.ts` holds the ports and `bridge.ts` the protocol; `desk-store.ts`,
   `persist.ts` and `widgets-fs.ts` keep desks and watch widget files; `widget-log.ts` keeps each desk's
   widget change log; `desks.ts` maps desks to conversations and reads the Inbox's conversations from disk;
   `seen.ts` keeps the done, viewed and snooze marks; `gestures.ts` turns what you did into the `turn_start`
   note; `tasks.ts`, `pins.ts`, `folders.ts`, `agents.ts`, `reflection.ts`, `skills.ts` and `recall.ts` back
   the board, pins, folders, the Agents pages and Learn; `lan.ts`, `pairing.ts`, `devices.ts`, `tailscale.ts`
   and `static.ts` are the phone listener.
3. `app/src/` — the canvas. `boot.tsx` picks the surface; `shell/` is the desktop frame (rail, list column,
   desk sidebar, ⌘K search, keymap, Preferences host); `desk/` a desk's pane (Messages and Desk tabs, the
   sheet, widget frames, rename); `chat/` the thread and composer; `board/`, `agents/`, `recall/` (Learn) and
   `settings/` the other sections; `phone/` the phone; `shared/` logic both surfaces share (drafts, the
   thread's times and New line, viewed marks, search ranking, recents); `components/` the chrome primitives;
   `kit/` the tokens and the widget kit (`@loki/kit`).
4. `src-tauri/` — the Rust shell: finding or installing and starting `letta server`, the app-server link,
   the menu, tray, dock badge and global shortcut.

## One codebase, three systems

Windows and Linux are preview builds of the same code, with a few seams where the systems differ. Each is one
place, and the Mac's side of it is what shipped before.

1. **The page learns the system once.** The shell's init script puts `os` (`macos`, `windows`, `linux`) in
   `window.__LOKI__`; `platform` in `app/src/desk/env.ts` reads it, or a browser tab's user agent. Keys, chrome,
   copy and gating read that one value; `core/` stays system-free (`test/core-portability.test.ts`).
2. **Keys come from the keymap.** `formatKeys` in `app/src/shell/keymap.ts` writes ⌘ ⌥ ⇧ on the Mac and Ctrl,
   Alt, Shift elsewhere; a binding whose Mac key the other system keeps for itself carries its own keys there
   (`keysOn`), and a label that only fits there its own label (`labelOn`: Hide loki becomes Minimise loki).
   `osWords.ts` holds the other per-system words (this Mac, this PC, this computer; Finder, File Explorer).
3. **Mac extras exist only on macOS.** The tray, dock badge, global shortcut and native menu bar are compiled
   under `cfg(target_os = "macos")` with Mac-only dependencies; dictation, phone pairing and Tailscale are hidden
   in the page, which says the feature "isn't on Windows yet" (or Linux) where it would appear.
4. **loki's own title strip.** The window is undecorated on Windows and Linux; `TitleStrip` in
   `app/src/shell/Sidebar.tsx` draws ☰ (`TitleMenu.tsx`, the Mac's `menuSpec()` groups) and minimise, maximise and
   close. `tauri-plugin-single-instance` keeps one loki per user, and Linux runs under XWayland
   (`GDK_BACKEND=x11` unless set). The page holds back the webview's browser keys in a packaged build
   (`guardBrowserKey`, `useShellKeys.ts`).
5. **Finding a harness.** On the Mac, `lsof -c Letta` and `/bin/ps`, as ever. On Windows and Linux,
   `appserver.rs` takes a snapshot of processes and command lines from `sysinfo` and listening ports from
   `listeners`: Letta Desktop by process name, `letta server` and gateway URLs by command line, each probed the
   same way. The mod's own lookup (`mod/app-server.ts`, only for a harness loki did not start) reads `lsof`,
   `/proc` on Linux, or `netstat -ano` on Windows; a harness loki starts is told `LOKI_OWN_APP_SERVER_URL`, which the mod reads once and removes.
6. **Finding Node and Letta Code.** `bootstrap.rs` keeps a list of install folders per system (Homebrew on the
   Mac, `/usr/bin` and Linuxbrew on Linux, `%APPDATA%\npm`, Program Files, volta, nvm-windows, fnm and scoop on
   Windows) and runs npm as `npm.cmd` there. The mod finds its own programs (`bd`, `letta`) through
   `mod/programs.ts`, which tries each `PATHEXT` name on Windows.
7. **Home and folders.** `~` is `USERPROFILE` on Windows (what Node's `os.homedir()` reads), `HOME` elsewhere;
   the skill link falls back to a junction where Windows refuses a symlink. The new-desk sheet's Browse… opens
   the system's folder dialog (`tauri-plugin-dialog`) in the app on every system; the mod's AppleScript chooser
   serves browser tabs on the Mac only.
8. **Builds.** CI runs the tests and `cargo test` on macOS 14, Ubuntu 22.04 and Windows; a release builds the
   `.dmg`, the NSIS `-setup.exe`, and the AppImage and `.deb` on one runner each and publishes them together
   ([RELEASING.md](RELEASING.md)).

## Following one message

You type in the chat box and press Enter.

1. The page shows your words at once, records them as your own send so the server's echo is not shown
   twice, and attaches a small context note with the local time and working folder.
2. It makes sure the conversation is subscribed, then sends an `input` frame with your text, any
   images, and that context.
3. The frame reaches the app-server. In the desktop shell the Rust side forwards it over the
   authenticated socket to `letta` on 41600; in a browser tab it goes through the mod's `/appserver`
   tunnel to the same place.
4. The turn begins, and loki's mod gets first say: at `turn_start` it appends what you did on the desk
   since last turn and any board tasks assigned to this conversation onto your message.
5. The harness assembles the turn with the Letta server — your augmented message plus memory, history
   and tools — and calls the model.
6. The model streams back reasoning, then assistant text, or a tool call. A tool call runs inside the
   harness on your machine, under your permission mode; if it needs approval, a request returns and the
   chat shows an approval card.
7. Each fragment streams back to the page over the same path, and the reducer folds it into live state:
   the reply types out, tool markers appear, the status and turn counter update.
8. When the turn ends, anything the agent chose to remember is saved in the Letta server, and your
   desk, board and inbox reflect it.

That is the whole machine: four roles, one rule about where the hands stay, two processes on your Mac,
and a message that walks from your box to the brain and back.
