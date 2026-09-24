# The loki manual

Everything the README leaves out: every view, every key, every file loki writes. The README is the
tour; this is the reference. Paths are the defaults; the Files page in Settings shows yours.

## Requirements

- **macOS 13 or later.** The shell finds Letta Desktop with `lsof`, and uses the traffic lights over a hidden
  title bar, the dock badge and a global shortcut.
- **Or, as a preview, 64-bit Windows 10 or 11, or a current 64-bit desktop Linux** (the `.deb` for Debian and
  Ubuntu, the AppImage elsewhere). Built and tested in CI, not yet tried on real machines; what differs is under
  [Windows and Linux](#windows-and-linux).
- **Letta Code.** loki runs the one on your Mac — the same `letta` a terminal runs. On launch the shell looks
  where installers put it (`LOKI_LETTA_BIN`, PATH, `/opt/homebrew/bin`, `/usr/local/bin`, volta, bun, nvm, fnm,
  npm's global bin) and, finding none, runs `npm install -g @letta-ai/letta-code@latest` with the npm beside the
  first Node 22.19 or newer it finds the same way (Homebrew's `node` comes with the cask), so the terminal's
  `letta` and loki's are one file. On Linux the list swaps Homebrew for `/usr/local/bin`, `/usr/bin` and
  Linuxbrew; on Windows it is npm's global folder under `%APPDATA%`, the nodejs.org installer's, volta,
  nvm-windows, fnm, scoop and bun, and npm runs as `npm.cmd`. loki never downloads Node: with none new enough,
  Welcome says so, names the usual command (`brew install node`, `winget install OpenJS.NodeJS.LTS`, or
  `sudo apt install nodejs npm` / `sudo dnf install nodejs` when the distribution's Node is new enough), links
  nodejs.org, and has **check again**. Welcome shows the install as it runs; a global folder npm may not write (the
  nodejs.org installer leaves one owned by root) gets the `sudo` line to run yourself, since loki never runs one.
  If an app-server is already running — Letta Desktop's, a `letta server` you started, Letta's channel gateway —
  loki attaches to it and launches nothing; a plain terminal `letta` opens no app-server, so it is never loki's
  harness. Otherwise loki launches `letta server` itself. Settings › letta shows which, the path in use, and the
  harness's version against the range loki runs on (`core/compat.ts`: below the minimum it says so and names the
  upgrade line; above the tested release it says "newer than tested"). The harness loki launches runs with the
  self-updater off, so nothing changes under a session; your terminal sessions keep the install fresh by themselves,
  and Settings › letta has **check** (asks npm for the newest) and **update** (the same `npm install -g`, then the
  harness restarts).
  The harness runs with `LETTA_SCRATCHPAD` set to a folder under `~/.letta` (`~/.letta/loki/scratch` by default,
  emptied at each start): since Letta Code 0.31.13 its memory subagents — the dreaming (reflection) pass, its
  selector, the explicit-merge reviewer — run in a sandbox that may only write under `~/.letta`, and Letta's own
  scratch folder, under the system temp directory, is refused, so every pass failed before its first command.
  Settings › letta shows the folder, lets you change it, and gives the line for a `letta` you run in a terminal
  (a different folder: Letta names the files inside by a per-process counter, so two harnesses must not share one).
- **beads** (`brew install beads`, or `npm install -g @beads/bd` on Windows and Linux) for the board. Optional;
  everything else works without it.

## Install

**Homebrew**, the recommended way:

```bash
brew install --cask almondlabs/loki/loki
xattr -dr com.apple.quarantine /Applications/loki.app
```

The second line matters. loki is not signed with an Apple Developer ID, and macOS refuses to open an unsigned
download as "damaged"; Homebrew quarantines cask downloads like a browser would, and Homebrew 7 no longer has
a flag to skip that (`--no-quarantine` is gone), so the flag is cleared by hand once per install. The cask's
own caveat says the same. Upgrades are `brew upgrade --cask loki`, then the `xattr` line again; the cask
follows each release. Versions are dates (`2026.9.28` shipped on that day, UTC).

**Nightly**: `brew install --cask almondlabs/loki/loki-nightly` is every merge to `main`, built about twenty
minutes after it lands, versioned `2026.9.28-nightly.a96ee85` after the day and the commit. The two casks
conflict — both builds share `~/.letta/loki`, the mod shim and the harness port — so switching channels is an
uninstall and an install. Settings › letta shows which channel a build is on and names the right cask in its
upgrade line. How releases are cut: [docs/RELEASING.md](RELEASING.md).

**The `.dmg`** from the latest release: drag loki to Applications, then clear the quarantine flag once (right-click →
Open is not enough for an unsigned app on macOS 14 and later):

```bash
xattr -dr com.apple.quarantine /Applications/loki.app
```

Or open it, dismiss the dialog, and allow it under System Settings › Privacy & Security.

**From source**: Bun, Rust and Xcode's command line tools, then `bun start` to run the checkout or
`bun run desktop:build` for a `.app` (see the README). A build made on your own Mac never carries the flag.

**Windows (preview)**: `loki_<version>_x64-setup.exe` from the release, an unsigned NSIS installer. SmartScreen
stops it as an unknown publisher; **More info**, then **Run anyway**, once.

**Linux (preview)**: `loki_<version>_amd64.deb` (`sudo apt install ./loki_*_amd64.deb`) or
`loki_<version>_amd64.AppImage`, which needs `chmod +x` and FUSE 2 (`libfuse2`, `libfuse2t64` on Ubuntu 24.04).
Both are built on Ubuntu 22.04.

On Windows and Linux an upgrade is the next file from the same release channel; Settings › letta links it when
one is out. No package manager carries them yet.

Whichever way, Letta Code need not be installed first: loki uses the one on your Mac or installs it with npm
(Requirements). The cask brings Node; the `.dmg`, source, Windows and Linux routes need a Node 22.19 or newer only
when no `letta` is there yet. Then:

1. Open loki. On first launch it finds or installs Letta Code, copies its mod to `~/.letta/loki/mod/`, writes the
   shim `~/.letta/mods/loki.ts` that Letta loads, and installs the agent's skill at `~/.agents/skills/loki/`.
   Settings → install shows what happened. Every harness on the Mac loads that shim — Letta has one shared mods
   folder — but the mod serves the desk only inside a harness that hosts an app-server (loki's own, Letta Desktop,
   a `letta server`); in a terminal `letta` session it logs one line and stands down, so it never takes the
   desk's port or runs a second card writer there.
2. If Letta Desktop (or a `letta server`) was already running, loki attached to it, and Settings says to `/reload`
   in it (or restart Desktop) so it picks the mod up. If nothing was running, loki launched its own harness and the
   mod is already in it.
3. The first launch shows **Welcome** over the empty desk: connect a model provider (paste a key from one of
   the providers Letta Code connects to — Anthropic, OpenAI, Google, OpenRouter, Ollama for local models and
   more; Letta checks it with the provider and keeps it, loki never sees it again; every turn is billed by that
   provider), then name your first agent and
   pick one of Letta's personalities. You land on its main chat, on Messages, with the message box focused.
4. Ask your agent to put something on the desk.

Updates are a new release (`brew upgrade --cask loki`, or `--cask loki-nightly`, or the next `.dmg`); the app re-installs its mod on launch
when the bundle changed. It never overwrites a shim or skill it did not write, so a checkout wired up for
development (below) keeps working. Letta Code moves when your terminal updates it or from Settings › letta (see
Requirements); the harness loki launches never updates itself.

## The window

The native title bar is hidden: the traffic lights sit over the rail, and a thin strip along the top drags the
window (double-click zooms). The window title still names what shows — the desk's name, "Inbox · n waiting",
"Board · n open", "Agents", "Settings" — for the Window menu and Mission Control. On the left, a rail of six
sections with a red count on what needs you; beside it, for Desk, Board, Agents and Learn, a **sidebar** listing
that section's items; the chosen item fills the rest. ⌘⇧D (or the rail's sidebar button) shows or hides the
sidebar (in the Inbox, which has none, ⌘⇧D is Deny); drag its edge (or focus it and use the arrows) for a
width between 220 and 420. A window under 1100 wide starts with it hidden. ⌘⇧W hides loki. On Windows and
Linux the strip is loki's own, with ☰ and the window buttons (see [Windows and Linux](#windows-and-linux)).

- **Desk** (⌘1): the sidebar lists your desks — **Pinned** first, then one section per agent (each folds, each
  with a "+" for a new desk with that agent), then **Archived**, folded. A desk's name goes bold when its agent
  wrote since you looked, a red badge says it waits on you, a green dot that its agent is working. A finished
  desk also carries a small ring after its name until it is **done**. Looking is not done: opening a desk (or
  having it open, the window in front, when a message arrives) marks it **viewed**, which drops the bold and
  keeps the ring and its Inbox card, so bold + ring is new since you looked, the ring alone is viewed but not
  done, and neither is done. Done is what the Inbox's → does, a reply, an approval or an answer; by hand it is
  **Mark as done** (⌘⇧↵ on the open desk, or the row's right-click menu, or the desk header's ⋯ menu), and
  **Mark as not done** in the same menus puts the ring and the Inbox card back (the bold stays off: you have
  seen it). Viewed and done are kept by the mod, so the phone and the Mac agree on both. "Find a
  desk…" at the top filters by desk or agent name (↓ into the list, ↑↓ between desks, ↵ opens the first match).
  Hover a row for pin and archive, right-click it for the same with open, rename and restore. **Rename…** (also in
  the desk header's ⋯ menu) opens a small dialog with the name selected: ↵ saves, esc cancels, and a name is at
  most 80 characters. The name is the Letta conversation's own, so Letta Desktop sees it too; an agent's main
  chat is named after the agent and cannot be renamed, and renaming needs the app-server. When a desk that waits on
  you is scrolled out of sight, a red "Needs you" pill at the top or bottom edge scrolls to it. The sidebar keeps
  its scroll and folds across restarts.
  Opening a desk — from the sidebar, ⌘K, the Inbox, Agents or Learn — shows it like a Slack channel: a header
  with its name, its agent and what the agent is doing, pin, archive and a ⋯ menu (mark as done or not done, rename, find, model,
  permission mode, new desk, and on the Desk tab arrange, fit and the chat toggle), then two tabs. **Messages** is the
  conversation, the message box focused: each message with the author's face, name and time, a pill for each
  day, a red **New** line before what came since you last looked (it stays put while the desk is open, as
  Slack's does, and moves on the next open), a copy button on hover, and a line each time the agent
  adds, changes or removes a widget ("friday added Revenue chart"). Click that line and the **Desk** tab opens
  framed on the widget. The Desk tab is the sheet edge to edge with the chat over it, the sidebar hidden, the
  rail kept: the chat on the left, centred and wider, or on the right (⌘← and ⌘→ move it, ⌥⌘ from inside a text
  box, ⌘/ toggles it, ⌘W closes it; ⌘0 fits all widgets, ⌘⇧0 is 1:1, ⌘= ⌘- zoom, ⌘⇧A arranges, ⌘Z undoes a widget
  move). A side chat is a viewport inset: fit-all, focus and camera glides frame widgets in the uncovered part,
  and opening or closing a left chat slides the sheet so nothing ends up under it. Esc (outside a text box) or
  the Messages tab goes back to the conversation where you left it. Both tabs are the same conversation with the
  same draft. ⌘L focuses the message box and ⌘F finds in the transcript, on whichever tab shows. Under the message
  box sit two chips for the conversation: its **permission mode** (strict, standard, accept edits, unrestricted;
  ⌘⇧P) and its **model** (⌘⇧M, type to filter every handle the harness offers). Both apply per conversation
  through the app-server; a main chat's model is the agent's. Inbox cards carry the same chips in their actions
  row. ⌘[ and ⌘] step through live desks, each on the tab you left it on.
- **Inbox** (⌘2, or ⌥Space from anywhere on the Mac): Catch Up as a full view, see below. The rail icon carries
  the waiting count, the same number the tray title and dock badge show.
- **Board** (⌘3): tasks for later, see below.
- **Agents** (⌘4): the sidebar lists your agents like Slack's direct messages — face, name, a green dot while
  one works, the last thing it said, a red count of what waits on you — and the chosen agent fills the pane with
  a tab per page (a first visit lands on memory); the "+" at the top of the sidebar makes a new agent. **profile**: face, name, description and model
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
- **Settings** (⌘, or ⌘6, or the rail's gear): opens **Preferences** over the whole window, ten pages down the
  left, one showing at a time, the last one remembered for the window. ⌘, closes it again, ⌘[ and ⌘] step its
  pages, ⌘1-5 close it and go to that section, Esc closes it. In the page list, ↑↓, Home and End move between
  pages. The pages, in order:
  1. **letta**: loki's own version and whether a newer release is out (asked of GitHub on launch and every six
     hours; `brew upgrade --cask loki` is the way up, or on Windows and Linux a link to that system's file, with
     the preview note), which harness the app is on, the harness's **scratch**
     folder (see Requirements) with apply, back to the default, and the line for a terminal, how it reaches the
     mod, requirements and install status.
  2. **inbox**: how the deck orders its cards (see "The order") and the two knobs of the Later ladder (see
     "Later, with backoff").
  3. **providers**: the harness's catalogue, connected first; a row opens into the fields it needs, keys are
     checked with the provider before Letta keeps them; OAuth ones say which `letta connect` to run.
  4. **phone**: the LAN switch, the route (Tailscale or this Wi‑Fi), the pairing QR and code, paired phones.
     Mac only for now.
  5. **skills**: the global skills in `~/.letta/skills` that every agent reads, each with disable, and a field
     to enable a folder holding a `SKILL.md`; an agent's own skills are on its Agents page.
  6. **learn**: the card writer's switch (off until you turn it on), cards a day (a cap on the deck, per
     calendar day; leads are still looked for once it is reached), sweep every N minutes (how often the writer
     looks for quiet conversations; ten by default, one to 1440; each sweep that finds some is one model call
     per agent over the agent's whole fixed prompt), the model it asks, run now, and the leads it proposes.
  7. **appearance**: system, light or dark (system follows macOS as it changes), and the palette, loki or
     tokyo night; kept per device.
  8. **chat**: where the panel sits on the Desk tab (left, centre, right) and its side width (narrow, wide).
  9. **files**: where everything lives.
  10. **keys**: the complete keymap, and the switch for ⌥Space — the one system-wide key, off if Raycast,
      Alfred or the input-source switcher wants it (Mac only).

**⌘K** opens search from anywhere: desks, agents, what waits on you in the Inbox, and the app's pages (each
section, each Preferences page). It finds names, not message text, and says so. With nothing typed it lists the
places you visited last; ↑↓ move, ↵ opens the top result (a desk on Messages), Esc or ⌘K again closes it. `/desks`
in a message box opens it too. ⌘K used to open the desks tree; the sidebar holds that list now.

`?` (outside a text box) opens a sheet of the keys that work in the view showing, its own first, then the ones
that work everywhere (less any the view takes for itself, such as ⌘⇧D in the Inbox; Settings › keys says so); `?` or
Esc closes it. ⌘[ and ⌘] step through whatever the section showing is made of: desks on the desk, cards in the inbox, columns
on the board, views in Learn, agents in Agents, pages in Preferences — the same two keys everywhere, never a jump
back to the desk. Esc peels one layer: a sheet or menu, then the Desk tab back to Messages, then a view back to the desk. Every shortcut lives in one table
(`app/src/shell/keymap.ts`) that drives the key handler, the Settings page, and the native menu bar (the ☰ menu
on Windows and Linux), so the menus double as the cheat sheet. Rule of the table: plain letters work where nothing has focus (the board, the
sheet); where a text box has focus (the inbox, the chat) the same actions are ⌘ chords, and chords the text
itself uses (⌘Z, ⌘⌫, ⌘←, ⌘→) are never taken.

## Windows and Linux

A preview: built and tested in CI, not yet tried on real machines; problems go to the repository's issues, which
Settings › letta links. Desk, Inbox, Board, Agents, Learn, Preferences, search and the mod are the Mac's. What
differs:

1. **The window.** No system title bar: loki draws a 32px strip with ☰ at the left and minimise, maximise (restore
   while maximised) and close at the right, as Slack does there. The strip drags the window and a double click
   maximises; the edges resize. ☰ opens the menus the Mac's menu bar has, with the same items and keys, by mouse or
   by keyboard. The strip stays usable over a dialog. A second launch brings the running window forward instead
   of starting another loki.
2. **Keys.** ⌘ is Ctrl, ⌥ Alt, ⇧ Shift, ↵ Enter, ⌫ Backspace, and every menu, tooltip, the keys sheet and
   Settings › keys write them so. Move Chat Left and Right are Ctrl ← and Ctrl → or Ctrl Shift [ and Ctrl Shift ],
   since Ctrl Alt arrows are the system's there. Hide loki (Ctrl Shift W) is **Minimise loki**: with no tray or
   dock, a hidden window could not come back. In the packaged app the webview's own keys (reload, print, view
   source, devtools, F5, F12) do nothing; Ctrl F is loki's find.
3. **Not there yet.** The tray item and its count, the dock badge, the system-wide ⌥Space, the native menu bar,
   dictation (and its key), phone pairing and Tailscale. Where one would show, loki says it isn't on Windows (or
   Linux) yet.
4. **Folders.** Browse… in the new-desk sheet opens the system's own folder dialog; folder completion takes
   drive paths and `~\`.
5. **The harness.** The same order as on the Mac: a running Letta Desktop (found by its process name), a
   `letta server` or channel gateway (found by its command line), else loki's own `letta server` on 41600. A
   harness an earlier loki started and left behind on 41600 is taken back and stopped on quit. On Windows loki
   runs `node …\@letta-ai\letta-code\letta.js` directly, with no console window, in a Job Object that ends the
   whole tree when loki exits.
6. **Files.** `~` is your profile folder on Windows (`%USERPROFILE%`), so everything is under
   `%USERPROFILE%\.letta\loki`; the skill link is a junction where Windows refuses a symlink.
7. **Linux** runs loki through XWayland: the shell sets `GDK_BACKEND=x11` unless you set it yourself, since an
   undecorated window on native Wayland still has open resize and button bugs.

Testers: [docs/preview-checklist.md](preview-checklist.md) lists what to try on a real machine.

## Phone

The inbox and your desks, on your phone, with nothing installed. Settings › phone → switch on "reachable on
this Wi‑Fi" → "pair a phone" → scan the QR with the phone's camera → in Safari, Share → Add to Home Screen → open
the new icon and type the six-character code once (a home-screen app has its own cookie jar, so the code shown in
Settings is asked for one more time; it stays valid ten minutes). From then on the icon opens on Home. Four tabs
float in a capsule at the bottom — Home, Inbox, Agents, More, the Inbox carrying the waiting count — with a round
Search button beside them:

1. **Home**: the loki header (its menu holds the filter, the agent scope, refresh and a new desk), a row of
   shortcuts with their counts (Inbox, Learn, Agents, Archive), **Needs your attention** — the head of the
   Inbox queue — then **Desks**, pinned first. A long press on a desk (or its actions button) pins or archives it.
2. **Inbox**: the same cards as Catch Up in the same order (highest score first, see "The order"), one at a
   time. The card is the conversation: read the thread, reply, attach an image, answer a question. Under it,
   **Later** and **Mark as done**; swipe left for Later, right for Mark as done. An approval refuses both, and
   the two buttons become **Deny** and **Approve**. Undo sits in the top bar for six seconds after either.
3. **Agents**: a list like Slack's direct messages (All, Running, Waiting on you); an agent opens a readable
   profile with its memory, changes and skills in one scroll.
4. **More**: the paired Mac, then Agents, Learn, Archived desks and Preferences (appearance), then Updates,
   About loki and the connection details.
5. **Search**: desk titles, agents, waiting items and pages the phone already holds — not message text — with
   recent searches and places before you type.

**Learn** (from Home or More) is the same deck, thumb-sized: review, delete and undo; the writer's switch and
knobs stay on the Mac. A tap on a desk or a card opens the conversation: the transcript, the approval or
question card, and a reply box. Opening a conversation marks it viewed, not done, as on the Mac: a desk's name
on Home stops being bold but keeps its dot, the card stays in the inbox, and the red New line sits before what
came since your last look on either device. The conversation's actions sheet has **Mark as done** and, once
done, **Mark as not done**, and pin. No board on the phone.

The QR and the bookmark carry the Mac's Bonjour name (`my-macbook-pro.local:41415`, from System Settings
› General › Sharing › local hostname), not its address, so the same icon keeps working at home and at the office
when the Mac gets a new address. The phone talks to the Mac directly over the local network (port 41415), so
both must be on the same Wi‑Fi and the Mac must be awake with loki running; some office networks isolate
clients from each other, and then the phone cannot reach the Mac at all — Tailscale (its address appears in
Settings › phone too) is the way around that; when it is not, the phone says "Mac unreachable, last seen …" and
reconnects by itself. Each paired phone is listed in Settings › phone with when it was last seen; "forget"
locks it out. The rail shows a green dot on the settings icon while the switch is on (a blue one when a newer loki is out). If the icon opens on
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
changed, so it pairs once more.

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
- keeps the recall cards (`recall_*`) and runs the worker that writes them: every sweep (ten minutes by default) it reads the new
  stretch of any conversation quiet for ten minutes, asks its agent in its hidden "recall" conversation, and writes
  cards up to the day's cap; the deleted pile goes back into every prompt as what not to write
- serves each conversation's full transcript from the local backend log (`history_get`), which survives compaction,
  and keeps the done (`seen_mark`), viewed (`viewed_mark`) and snooze markers the inbox and the sidebar need
- keeps each desk's widget change log (`~/.letta/loki/state/widget-log/<desk>.json`, the last 200 rows), sent live
  to every tab and with each desk's history, so the conversation can show who added, changed or removed a widget
- reads and writes pins in Letta Desktop's own `~/.letta/pinned-conversations.json`, so a pin shows in both
- adopts or spawns the Vite dev server, detached so it survives `/reload`
- tools: `desk_state`, `loki_camera` (one widget, or several framed together, with an optional dwell). Rendering and authoring are file writes.

## Install (development)

You need Bun, Rust (stable, from rustup) and Xcode's command line tools; Vite and the Tauri CLI run under Bun
when there is no Node. Letta Code is found or installed by the window as the app does it (Requirements), which
needs a Node 22 or newer somewhere only when no `letta` is on the Mac yet. Then:

```bash
bun install
bun start
```

`bun start` checks three things first and stops with the fix when one is missing: `cargo` — on PATH, or in
`~/.cargo/bin` where rustup just put it (Tauri's own message is a bare "No such file or directory") — Xcode's
command line tools (`xcode-select -p`; without them the build fails later with an `xcrun` or linker error), and
that whatever answers on port 5173 is loki's own Vite and not another project's dev server, which the window
would otherwise show. It then starts Vite, opens the window (the first build compiles the shell, a few minutes),
and waits for the mod: if nothing answers on its port after a minute and a half, one paragraph names the shim
and the harness log instead of Vite's proxy errors. On a first launch, when no `letta` is on the Mac yet, the
script says so and starts that clock only once the window has installed one.
`bun start --check` reports all of it without starting anything.

A development window installs nothing from its bundle (`LOKI_INSTALL=1` makes it), so it would run a harness
without the mod on a Mac that never had loki. Instead, when the shim and the skill are both absent, it points
Letta at the checkout it was compiled from: `~/.letta/mods/loki.ts` importing `mod/boot.ts` (marked as a
development shim, so the app leaves it alone later too) and `~/.agents/skills/loki` as a symlink to `skills/loki`.
Whatever is already in either place stays; Settings › letta › install shows **linked** for each, or what was there.
Letta Code itself is found or installed the way the app does it, and the Welcome step shows the progress.

To do the same by hand — a second checkout, say — everything in `~/.letta/mods/` is loaded as a mod, so only this
file lives there (the app leaves it alone because it does not start with the managed marker). Your own terminal
`letta` loads it too and stands down (`mod/gate.ts`): only a harness hosting an app-server serves the desk.
`LOKI_MOD_SERVE=1` in a terminal session's environment makes it serve anyway, for debugging.

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
   the mod's error on activate, and `~/.letta/loki/mod.log` for an `activate:standing-down` line (the mod decided
   this harness hosts no app-server). `/reload` in Letta Code loads it again.
2. **Welcome says the Letta Code install did not finish**: `~/.letta/loki/logs/install.log` has every line of every
   attempt; the window shows the telling one (a package that would not build, a host that would not resolve, a
   global folder npm may not write — with the `sudo` line to run in a terminal) and npm's own log path. Retry from
   Welcome once it is fixed. loki installs with `SHARP_IGNORE_GLOBAL_LIBVIPS=1`, so a Homebrew libvips on the Mac
   does not make `sharp` compile itself with node-gyp. No Node 22.19 or newer anywhere: Welcome's Node step names
   the command for your system (`brew install node`, `winget install OpenJS.NodeJS.LTS`, the distribution's
   package), then **check again**.
3. **Letta Desktop (or a `letta server`) is running**: loki attached to that harness rather than launching its own
   (Requirements). Settings › letta names it and its version against the tested range; the mod loads there from the
   shared `~/.letta/mods/loki.ts` after a `/reload` or a restart. Quit it and start loki again to run loki's own.
4. **Homebrew moved to a new Node major** and the harness log shows a module-version error from a native module:
   Letta Code's global install was built for the old one. Settings › letta › **update** (a reinstall) or
   `npm install -g @letta-ai/letta-code@latest` in a terminal rebuilds it.

## Install as an app (Chrome)

The canvas ships a web app manifest, so Chrome can install it: open the canvas
tab, then menu → Save and share → Install page as app. It opens in its own
window with the loki icon. The tab remembers its token and last desk in
localStorage, so the installed app resumes where you left off even though its
launch URL carries no parameters. It still needs a harness with the mod running (loki's own, Letta Desktop or a
`letta server`): the mod serves the desk; the page comes from Vite in a browser tab, or from the loki app itself.

Vim-key extensions (Vimium, Surfingkeys) run inside installed apps too and bind
plain `r` to reload, which also swallows loki's own shortcuts. Exclude the canvas
in the extension's options, e.g. Vimium → Excluded URLs: `http://127.0.0.1:5173*`.

## New desk

Press ⌘N, or the "+" at the top of the desk sidebar or beside an agent's section (that agent is then
chosen for you). The sheet asks for the agent (chips),
the folder (defaults to that agent's most recent one; recents, typed paths with
completion, or Browse… for the system's folder dialog; the git branch shows when the
folder is a checkout) and an optional name. Start creates the conversation
through Letta's app-server, so it appears in Desktop too, and the canvas
opens the empty desk on Messages with the message box focused.

## Questions from the agent

When an agent calls `AskUserQuestion`, the conversation (on either tab) and the inbox card show
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
browser's Web Speech API. Mac only for now. Recognition stops by itself when you pause; Enter
sends. Chrome may send the audio to Google's speech service unless on-device
recognition is available, so treat it like any other cloud dictation.

## Inbox (Catch Up)

The app knows which conversations are waiting on you. The inbox icon on the rail shows the count; click it, press
⌘2, or ⌥Space from anywhere for a Slack-style deck, one conversation per card with the recent thread inside it (newest at the bottom,
tool calls as muted markers), highest score first (see "The order" below). → or ⌘] (the card's **next →**) marks it done and moves on, ← or ⌘[ (**← later**) defers it (see "Later, with backoff"), A or ⌘↵ approves, D or ⌘⇧D denies, R focuses the reply box, O or ⌘O opens that desk on Messages with the message box focused, S or ⌘S shows or hides the snoozed ones, Z undoes the last decision (the ⌘ forms work while typing a reply), Esc returns to the desk.
Catch Up runs in the browser. Its list is the mod's: every open conversation of your agents read from the local
backend on disk (`inbox_list`), main chats included, with who spoke last taken from the tail of each log — nothing is
windowed by age or capped by count, so a conversation only leaves the inbox when it is archived (main chats are
never archived; they leave by being done). The live half — runtime subscriptions, streaming, approvals, answers —
speaks Letta's app-server protocol through the mod's `/appserver` tunnel, which exists because the app-server
refuses browser origins. The done (`seen`), viewed and snooze markers and the Later ladder live in
`~/.letta/loki/state/attention.json`, so the phone and the Mac share them.

Slash commands work in the message box, and in the reply box of an inbox card, as they do in Letta Desktop: type `/` and a palette lists what the box can
run — loki's own (`/model`, `/mode`, `/inbox`, `/desks` for ⌘K search) and the harness's (`/reload`, `/compact`, `/clear`,
`/remember`, `/reflect`, `/init`, `/doctor`, `/context-limit`, `/channels`, `/upgrade-letta-code`, plus whatever this Letta Code
advertises). ↑↓ move, ↵ runs (or fills in a command that takes arguments), ⇥ fills in, esc puts the palette away.
Harness commands go over the app-server socket as `execute_command`, the path Desktop and the channels use, and
land in the transcript as one quiet row: the command line, then its outcome. `core/attention/commands.ts`
is the table. Every bubble has a copy button under its outer corner (shown on hover, or when it has focus) that puts the
message on the clipboard as the markdown it was written in, not the rendering.

### Learn (⌘5)

The mental model — what the writer reads, asks, writes and costs, and how leads become lessons — is
[docs/learn.md](learn.md); this section is the reference for the keys and the files.

Spaced-repetition cards, for keeping what the conversations taught you. **Off until you switch it on**: the
writer spends your provider budget in the background, so the section's first visit explains what it does and
offers the switch (Settings › learn has it too, with the knobs). Nothing about the cards happens in
chat: a worker in the mod watches for conversations that have gone quiet, hands their new stretches of
transcript to the agent together — one question per agent, the stretches most worth reading first, up to a
budget; what does not fit waits for the next tick — and writes whatever comes back: one fact per card, a
question that stands alone, an answer in a line or two, up to a daily cap (twenty-five by default) shared
across the stretches. Reading them side by side, the model writes one card for a fact that came up twice and
a revision, not a second card, for a later correction; a card the person keeps failing brings the tail of the
conversation it came from along as a marked replay, for the rewrite only. You meet the cards only here: the front, space (or ↵ or ↓) for the answer, then one of two answers — ← again or → got it
(1 and 2 do the same; space then stands for got it; either arrow shows the answer first) — that schedules the next sight of it with FSRS,
the scheduler modern Anki uses.
The sidebar lists four views, each with its count: **Review** (the deck), **Leads**, **All cards** and
**Deleted**; ⌘[ and ⌘] step through them. New cards come first with a mark, because the first look is also the moment to throw one out: **deleting a
card (X or ⌫) is the signal.** Deleted cards move to a pile the worker reads before writing, as examples of what
not to write, so a rejected card never comes back reworded; a card deleted after many failed reviews reads
as "badly written", one deleted unseen as "not wanted". Cards you keep failing are offered back to the worker
for a rewrite. E edits in place, O or ⌘O opens the desk it came from, Z undoes a delete, ⌘R refreshes. **All cards** lists every
card with search and holds the worker's knobs — on/off, cards a day, sweep every N minutes, the model it asks, run now — and an
export in Anki's plain-text import format. Everything is files: `~/.letta/loki/recall/{cards,schedule,rejected}/<id>.json`,
content and review history kept apart so the worker's edits never touch your schedule. The worker's own
conversation with each agent — one per agent, named "recall", for the life of the agent — is a desk in the
sidebar (and in ⌘K), so you can read what it asked and what came back; it stays out of the inbox. After each answer the worker
compacts it (`/compact all`), so the next question starts from a short summary of the earlier ones rather than
every transcript ever sent, while the transcript on disk keeps everything. Its working directory is
`~/.letta/loki/recall/` itself: the prompt quotes only the existing cards whose wording overlaps the stretches
and names the folder for the rest, so the model can grep the deck with its read-only tools before writing, and
the prompt stops growing with the deck. Letta's project settings there (`.letta/settings.local.json`) keep the
dreaming pass off: the writer's digests of your conversations are never turned into the agent's memory. The
settings file is the worker's; it puts the trigger back to off if it finds it changed.

**Leads.** In the same call, the writer names up to two things per conversation the person could learn
properly: a concept they asked about, an explanation they took on trust, an acronym that went by. Each is a
lead — a title, one line quoting the moment, a depth (a primer in one sitting, or a course) — listed in the
**Leads** view, newest first, at most twelve open. Clicking a lead creates a `[Learn] · <title>` conversation
with the agent that was there, puts an info card with the lead on its desk, opens the desk on Messages and sends
the brief as your first message: open with why this matters to you, furnish the desk with the outline as a list you
can tick, ask before telling, one idea at a time, a cold quiz at the end. A lesson whose brief never arrived (the
conversation is still empty) is listed under "lessons under way" with **send the brief**.
**not this** moves the lead to a dismissed pile the writer reads before proposing again (restore under
**Deleted**, with the deleted cards). Learn conversations are desks in the sidebar and never inbox cards. Files: `~/.letta/loki/recall/{leads,leads-dismissed,lessons}/`.
The plan is `docs/plans/2026-09-12-008-feat-loki-learn-plan.md`.

Every desk row, desk header, message and inbox card shows the face of the agent that owns the conversation (its
`profile.png` from memory, or a coloured initial), so multi-agent setups stay legible.

### The order

The deck is a scheduler's ready queue: one score per card, one list, no sections. The score is
`blocked ? 100 : 0` (an approval, a question, a failed turn — an agent is stopped) `+ warm ? 10 : 0` (the
agent spoke under four minutes ago, so the provider still has the conversation's prompt cached and a reply
now costs a tenth of one typed later) `+ yours ? 5 : 0` (the turn answers a message you sent, not a
scheduled task's prompt) `− 0.1` an hour since the last message (`+ 0.1` for a blocked card). Blocked agents
come first, the one waiting longest ahead, then warm replies to you, then colder ones, then reports nobody
asked for — a cron's digest, a background job. For everything else age only settles ties and lets old cards
drift down. Each card says the largest term after
its time: `warm`, `reply to you`, `report` (blocked cards say it with their badge). The order is recomputed
on every event — an approval or reply on the card in front of you, a turn finishing or blocking anywhere,
the half-minute clock that fades warmth — and again whenever a card is popped, but the card in front of you
never moves until you act on it; whatever arrives lands behind it. `core/attention/priority.ts` is the score.

**A reply keeps the card.** Send a reply (or answer a question) and you stay where you are: the answer streams
into the card, and a follow-up typed then goes out while the conversation's prompt is still cached — five
turns in ten minutes cost about a quarter of the same five spread over a day. Moving on is yours (→ or ⌘]);
if you do, the answer brings the card back by score, warm and yours, behind whatever you are reading then.

### Later, with backoff

"Later" (←) on a card defers it Anki-style — the wait queue beside the ready queue: it leaves the pass and comes back
after a gap that grows each time you defer the same card in a day, at whatever score it then has. The gap is a
ladder with two knobs in Settings › inbox: the **first** deferral in minutes (default 10) and the **growth** per
further one (default ×3), so by default 10m · 30m · 1h 30m · 4h 30m · 13h 30m, and never more than a day. The
mod keeps the setting beside the seen markers, so the phone defers by the same ladder. A card that moves on
(new reply, new approval) returns at once, labelled "back". Approvals never defer. The ladder resets each day.
The deck shows how many are snoozed and when the next is due; S shows them anyway. `core/attention/ladder.ts`.

## Board (tasks for later)

Tasks you or an agent want to come back to live on one shared board, backed by
[beads](https://github.com/steveyegge/beads) (`bd`, embedded Dolt) at
`~/.letta/loki/board`. Agents file tasks only when asked, through the `loki_task`
tool, which stamps the source conversation, desk and folder; you file them from
the board's "+" or ⌘T anywhere. The Board segment (⌘3) lists its views in the sidebar —
all tasks, each status with its count, each agent — and "all tasks" shows open, in progress, blocked and
recently done columns; any other view is one list. A remembered agent view whose agent has no tasks
left says so ("<agent> isn't here any more — pick an agent") and lists the agents to pick again. Select tasks
(X or space, ⇧X or ⇧-click for a range) and press ⏎ to
**assign** them to a desk: the agent becomes the assignee and the tasks ride
along inside `<loki-tasks>` on your next message in that conversation; nothing is
sent. ⌘⏎ **dispatches** instead: assigns, then posts the tasks so the agent
starts now. New desk is a target too. ⌫ marks done, ⇧⌫ toggles blocked, ⌘R
refreshes, / filters. Agents close tasks through the tool.

Setup: `brew install beads`. The mod creates the board (`bd init --prefix lk`) the first time it is used.

## Widget frame controls

Each frame has three buttons: **focus** (front, centre, zoomed in), **minimise** (to the tray at the bottom-left; the file stays), and **trash** (deletes the file after a confirm). The agent hears about all three on your next turn.

## Analytics

loki keeps product analytics on itself — which views you open, which desks get turns, how an inbox pass went,
what you send from where, which models and modes you pick — as events in `~/.letta/loki/logs/events.jsonl`, one
per line in PostHog's shape: `{ event, timestamp, distinct_id, properties }`. Nothing involves PostHog: the mod
writes the file, nothing sends it anywhere, and `bun run analytics` on this machine is the only reader. The
`distinct_id` is one random id per install (`state/analytics.json`); properties carry `$device_type` (mac, phone,
or mod for turns and tools), a `$session_id` cut on a thirty-minute gap per device, the `$screen` on show when
a client sent the event, `$app_version`, and the event's own fields — ids and counts (a desk's scope, a model's
handle), never message text, titles or folder paths. Event names are `object_verb`: `view_opened`,
`message_sent`, `inbox_pass_completed`; `core/analytics.ts` lists them all with their properties. The file rotates
at 20 MB to `events.jsonl.1`, about two years. `LOKI_ANALYTICS=0` in the harness's environment turns it off.

`bun run analytics` (or `bun run analytics -- --days 7`) prints the report: sessions by device and their median
length, every event with its count and how many sessions it fired in, a breakdown of each event by its key
property (views by name, turns by desk, sends by origin, models picked), the inbox passes and their decision
split, the hours and weekdays loki is used, and the events that never fired in the period.

## Environment variables

`LOKI_PORT` (mod, default 41414), `LOKI_LAN_PORT` (the phone listener, default 41415), `LOKI_WIDGETS_DIR` (default `~/.letta/loki/widgets`),
`LOKI_APP_SERVER_URL` (skip discovery), `LOKI_LETTA_BIN` / `LOKI_NODE_BIN` / `LOKI_BD` / `LOKI_TAILSCALE_BIN` (binaries), `LOKI_INSTALL=1`
(make a dev build install its bundled mod instead of linking the checkout), `LOKI_NO_INSTALL=1` (stop a release
build from installing, and a dev build from linking), `LOKI_MOD_SERVE=1|0` (make the mod serve the desk, or not,
whatever harness loaded it), `LOKI_ANALYTICS=0` (no analytics), `LOKI_WS_MODULE` (debugging only: the module the mod takes `ws` from under Bun). The
harness loki launches gets `LETTA_SCRATCHPAD` (the scratch folder), `DISABLE_AUTOUPDATER=1` and
`LOKI_APP_SERVER_URL` (its own address). On Linux the shell sets `GDK_BACKEND=x11` unless it is already set. Letta runs it under
Bun when one is on PATH and under Node otherwise; `mod.log`'s `activate` line says which, and which `ws`.
Logs: `~/.letta/loki/mod.log`, `~/.letta/loki/logs/harness.log` (the harness loki starts),
`~/.letta/loki/logs/install.log` (every Letta Code install or update, appended), `~/.letta/loki/logs/events.jsonl`
(product analytics on loki itself; see "Analytics"). To run the mod without Letta:
`bun scripts/harness.ts`.

## Hard rules

- No real money amounts on screen, in the repo, or in recordings. Ever.
- Widget code runs with the page's full trust. This is your machine and your agent; it is not a sandbox
  (see [SECURITY.md](SECURITY.md)).
