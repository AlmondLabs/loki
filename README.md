<p align="center">
  <img src="app/public/icon.svg" width="96" alt="">
</p>

<h1 align="center">loki</h1>

<p align="center">
  <b>A memory palace your agent builds.</b><br>
  A desk for <a href="https://docs.letta.com">Letta Code</a> agents on macOS, with Windows and Linux in preview:
  live widgets the agent writes as files, an inbox of everything waiting on you, a shared task board, flashcards
  from your conversations, and your phone as a remote.
</p>

<p align="center">
  <a href="https://github.com/AlmondLabs/loki/actions/workflows/ci.yml"><img src="https://github.com/AlmondLabs/loki/actions/workflows/ci.yml/badge.svg" alt="ci"></a>
  <img src="https://img.shields.io/badge/macOS-13%2B-1a1a20" alt="macOS 13 or later">
  <img src="https://img.shields.io/badge/Windows%20%C2%B7%20Linux-preview-1a1a20" alt="Windows and Linux: preview">
  <img src="https://img.shields.io/badge/licence-Apache--2.0-1a1a20" alt="Apache-2.0">
</p>

<p align="center">
  <img src="docs/images/desk.png" width="900" alt="A desk's Desk tab, beside its Messages tab: a plan for Saturday, last night's sleep, the week's runs as a bar chart, a packing list, a run streak, a thermostat slider">
</p>

Agents talk in text. loki gives yours a desk. Ask for a chart, a checklist, a slider, a plan for the day, and
the agent writes a small file; a second later it is on the desk, and you can drag it, tick it, slide it. What
you did rides along on your next message, so the agent sees the desk the way you left it.

> Not [Grafana Loki](https://grafana.com/oss/loki/), the log system.

Cloned the repo and want it running on a Mac? Three tools, then two commands (Windows and Linux need other
tools first; see [Development](#development)):

```bash
xcode-select --install                                              # Xcode's command line tools, once
curl -fsSL https://bun.sh/install | bash                            # Bun
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh      # Rust; then open a new terminal
bun install && bun start
```

Letta Code need not be installed first: the window uses the `letta` already on your Mac, or installs it with
`npm install -g @letta-ai/letta-code` using the Node you have (`brew install node` if none; Vite and the Tauri CLI
themselves run under Bun). `bun start` says what is missing before it builds. The first start compiles the shell,
a few minutes, and installs Letta Code if need be; the window then asks for a model provider key: one you already
have with Anthropic, OpenAI, Google, OpenRouter, Ollama for local models, or another of the providers Letta Code
connects to. Letta checks the key with the provider and keeps it; loki never sees it, and each turn costs whatever
that provider charges. Everything else, including the Homebrew install of the finished app, is under
[Install](#install) and [Development](#development).

## What you get

| | | |
|---|---|---|
| **Desk** | ⌘1 | One desk per conversation, furnished by the agent: five kit widgets from a line of JSON, or any React component it cares to write. Desks sit in a Slack-style sidebar (Pinned, one section per agent, Archived) and open like a channel: **Messages** is the conversation, with a line each time a widget changes; **Desk** is the canvas, to pan, zoom, arrange, undo. ⌘K finds any desk, agent or page. |
| **Inbox** | ⌘2 | Every conversation that is waiting on you, as cards, highest score first: blocked agents, then warm replies to you (their prompt is still cached, so answering now is cheap), then the rest. Approve and reply inline; a reply keeps the card while the answer streams in. Opening a desk only marks it viewed: its card stays until you act or **Mark as done** (⌘⇧↵). ⌥Space opens it from anywhere on the Mac. |
| **Board** | ⌘3 | Tasks for later on one board shared by you and every agent. Select, assign to a desk, or dispatch so the agent starts now. |
| **Agents** | ⌘4 | Your agents listed like Slack's direct messages, with live state and what waits on you. Each has a profile and model, its memory files as a tree, what it learned as a timeline of commits, Letta's reflection settings, and its skills with one-click refresh from upstream. |
| **Learn** | ⌘5 | Spaced-repetition cards a background writer distils from quiet conversations, and **leads**: concepts that went by without being understood, each one click from a `[Learn]` lesson the agent teaches on a desk of its own. Off until you switch it on; how often it sweeps and how many cards a day are yours to set. Deleting a card is the feedback. [How it works](docs/learn.md). |
| **Phone** | | The inbox, every desk's conversation, your agents and Learn on your phone, in Slack's mobile layout, over Wi‑Fi or Tailscale, nothing to install: scan a QR, add to the home screen. Viewed and done agree with the Mac. Mac only for now. |

Keys are written the Mac's way. On Windows and Linux ⌘ is Ctrl and ⌥ is Alt, and loki shows them that way; the
phone, ⌥Space, dictation and the menu-bar item are not there yet ([the manual](docs/manual.md#windows-and-linux)
lists what differs).

<p align="center">
  <img src="docs/images/board.png" width="900" alt="The board: a sidebar of views and agents, then open, in progress, blocked and done columns, each task stamped with who filed it and which desk holds it">
</p>

<p align="center">
  <img src="docs/images/recall.png" width="900" alt="A card in Learn, beside its views (review, leads, all cards, deleted): the question, the answer revealed, and two buttons, again or got it">
</p>

## Install

**Homebrew** is the recommended way. Two lines, because loki is not signed with an Apple Developer ID and macOS
calls an unsigned download "damaged" until its quarantine flag is cleared once:

```bash
brew install --cask almondlabs/loki/loki
xattr -dr com.apple.quarantine /Applications/loki.app
```

Upgrades are `brew upgrade --cask loki`, followed by the same `xattr` line. Versions are dates: `2026.9.28` is
the stable that shipped on that day.

**Nightly**, if you want every merge about twenty minutes after it lands (Mac only; one loki at a time, so this
replaces the stable install; `brew uninstall --cask loki` first, or the other way round to go back):

```bash
brew install --cask almondlabs/loki/loki-nightly
xattr -dr com.apple.quarantine /Applications/loki.app
```

**The `.dmg`** from the [latest release](https://github.com/AlmondLabs/loki/releases/latest): drag loki to
Applications, then clear the flag once:

```bash
xattr -dr com.apple.quarantine /Applications/loki.app
```

**From source**: Bun, Rust and Xcode's command line tools, then `bun start` to run the checkout, or
`bun run desktop:build` for a `.app` and `.dmg` of your own. A build made on your own Mac never carries the flag.

**Windows and Linux are a preview:** built and tested in CI, not yet tried on real machines. They come on stable
releases only, a little after the `.dmg`: a stable ships for the Mac first and gains its Windows and Linux files once
that version's preview is built (nightlies are Mac-only). Please [report what you find](https://github.com/AlmondLabs/loki/issues)
([what to try](docs/preview-checklist.md)).
Like the Mac's, these files are unsigned, so each system asks for one extra step the first time.

**Windows** (64-bit Windows 10 or 11), `loki_<version>_x64-setup.exe` from the
[latest release](https://github.com/AlmondLabs/loki/releases/latest):

1. Run it. SmartScreen says "Windows protected your PC" (an unknown publisher): choose **More info**, then
   **Run anyway**.
2. Finish the installer and open loki from the Start menu.

**Linux** (64-bit, built on Ubuntu 22.04 so it runs on newer releases too). On Debian or Ubuntu, the `.deb`:

```bash
sudo apt install ./loki_*_amd64.deb
```

On any other distribution, the AppImage, which needs its executable bit and FUSE 2 (`libfuse2`; on Ubuntu 24.04 the package is
`libfuse2t64`):

```bash
sudo apt install libfuse2
chmod +x loki_*_amd64.AppImage && ./loki_*_amd64.AppImage
```

On both, upgrades are the next file from the release page; Settings › letta links the one for your system when a
newer loki is out, or says its file is not on the release yet. There is no Homebrew, winget or Flatpak package yet.

You need macOS 13 or later, 64-bit Windows 10 or 11, or a current 64-bit desktop Linux. The cask brings Node;
the `.dmg`, Windows and Linux routes need a Node 22.19 or newer (`brew install node`,
`winget install OpenJS.NodeJS.LTS`, or your distribution's package) only if no `letta` is installed yet. loki
never downloads Node; Welcome says what to run and checks again. On first launch loki uses the Letta Code already
on the machine — the same `letta` a terminal runs — or installs it with `npm install -g @letta-ai/letta-code`,
asks for a model provider key (Anthropic, OpenAI, Google, OpenRouter, Ollama and others; you pay that provider,
loki never sees the key), and helps you name your first agent. Then ask it to put something on the desk. If
Letta Desktop or a `letta server` is already running, loki attaches to that harness instead of launching one.
loki runs whatever Letta Code is installed; it was last tested with 0.32.10, and Settings › Letta says where
yours stands against that and offers the update.

## Your first widget

Say, in the chat:

> put my runs this week on the desk as a bar chart

The agent writes one file:

```json
// ~/.letta/loki/widgets/<desk>/runs.json
{ "type": "chart-card", "title": "Runs this week",
  "data": { "kind": "bar", "yLabel": "km", "points": [ { "x": "Mon", "y": 5.2 }, { "x": "Wed", "y": 8.1 } ] } }
```

and the chart is on the desk before the reply finishes. Five kit widgets need only JSON (`stat`, `list-card`,
`chart-card`, `slider-control`, `info-card`); anything else is a `.tsx` file with a default-exported React
component. Editing the file changes the widget; deleting it removes it. The [skill](skills/loki/SKILL.md)
the agent reads is the whole contract.

## How it works

```mermaid
flowchart LR
  you([you]) <--> app[loki.app<br/>the desk, inbox, board]
  app <-->|"/appserver tunnel"| mod[loki mod<br/>inside the Letta Code harness]
  mod <--> harness[Letta Code<br/>agents, memory, tools]
  harness --> files[("~/.letta/loki/widgets/<br/>.json and .tsx")]
  files -->|"watched, hot-reloaded"| app
  app -->|"what you did on the desk<br/>rides on your next message"| mod
```

Three parts, one repo: a **Letta mod** that runs inside the harness and owns the files, a **Rust shell** that
finds or installs Letta Code, launches or attaches to the harness and hosts the window, and a **React app** that
renders the desk. The mod streams conversations to the app through a tunnel, the app watches the widget files
through Vite, and your gestures on the desk go back to the agent as context on the next turn. Every Letta
harness on the Mac loads the mod, but only the one hosting an app-server serves the desk; a terminal `letta`
session logs one line and stands down. Nothing leaves your machine except your messages to the provider you
chose. [docs/architecture.md](docs/architecture.md) has the long version.

## Layout

```text
mod/            Letta mod, plain TypeScript; boot.ts bundles it fresh on each /reload (no manual build)
core/           desk-core (types + the pure gesture reducer both halves use), attention, recall, compat (the Letta Code range) — portable, no browser globals
app/            Vite + React: the desktop views, the canvas and the phone
skills/loki/    the vocabulary the agent reads (kit types, .tsx contract, rules)
src-tauri/      the desktop shell (Rust; macOS, Windows, Linux): finds or installs Letta Code, launches or attaches to the harness, hosts the canvas
scripts/        dev (`bun start`), build-mod (the bundle the app ships), harness (run the mod without Letta), cask (Homebrew),
                release (date versions, notes), analytics (the local usage report)
test/           bun tests
docs/           the manual, learn (the mental model), architecture, design direction, dated plans and research; CONTRIBUTING, SECURITY and RELEASING
```

## Development

You need [Bun](https://bun.sh), Rust from [rustup](https://rustup.rs) (stable; open a new terminal after installing
it) and Xcode's command line tools (`xcode-select --install`). Not Letta Code: the window uses the `letta` on
your Mac or installs it with npm on first launch, the same way the app does (that needs a Node 22 or newer
somewhere; Vite and the Tauri CLI themselves run under Bun). On a Mac that has never run loki, `bun start`
also points Letta at your checkout — a shim at `~/.letta/mods/loki.ts` importing `mod/boot.ts`, and
`~/.agents/skills/loki` as a symlink to `skills/loki` — and leaves anything already there alone.

```bash
bun install
bun start                                         # Vite on 127.0.0.1:5173 plus the Tauri window; Ctrl-C stops both
bun run dev                                       # Vite alone, for a browser tab
bun run desktop:dev                               # the Tauri window against a Vite already running
bun test && bun run typecheck && bun run lint     # bun tests, tsc, eslint (typescript-eslint + React compiler rules)
cargo test --manifest-path src-tauri/Cargo.toml   # the shell
bun run desktop:build                             # the .app and .dmg
```

The app is built with the React Compiler, so memo boundaries hold without hand-written `useCallback`;
`LOKI_COMPILER_LOG=1 bun run build:app` lists what it declined to compile. In development, `?scan` on the dev
URL loads React Scan and outlines every needless re-render. To point a running Letta at your checkout instead
of the installed mod, see the manual's [Install (development)](docs/manual.md#install-development).

On **Windows**, install the Microsoft C++ Build Tools (the "Desktop development with C++" workload) and the
WebView2 runtime (Windows 11 has it) in place of Xcode's tools, and run the commands from Git Bash. On
**Linux**, Tauri's WebKitGTK build packages; on Ubuntu 22.04 the list is the one in
[`.github/workflows/ci.yml`](.github/workflows/ci.yml). On every system `cargo test` wants
`bun run build:app && bun run build:mod` first (the shell embeds the built app). [Contributing](docs/CONTRIBUTING.md) has the rest.

## Read on

- [The manual](docs/manual.md): every view, every key, every file loki writes.
- [Learn](docs/learn.md): the mental model for the card writer, leads and lessons, and what a sweep costs.
- [Architecture](docs/architecture.md): Letta's four layers and the journey of a message.
- [Design](docs/design.md): Slack's look on the desktop and the phone, and the token contract that keeps it so.
- [Contributing](docs/CONTRIBUTING.md), [Security](docs/SECURITY.md), [Releasing](docs/RELEASING.md).

Two rules hold everywhere: no real money amounts on screen, in the repo or in recordings, ever; and widget code
runs with the page's full trust, because this is your machine and your agent, not a sandbox.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
