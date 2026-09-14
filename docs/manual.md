# The loki manual

Everything the README leaves out: every view, every key, every file loki writes. The README is the
tour; this is the reference. Paths are the defaults; the Files page in Settings shows yours.

## Requirements

- **macOS 13 or later.** The shell finds Letta Desktop with `lsof`, picks folders with the Finder, and
  uses the native title bar, dock badge and a global shortcut. Nothing else is supported today.
- **Letta Code.** loki runs its own copy, installed on first launch under `~/.letta/loki/runtime/`: Node 22
  from nodejs.org (checked against its published checksum) when the Mac has none, then `@letta-ai/letta-code`
  at the release loki was tested with, from registry.npmjs.org. A `letta` you installed yourself is never
  used or touched, and nothing you do to it changes what loki runs. (If Letta Desktop is running, loki talks
  to Desktop's harness instead — never two harnesses on one backend.) Settings shows the copy in use and the
  harness's version next to the tested one. Letta Code never updates itself under loki (the harness runs with
  its self-updater off): the only update the app ever offers on its own is loki's. Settings › letta has
  **check** (asks npm for the newest release) and **update** (reinstalls loki's copy at it and restarts the harness).
  The harness runs with `LETTA_SCRATCHPAD` set to a folder under `~/.letta` (`~/.letta/loki/scratch` by default,
  emptied at each start): since Letta Code 0.31.13 its memory subagents — the dreaming (reflection) pass, its
  selector, the explicit-merge reviewer — run in a sandbox that may only write under `~/.letta`, and Letta's own
  scratch folder, under the system temp directory, is refused, so every pass failed before its first command.
  Settings › letta shows the folder, lets you change it, and gives the line for a `letta` you run in a terminal
  (a different folder: Letta names the files inside by a per-process counter, so two harnesses must not share one).
- **beads** (`brew install beads`) for the board. Optional; everything else works without it.

## Install

**Homebrew**, the recommended way:

```bash
brew install --cask --no-quarantine skilp4d/loki/loki
```

`--no-quarantine` matters. loki is not signed with an Apple Developer ID, and macOS refuses to open an unsigned
download as "damaged"; Homebrew quarantines cask downloads like a browser would unless told not to. Upgrades
are `brew upgrade --cask loki`; the cask follows each release.

**The `.dmg`** from the latest release: drag loki to Applications, then clear the quarantine flag once (right-click →
Open is not enough for an unsigned app on macOS 14 and later):

```bash
xattr -dr com.apple.quarantine /Applications/loki.app
```

Or open it, dismiss the dialog, and allow it under System Settings › Privacy & Security.

**From source**: Bun and Rust, then `bun run desktop:build` (see the README). A build made on your
own Mac never carries the flag.

Whichever way, you do not need Node, npm or Letta installed first. Then:

1. Open loki. On first launch it installs its private copy of Letta Code (Requirements), copies its mod to
   `~/.letta/loki/mod/`, writes the shim `~/.letta/mods/loki.ts` that Letta loads, and installs the agent's skill
   at `~/.agents/skills/loki/`. Settings → install shows what happened.
2. If Letta Desktop (or a `letta` session) was already running, `/reload` in Letta Code so the harness
   picks the mod up. If nothing was running, loki starts its own harness and the mod is already in it.
3. The first launch shows **Welcome** over the empty desk: connect a model provider (paste a key; Letta
   checks it with the provider and keeps it, loki never sees it again), then name your first agent and
   pick one of Letta's personalities. You land on its desk with the chat open.
4. Ask your agent to put something on the desk.

Updates are a new release (`brew upgrade --cask loki`, or the next `.dmg`); the app re-installs its mod on launch
when the bundle changed. It never overwrites a shim or skill it did not write, so a checkout wired up for
development (below) keeps working. Letta Code is updated only from Settings › letta, never on its own (see
Requirements).

## The window

The native title bar carries the desk's name (or "Inbox · n waiting", "Board · n open", "Agents", "Settings"), a
rail of six segments sits on the left, and one view fills the rest:

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
  archive folded under it. Picking a desk closes it. On the desk, ⌘[ and ⌘] step through live desks without opening anything.
- **Inbox** (⌘2, or ⌥Space from anywhere on the Mac): Catch Up as a full view, see below. The rail icon carries
  the waiting count, the same number the tray title and dock badge show.
- **Board** (⌘3): tasks for later, see below.
- **Agents** (⌘4): one tab per agent, then five pages down the left. **profile**: face, name, description and model
  (editable), effort and context, where it is working (its live desks, each a link, and its open tasks), and delete at
  the bottom. **memory**: the files as a tree on the left, the one you picked on the right, with "ask <agent> to update
  this". **changes**: what it learned as a timeline of memory commits, newest first, the diff on the right; a pass by
  Letta's Reflection Subagent is marked. **reflection**: Letta's sleep-time pass over what happened — when it fires
  (off, every n steps of a conversation, after a compaction), how its changes land (applied automatically, or handed to
  the agent to review, edit and merge in a background conversation of its own, with your review notes), the steps each
  conversation has gathered since its last pass with "reflect now" beside it (the
  same as `/reflect` in that chat), and the last pass that changed memory. These are Letta's own settings for the
  agent, the ones its `/sleeptime` overlay shows in a terminal. **skills**:
  one line each in two groups — **self**, the ones the agent (or you) wrote ("write" adds one here, "install" takes a
  source the CLI knows: `owner/repo/path`, `official/<path>`, `clawhub/<slug>`, a GitHub or SKILL.md URL), and
  **other**, installed from somewhere named on the row (a checkout linked into `~/.letta/skills`, a repo the `skills`
  CLI recorded, a source you typed once). Pick a skill and it opens on the right with its origin, whether the agent has
  edited its copy, and **refresh**: the latest is pulled from the source and compared; an untouched copy is replaced
  and committed; a copy the agent edited is not overwritten — upstream is staged and the agent's main chat opens with a
  request to reconcile, keeping what it learned and taking what upstream improved; a copy that matches is reported
  current. A skill nobody recorded a source for asks for one the first time. The page is remembered for the window.
- **Settings** (⌘6, ⌘,): eight pages down the left, one showing at a time, the last one remembered for the
  window. **letta**: loki's own version and whether a newer release is out (asked of GitHub on launch and every six hours; `brew upgrade --cask loki` is the way up), which harness the app is on, how it reaches the mod, requirements and install status.
  the harness's **scratch** folder (see Requirements) with apply, back to the default, and the line for a terminal. **providers**: the harness's catalogue, connected first; a row opens into the fields it needs, keys are checked
  with the provider before Letta keeps them; OAuth ones say which `letta connect` to run. **phone**: the LAN
  switch, the pairing QR and code, paired phones. **chat**: where the panel sits and its width. **files**: where
  **learn**: the card writer's switch (off until you turn it on), cards a day (a cap on the deck, per calendar day; leads are still looked for once it is reached), the model it asks, run now, and the leads it proposes. **files**: where
  everything lives. **keys**: the complete keymap, and the switch for ⌥Space — the one system-wide key, off if Raycast, Alfred or the input-source switcher wants it.

`?` (outside a text box) opens a sheet of the keys that work in the view showing, its own first, then the ones
that work everywhere; `?` or Esc closes it. ⌘[ and ⌘] step through whatever the section showing is made of: desks on the desk, cards in the inbox, columns
on the board, views in Learn, agents in Agents, pages in Settings — the same two keys everywhere, never a jump
back to the desk. Esc peels one layer: the tree, then a view back to the desk. Every shortcut lives in one table
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
locks it out. The rail shows a brass dot on the settings icon while the switch is on. If the icon opens on
"loki did not load", the phone could not reach the Mac (wrong network, Tailscale off, the Mac asleep) or launched from a
cached copy of the page; "try again" reloads, and a page from an older build reloads itself once the Mac answers. Read [SECURITY.md](SECURITY.md)
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

## What the mod does

Only the things a mod can do:

- owns geometry and gesture state per desk (`~/.letta/loki/state/<desk>.json`); places new widgets in the first free spot using sizes the tab reports back, and can tidy a desk into a grid (the `arrange` button or ⌘⇧A)
- watches `~/.letta/loki/widgets/`, syntax-checks `.tsx` with esbuild, tells the tab what changed
- appends the user's desk activity to their next turn (`turn_start`)
- finds Letta's app-server and tunnels the browser to it (`/appserver`); the browser owns every conversation
  view from there — the desk chat and Catch Up cards are one model (`core/attention`), streaming token by token
  whether a turn was typed in Desktop or in the canvas
- lists every open conversation for the inbox straight from the local backend (`inbox_list`): main chats included,
  however old, with who spoke last read from the tail of each log; a conversation leaves the inbox by being archived
- keeps the recall cards (`recall_*`) and runs the worker that writes them: every ten minutes it reads the new
  stretch of any conversation quiet for ten minutes, asks its agent in its hidden "recall" conversation, and writes
  cards up to the day's cap; the deleted pile goes back into every prompt as what not to write
- serves each conversation's full transcript from the local backend log (`history_get`), which survives compaction,
  and keeps the seen / snooze markers Catch Up needs
- adopts or spawns the Vite dev server, detached so it survives `/reload`
- tools: `desk_state`, `loki_camera` (one widget, or several framed together, with an optional dwell). Rendering and authoring are file writes.

## Install (development)

You need Bun, Rust (stable, from rustup) and Xcode's command line tools. Then:

```bash
bun install
bun start
```

`bun start` checks for `cargo` first — on PATH, or in `~/.cargo/bin` where rustup just put it — and stops with the
install line when there is none (Tauri's own message is a bare "No such file or directory"). It then starts Vite,
opens the window (the first build compiles the shell, a few minutes), and waits for the mod: if nothing answers on
its port after a minute and a half, one paragraph names the shim and the harness log instead of Vite's proxy errors.

A development window installs nothing from its bundle (`LOKI_INSTALL=1` makes it), so it would run a harness
without the mod on a Mac that never had loki. Instead, when the shim and the skill are both absent, it points
Letta at the checkout it was compiled from: `~/.letta/mods/loki.ts` importing `mod/boot.ts` (marked as a
development shim, so the app leaves it alone later too) and `~/.agents/skills/loki` as a symlink to `skills/loki`.
Whatever is already in either place stays; Settings › letta › install shows **linked** for each, or what was there.
Letta Code itself is installed the way the app does it, under `~/.letta/loki/runtime/`, and the Welcome step
shows the progress.

To do the same by hand — a second checkout, say — everything in `~/.letta/mods/` is loaded as a mod, so only this
file lives there (the app leaves it alone because it does not start with the managed marker):

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

Then `/reload` in Letta Code and run `bun start` (Vite plus the window in one terminal), or `bun run dev` (Vite) plus `bun run desktop:dev` (the window against
it), or open the Vite URL in a browser tab.

When something does not come up:

1. **The window opens but the desk never links** (Vite prints `ws proxy error … 41414`): the harness has no mod.
   Check `~/.letta/mods/loki.ts` exists and imports a path that exists, then `~/.letta/loki/logs/harness.log` for
   the mod's error on activate. `/reload` in Letta Code loads it again.
2. **Welcome says the Letta Code install did not finish**: `~/.letta/loki/logs/install.log` has every line of every
   attempt; the window shows the telling one (a package that would not build, a host that would not resolve) and
   npm's own log path. Retry from Welcome once it is fixed. loki installs with `SHARP_IGNORE_GLOBAL_LIBVIPS=1`, so a
   Homebrew libvips on the Mac no longer makes `sharp` compile itself with node-gyp.
3. **Letta Desktop is running**: loki talks to its harness rather than starting its own (Requirements), so the
   Letta Code in use is Desktop's, not the tested copy. Quit Desktop and start loki again to run loki's own.

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

Press ⌘N, pick "new desk" under an agent in the tree, or
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

Slash commands work in the message box, and in the reply box of an inbox card, as they do in Letta Desktop: type `/` and a palette lists what the box can
run — loki's own (`/model`, `/mode`, `/inbox`, `/desks`) and the harness's (`/reload`, `/compact`, `/clear`,
`/remember`, `/reflect`, `/init`, `/doctor`, `/context-limit`, `/channels`, `/upgrade-letta-code`, plus whatever this Letta Code
advertises). ↑↓ move, ↵ runs (or fills in a command that takes arguments), ⇥ fills in, esc puts the palette away.
Harness commands go over the app-server socket as `execute_command`, the path Desktop and the channels use, and
land in the transcript as one quiet row: the command line, then its outcome. `core/attention/commands.ts`
is the table. Every bubble has a copy button under its outer corner (shown on hover, or when it has focus) that puts the
message on the clipboard as the markdown it was written in, not the rendering.

### Learn (⌘5)

Spaced-repetition cards, for keeping what the conversations taught you. **Off until you switch it on**: the
writer spends your provider budget in the background, so the section's first visit explains what it does and
offers the switch (Settings › learn has it too, with the knobs). Nothing about the cards happens in
chat: a worker in the mod watches for conversations that have gone quiet, hands their new stretches of
transcript to the agent together — one question per agent, the stretches most worth reading first, up to a
budget; what does not fit waits for the next tick — and writes whatever comes back: one fact per card, a
question that stands alone, an answer in a line or two, up to a daily cap (twenty-five by default) shared
across the stretches. Reading them side by side, the model writes one card for a fact that came up twice and
a revision, not a second card, for a later correction; a card the person keeps failing brings the tail of the
conversation it came from along as a marked replay, for the rewrite only. You meet the cards only here: the front, space for the answer, then one of two answers — ← again or → got it
(space stands for got it; either arrow shows the answer first) — that schedules the next sight of it with FSRS,
the scheduler modern Anki uses.
New cards come first with a mark, because the first look is also the moment to throw one out: **deleting a
card (X) is the signal.** Deleted cards move to a pile the worker reads before writing, as examples of what
not to write, so a rejected card never comes back reworded; a card deleted after many failed reviews reads
as "badly written", one deleted unseen as "not wanted". Cards you keep failing are offered back to the worker
for a rewrite. E edits in place, O opens the desk it came from, Z undoes a delete. "all cards" lists every
card with search and holds the worker's knobs — on/off, cards a day, the model it asks, run now — and an
export in Anki's plain-text import format. Everything is files: `~/.letta/loki/recall/{cards,schedule,rejected}/<id>.json`,
content and review history kept apart so the worker's edits never touch your schedule. The worker's own
conversation with each agent — one per agent, named "recall", for the life of the agent — is a desk in the tree
(⌘K), so you can read what it asked and what came back; it stays out of the inbox. After each answer the worker
compacts it (`/compact all`), so the next question starts from a short summary of the earlier ones rather than
every transcript ever sent, while the transcript on disk keeps everything. Its working directory is
`~/.letta/loki/recall/` itself: the prompt quotes only the existing cards whose wording overlaps the stretches
and names the folder for the rest, so the model can grep the deck with its read-only tools before writing, and
the prompt stops growing with the deck. Letta's project settings there (`.letta/settings.local.json`) keep the
dreaming pass off: the writer's digests of your conversations are never turned into the agent's memory. The
settings file is the worker's; it puts the trigger back to off if it finds it changed.

**Leads.** In the same call, the writer names up to two things per conversation the person could learn
properly: a concept they asked about, an explanation they took on trust, an acronym that went by. Each is a
lead — a title, one line quoting the moment, a depth (a primer in one sitting, or a course) — under the
**leads** tab, newest first, at most twelve open. Clicking a lead creates a `[Learn] · <title>` conversation
with the agent that was there, puts an info card with the lead on its desk, opens the desk with the chat and sends
the brief as your first message: open with why this matters to you, furnish the desk with the outline as a list you
can tick, ask before telling, one idea at a time, a cold quiz at the end. A lesson whose brief never arrived (the
conversation is still empty) is listed under "lessons under way" with **send the brief**.
**not this** moves the lead to a dismissed pile the writer reads before proposing again (restore under
**deleted**). Learn conversations are desks in the tree and never inbox cards. Files: `~/.letta/loki/recall/{leads,leads-dismissed,lessons}/`.
The plan is `docs/plans/2026-09-12-008-feat-loki-learn-plan.md`.

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

## Environment variables

`LOKI_PORT` (mod, default 41414), `LOKI_WIDGETS_DIR` (default `~/.letta/loki/widgets`),
`LOKI_APP_SERVER_URL` (skip discovery), `LOKI_LETTA_BIN` / `LOKI_BD` (binaries), `LOKI_INSTALL=1` (make a
dev build install its bundled mod instead of linking the checkout), `LOKI_NO_INSTALL=1` (stop a release build
from installing, and a dev build from linking).
Logs: `~/.letta/loki/mod.log`, `~/.letta/loki/logs/harness.log` (the harness loki starts),
`~/.letta/loki/logs/install.log` (every Letta Code install or update, appended). To run the mod without Letta:
`bun scripts/harness.ts`.

## Hard rules

- No real money amounts on screen, in the repo, or in recordings. Ever.
- Widget code runs with the page's full trust. This is your machine and your agent; it is not a sandbox
  (see [SECURITY.md](SECURITY.md)).
