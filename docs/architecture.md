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
the native window that finds or installs and starts the harness, holds the authenticated socket, and
draws the tray, dock badge and global shortcut. The canvas renders chat, inbox, board, agents and the
widgets themselves. The same canvas has three clients: the desktop window, a browser tab on the Mac,
and — when Settings › phone is on — a phone on the Wi‑Fi, which the mod serves directly and which shows
the inbox alone (`app/src/phone/`).

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
| 41414 | loki's mod, loopback | desk state, gestures, the board, agents, pins, folders, agent faces, and the app-server tunnel |
| 41415 | loki's mod, LAN (off by default) | the canvas build as a single-page app, `/pair` `/me` `/unpair`, and the same `/ws`, `/appserver` and face routes for paired phones |

When Tailscale runs on the Mac the same 41415 listener is reached by the tailnet name instead of the Wi‑Fi
one (`lan_status.via`), and `tailscale serve` can optionally front it with https on 443 inside the tailnet,
forwarding to `127.0.0.1:41415` — no fourth port of loki's own.

The mod exposes its own port because its code runs in Node while the loki UI runs in a browser
context — the WebView or a tab — and Node cannot reach into a browser page any other way. A localhost
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
`modBase()` becomes the page's own origin, `main.tsx` mounts `<Phone/>` instead of `<Shell/>`, and the
same `useDesk` and `useAttention` hooks connect to `/ws` and `/appserver` with an empty `?t=` — the
cookie does the authenticating. Settings › phone itself speaks to the mod over the loopback socket
(`lan_get`, `lan_set`, `pair_begin`, `devices_list`, `device_forget`) and hears `lan_status`,
`pair_code` and `devices` back.

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
