# loki

A memory palace your agent builds. loki is a macOS app around [Letta Code](https://docs.letta.com):
a desk per conversation that the agent furnishes with live widgets, an inbox of everything waiting on you,
a shared task board, and a page per agent. (Not [Grafana Loki](https://grafana.com/oss/loki/), the log
system.)

**The desk is a directory**: the agent writes `.json` and `.tsx` files into `~/.letta/loki/widgets/<desk>/`,
the app loads them the moment they land, you drag and operate them, and what you did rides along on your
next message. Each conversation gets its own desk, created lazily on first widget. A `shared` desk holds
widgets that belong to no conversation.

## Requirements

- **macOS 13 or later.** The shell finds Letta Desktop with `lsof`, picks folders with the Finder, and
  uses the native title bar, dock badge and a global shortcut. Nothing else is supported today.
- **Letta Code.** If it is already on the Mac (or Letta Desktop is running) loki uses that. If not, the
  first launch installs a private copy under `~/Library/Application Support/dev.deepak.loki/runtime/`:
  Node 22 from nodejs.org (checked against its published checksum) when the Mac has none, then
  `@letta-ai/letta-code` at the release loki was tested with, from registry.npmjs.org. Nothing else on
  the machine is touched, and a `letta` you install yourself later takes precedence. Settings shows which
  one is in use and the harness's version next to the tested one.
- **beads** (`brew install beads`) for the board. Optional; everything else works without it.

## Install

1. Download the `.dmg` from the latest release and drag loki to Applications. You do not need Node, npm
   or Letta installed first. Until the app is signed,
   macOS will refuse to open it the first time: right-click → Open, or run
   `xattr -dr com.apple.quarantine /Applications/loki.app`.
2. Open loki. On first launch it copies its mod to `~/Library/Application Support/dev.deepak.loki/mod/`,
   writes the shim `~/.letta/mods/loki.ts` that Letta loads, and installs the agent's skill at
   `~/.agents/skills/loki/`. Settings → install shows what happened.
3. If Letta Desktop (or a `letta` session) was already running, `/reload` in Letta Code so the harness
   picks the mod up. If nothing was running, loki starts its own harness and the mod is already in it.
4. The first launch shows **Welcome** over the empty desk: connect a model provider (paste a key; Letta
   checks it with the provider and keeps it, loki never sees it again), then name your first agent and
   pick one of Letta's personalities. You land on its desk with the chat open.
5. Ask your agent to put something on the desk.

Updates are a new `.dmg`; the app re-installs its mod on launch when the bundle changed. It never overwrites
a shim or skill it did not write, so a checkout wired up for development (below) keeps working.

## The window

The native title bar carries the desk's name (or "Inbox · n waiting", "Board · n open", "Agents", "Settings"), a
rail of five segments sits on the left, and one view fills the rest:

- **Desk** (⌘1): the sheet edge to edge, the chat stacked over it on the left, centred and wider, or on the
  right (⌘← and ⌘→ move it, ⌥⌘ from inside a text box, ⌘/ toggles it, ⌘W closes it, ⌘L focuses the message box,
  ⌘F finds in the transcript; ⌘0 fits all widgets, ⌘⇧0 is 1:1, ⌘= ⌘- zoom, ⌘⇧A arranges, ⌘Z undoes a widget move).
  Under the chat's message box sit two chips for the conversation: its **permission mode** (strict, standard, accept
  edits, unrestricted; ⌘⇧P) and its **model** (⌘⇧M, type to filter every handle the harness offers). Both apply
  per conversation through the app-server; a main chat's model is the agent's. Inbox cards carry the same chips in their actions row.
  A side chat is a viewport inset: fit-all, focus and camera glides frame widgets in the uncovered part, and
  opening or closing a left chat slides the sheet so nothing ends up under it. An empty desk opens the chat
  centred until its first widget lands. Clicking the desk icon again (or ⌘K) opens the **desks tree**: one centred list of every
  desk, pinned first then by recency, each with its agent's face and attention dot; a chip row filters to one
  agent (click, or Tab / ⇧Tab); type to filter, ↑↓, ↵; ⌘P pins, ⌘E archives; "new desk" at the bottom, the
  archive folded under it. Picking a desk closes it. ⌘[ and ⌘] step through live desks without opening anything.
- **Inbox** (⌘2, or ⌥Space from anywhere on the Mac): Catch Up as a full view, see below. The rail icon carries
  the waiting count, the same number the tray title and dock badge show.
- **Board** (⌘3): tasks for later, see below.
- **Agents** (⌘4): one tab per agent, then four pages down the left. **profile**: face, name, description and model
  (editable), effort and context, where it is working (its live desks, each a link, and its open tasks), and delete at
  the bottom. **memory**: the files as a tree on the left, the one you picked on the right, with "ask <agent> to update
  this". **changes**: what it learned as a timeline of memory commits, newest first, the diff on the right. **skills**:
  one line each in two groups — **self**, the ones the agent (or you) wrote ("write" adds one here, "install" takes a
  source the CLI knows: `owner/repo/path`, `official/<path>`, `clawhub/<slug>`, a GitHub or SKILL.md URL), and
  **other**, installed from somewhere named on the row (a checkout linked into `~/.letta/skills`, a repo the `skills`
  CLI recorded, a source you typed once). Pick a skill and it opens on the right with its origin, whether the agent has
  edited its copy, and **refresh**: the latest is pulled from the source and compared; an untouched copy is replaced
  and committed; a copy the agent edited is not overwritten — upstream is staged and the agent's main chat opens with a
  request to reconcile, keeping what it learned and taking what upstream improved; a copy that matches is reported
  current. A skill nobody recorded a source for asks for one the first time. The page is remembered for the window.
- **Settings** (⌘5, ⌘,): seven pages down the left, one showing at a time, the last one remembered for the
  window. **letta**: which harness the app is on, how it reaches the mod, requirements and install status.
  **providers**: the harness's catalogue, connected first; a row opens into the fields it needs, keys are checked
  with the provider before Letta keeps them; OAuth ones say which `letta connect` to run. **phone**: the LAN
  switch, the pairing QR and code, paired phones. **chat**: where the panel sits and its width. **files**: where
  everything lives. **keys**: the complete keymap.

Esc peels one layer: the tree, then a view back to the desk. Every shortcut lives in one table
(`app/src/shell/keymap.ts`) that drives the key handler, the Settings page, and the native menu bar, so the
menus double as the cheat sheet. Rule of the table: plain letters work where nothing has focus (the board, the
sheet); where a text box has focus (the inbox, the chat) the same actions are ⌘ chords, and chords the text
itself uses (⌘Z, ⌘⌫, ⌘←, ⌘→) are never taken.

## Phone

The inbox, on your phone, with nothing installed. Settings › phone → switch on "reachable on this Wi‑Fi" →
"pair a phone" → scan the QR with the phone's camera → in Safari, Share → Add to Home Screen → open the new
icon and type the six-character code once (a home-screen app has its own cookie jar, so the code shown in
Settings is asked for one more time; it stays valid ten minutes). From then on the icon opens straight into the
inbox: the same cards as Catch Up in the same order — approvals, questions, failures, finished — each with
approve / deny / answer / seen / later, and a tap opens the conversation with the transcript, the approval or
question card, and a reply box. No desks, board or agents on the phone.

The QR and the bookmark carry the Mac's Bonjour name (`my-macbook-pro.local:41415`, from System Settings
› General › Sharing › local hostname), not its address, so the same icon keeps working at home and at the office
when the Mac gets a new address. The phone talks to the Mac directly over the local network (port 41415), so
both must be on the same Wi‑Fi and the Mac must be awake with loki running; some office networks isolate
clients from each other, and then the phone cannot reach the Mac at all — Tailscale (its address appears in
Settings › phone too) is the way around that; when it is not, the phone says "Mac unreachable, last seen …" and
reconnects by itself. Each paired phone is listed in Settings › phone with when it was last seen; "forget"
locks it out. The rail shows a brass dot on the settings icon while the switch is on. Read [SECURITY.md](SECURITY.md)
before switching it on somewhere you do not trust the network.

**Phone, anywhere.** Install [Tailscale](https://tailscale.com/download) on the Mac and on the phone and sign in to
the same account. Settings › phone then shows two routes under "route", Tailscale and this Wi‑Fi, each with the
address a phone uses for it; the lit one is what the QR carries, and switching it redraws the QR at once. Over
Tailscale (`my-macbook-pro.tail1234.ts.net`) the phone reaches the Mac from any network — the office, mobile
data, a café — without a thought about which Wi‑Fi either is on. Each paired phone in the list says which route its
last request came in by ("via Tailscale", "via Wi‑Fi"), so there is never a question of which way you are connected.
The small "https on the tailnet" switch runs `tailscale serve` in front of the listener so the phone gets an
`https://<name>` origin; it needs HTTPS certificates enabled for your tailnet (Tailscale admin console › DNS) and
stays inside the tailnet — loki never uses Funnel. Whichever way you switch, the address the phone bookmarked has
changed, so it pairs once more:

## Layout

```text
mod/            Letta mod, plain TypeScript; boot.ts bundles it fresh on each /reload (no manual build)
shared/         desk-core: types + the pure gesture reducer both halves use
app/            Vite + React canvas
skills/loki/    the vocabulary the agent reads (kit types, .tsx contract, rules)
test/           bun tests
```

How these fit into Letta's own layers — the model, the Letta server, the harness, and loki — is in
[docs/architecture.md](docs/architecture.md).

## What the mod does

Only the things a mod can do:

- owns geometry and gesture state per desk (`~/.letta/loki/state/<desk>.json`); places new widgets in the first free spot using sizes the tab reports back, and can tidy a desk into a grid (the `arrange` button or ⌘⇧A)
- watches `~/.letta/loki/widgets/`, syntax-checks `.tsx` with esbuild, tells the tab what changed
- appends the user's desk activity to their next turn (`turn_start`)
- finds Letta's app-server and tunnels the browser to it (`/appserver`); the browser owns every conversation
  view from there — the desk chat and Catch Up cards are one model (`packages/core/src/attention`), streaming token by token
  whether a turn was typed in Desktop or in the canvas
- lists every open conversation for the inbox straight from the local backend (`inbox_list`): main chats included,
  however old, with who spoke last read from the tail of each log; a conversation leaves the inbox by being archived
- serves each conversation's full transcript from the local backend log (`history_get`), which survives compaction,
  and keeps the seen / snooze markers Catch Up needs
- adopts or spawns the Vite dev server, detached so it survives `/reload`
- tools: `desk_state`, `loki_camera` (one widget, or several framed together, with an optional dwell). Rendering and authoring are file writes.

## Install (development)

```bash
bun install
```

Point Letta at your checkout instead of the installed copy. Everything in `~/.letta/mods/` is loaded as a
mod, so only this file lives there (the app leaves it alone because it does not start with the managed
marker):

```ts
// ~/.letta/mods/loki.ts
import { pathToFileURL } from "node:url";
export default async function activate(letta: unknown) {
  const url = pathToFileURL("/ABSOLUTE/PATH/TO/loki/mod/boot.ts");
  url.searchParams.set("v", String(Date.now())); // boot.ts re-bundles the mod's files on every /reload
  const mod = await import(url.href);
  return mod.default(letta);
}
```

Skill, so the agent knows the vocabulary:

```bash
ln -s /ABSOLUTE/PATH/TO/loki/skills/loki ~/.agents/skills/loki
```

Then `/reload` in Letta Code and run `bun run dev` (Vite) plus `bun run desktop:dev` (the window against
it), or open the Vite URL in a browser tab.

## Install as an app (Chrome)

The canvas ships a web app manifest, so Chrome can install it: open the canvas
tab, then menu → Save and share → Install page as app. It opens in its own
window with the loki icon. The tab remembers its token and last desk in
localStorage, so the installed app resumes where you left off even though its
launch URL carries no parameters. It still needs Letta Desktop running: the mod
serves the desk; the page comes from Vite in a browser tab, or from the loki app itself.

Vim-key extensions (Vimium, Surfingkeys) run inside installed apps too and bind
plain `r` to reload, which also swallows loki's own shortcuts. Exclude the canvas
in the extension's options, e.g. Vimium → Excluded URLs: `http://127.0.0.1:5173*`.

## New desk

Press ⌘N (or N on the sheet), pick "new desk" under an agent in the tree, or
type a name that matches nothing in the tree's filter. The sheet asks for the agent (chips),
the folder (defaults to that agent's most recent one; recents, typed paths with
completion, or Browse… for the Finder chooser; the git branch shows when the
folder is a checkout) and an optional name. Start creates the conversation
through Letta's app-server, so it appears in Desktop too, and the canvas
switches to the empty desk with the chat open.

## Questions from the agent

When an agent calls `AskUserQuestion`, the chat panel and the Catch Up card show
a question card instead of a permission block: each question with its options
(pick one, or pick many), and an "or answer in your own words" line. Answer
sends everything back in one go. A typed reply in the message box while a
single question is open is treated as the answer. Questions are never snoozed.

## Images

Paste an image into any message box (⌘V from a screenshot, or drop a file on
it). It shows as a thumbnail above the box, with × to remove; send attaches it
to the message as a base64 image part. Large images are shrunk to 1600px on
the long edge before sending.

## Dictation

The mic in any message box (or ⌘D while it is focused; ⌘M stays macOS's minimise) dictates through the
browser's Web Speech API. Recognition stops by itself when you pause; Enter
sends. Chrome may send the audio to Google's speech service unless on-device
recognition is available, so treat it like any other cloud dictation.

## Inbox (Catch Up)

The app knows which conversations are waiting on you. The inbox icon on the rail shows the count; click it, press
⌘2, or ⌥Space from anywhere for a Slack-style deck, one conversation per card with the recent thread inside it (newest at the bottom,
tool calls as muted markers): approvals first (approve/deny inline), then questions, failures, and finished work. → or ⌘] marks seen, ← or ⌘[ keeps unread, A or ⌘↵ approves, D or ⌘⇧D denies, O or ⌘O opens that desk with its chat focused, S or ⌘S shows snoozed, Z undoes (the ⌘ forms work while typing a reply), Esc returns to the desk.
Catch Up runs in the browser. Its list is the mod's: every open conversation of your agents read from the local
backend on disk (`inbox_list`), main chats included, with who spoke last taken from the tail of each log — nothing is
windowed by age or capped by count, so a conversation only leaves the inbox when it is archived (main chats are
never archived; they leave by being seen). The live half — runtime subscriptions, streaming, approvals, answers —
speaks Letta's app-server protocol through the mod's `/appserver` tunnel, which exists because the app-server
refuses browser origins. The seen and snooze markers live in `~/.letta/loki/state/attention.json`.

Slash commands work in the message box as they do in Letta Desktop: type `/` and a palette lists what the box can
run — loki's own (`/model`, `/mode`, `/inbox`, `/desks`) and the harness's (`/reload`, `/compact`, `/clear`,
`/remember`, `/init`, `/doctor`, `/context-limit`, `/channels`, `/upgrade-letta-code`, plus whatever this Letta Code
advertises). ↑↓ move, ↵ runs (or fills in a command that takes arguments), ⇥ fills in, esc puts the palette away.
Harness commands go over the app-server socket as `execute_command`, the path Desktop and the channels use, and
land in the transcript as one quiet row: the command line, then its outcome. `packages/core/src/attention/commands.ts`
is the table. Every bubble has a copy button under its outer corner (shown on hover, or when it has focus) that puts the
message on the clipboard as the markdown it was written in, not the rendering.

Every desk, tree group, chat header, and Catch Up card carries a colour-coded chip naming the agent that owns the
conversation, so multi-agent setups stay legible.

### Later, with backoff

"Later" (←) on a card defers it Anki-style: it leaves the pass and comes back
after 5 minutes, then 15, 45, 2 hours, 6 hours, and at most a day, each time you
defer it again. A card that moves on (new reply, new approval) returns at once,
labelled "back". Approvals never defer. The ladder resets each day. The deck
shows how many are snoozed and when the next is due; S shows them anyway.

## Board (tasks for later)

Tasks you or an agent want to come back to live on one shared board, backed by
[beads](https://github.com/steveyegge/beads) (`bd`, embedded Dolt) at
`~/.letta/loki/board`. Agents file tasks only when asked, through the `loki_task`
tool, which stamps the source conversation, desk and folder; you file them from
the board's "+" or ⌘T anywhere. The Board segment (⌘3) shows open, in progress,
blocked and recently done columns. Select tasks (X, ⇧-click) and press ⏎ to
**assign** them to a desk: the agent becomes the assignee and the tasks ride
along inside `<loki-tasks>` on your next message in that conversation; nothing is
sent. ⌘⏎ **dispatches** instead: assigns, then posts the tasks so the agent
starts now. New desk is a target too. ⌫ marks done, ⇧⌫ toggles blocked, ⌘R
refreshes, / filters. Agents close tasks through the tool.

Setup: `brew install beads`. The mod creates the board (`bd init --prefix lk`) the first time it is used.

## Widget frame controls

Each frame has three buttons: **focus** (front, centre, zoomed in), **minimise** (to the tray at the bottom-left; the file stays), and **trash** (deletes the file after a confirm). The agent hears about all three on your next turn.

## Development

```bash
bun test                                          # mod, shared, app logic, design tokens
bun run typecheck                                 # tsc
cargo test --manifest-path src-tauri/Cargo.toml   # the shell
bun run dev                                       # Vite on 127.0.0.1:5173
bun run desktop:dev                               # the Tauri window against it
bun run desktop:build                             # the .app and .dmg (bundles app/dist and the mod)
```

Env: `LOKI_PORT` (mod, default 41414), `LOKI_WIDGETS_DIR` (default `~/.letta/loki/widgets`),
`LOKI_APP_SERVER_URL` (skip discovery), `LOKI_LETTA_BIN` / `LOKI_BD` (binaries), `LOKI_INSTALL=1` (make a
dev build install its mod), `LOKI_NO_INSTALL=1` (stop a release build from doing so).
Logs: `~/.letta/loki/mod.log`, `~/.letta/loki/logs/harness.log`. Harness for running the mod without
Letta: `node scripts/harness.mjs`.

`docs/architecture.md` explains Letta's four-responsibility execution model — model, Letta server,
harness, loki — which are processes, and the journey of a message. `docs/plans/` is the design history,
one dated plan per feature; `docs/design.md` is the visual direction
and the token contract. See CONTRIBUTING.md, SECURITY.md and RELEASING.md.

## Hard rules

- No real money amounts on screen, in the repo, or in recordings. Ever.
- Widget code runs with the page's full trust. This is your machine and your agent; it is not a sandbox (SECURITY.md).

## Licence

Apache-2.0. See LICENSE.
