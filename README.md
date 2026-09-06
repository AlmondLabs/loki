# loki

A memory palace your agent builds. loki is a [Letta Code](https://docs.letta.com) mod plus a native
widget desk (Tauri). **The desk is a directory**: the agent writes `.json` and `.tsx` files into
`~/.letta/loki/widgets/<desk>/`, the app loads them the moment they land, you drag and operate them, and what you
did rides along on your next message.

Each conversation gets its own desk, created lazily on first widget. A `shared` desk holds widgets that
belong to no conversation.

## The window

The native title bar carries the desk's name (or "Inbox · n waiting", "Board · n open", "Settings"), a rail of
four segments sits on the left, and one view fills the rest:

- **Desk** (⌘1): the sheet edge to edge, the chat stacked over it on the left, centred and wider, or on the
  right (⌘← and ⌘→ move it, ⌥⌘ from inside a text box, ⌘/ toggles it, ⌘W closes it, ⌘L focuses the message box,
  ⌘F finds in the transcript; ⌘0 fits all widgets, ⌘⇧0 is 1:1, ⌘= ⌘- zoom, ⌘⇧A arranges, ⌘Z undoes a widget move).
  A side chat is a viewport inset: fit-all, focus and camera glides frame widgets in the uncovered part, and
  opening or closing a left chat slides the sheet so nothing ends up under it. An empty desk opens the chat
  centred until its first widget lands. Clicking the desk icon again (or ⌘K) slides out the **desks tree**: desks grouped by
  agent, an attention dot per desk, "new desk" at the foot of each group; type to filter, ↑↓, ↵. Picking a desk
  closes it. ⌘[ and ⌘] step through live desks without opening anything.
- **Inbox** (⌘2, or ⌥Space from anywhere on the Mac): Catch Up as a full view, see below. The rail icon carries
  the waiting count, the same number the tray title and dock badge show.
- **Board** (⌘3): tasks for later, see below.
- **Settings** (⌘4): which harness the app is on, how it reaches the mod, where the files live, chat width, and
  the complete keymap.

Esc peels one layer: the tree, then a view back to the desk. Every shortcut lives in one table
(`app/src/shell/keymap.ts`) that drives the key handler, the Settings page, and the native menu bar, so the
menus double as the cheat sheet. Rule of the table: plain letters work where nothing has focus (the board, the
sheet); where a text box has focus (the inbox, the chat) the same actions are ⌘ chords, and chords the text
itself uses (⌘Z, ⌘⌫, ⌘←, ⌘→) are never taken.

## Layout

```text
mod/            Letta mod, plain TypeScript; boot.ts bundles it fresh on each /reload (no manual build)
shared/         desk-core: types + the pure gesture reducer both halves use
app/            Vite + React canvas
skills/loki/    the vocabulary the agent reads (kit types, .tsx contract, rules)
test/           bun tests
```

## What the mod does

Only the things a mod can do:

- owns geometry and gesture state per desk (`~/.letta/loki/state/<desk>.json`); places new widgets in the first free spot using sizes the tab reports back, and can tidy a desk into a grid (the `arrange` button or ⌘⇧A)
- watches `~/.letta/loki/widgets/`, syntax-checks `.tsx` with esbuild, tells the tab what changed
- appends the user's desk activity to their next turn (`turn_start`)
- finds Letta's app-server and tunnels the browser to it (`/appserver`); the browser owns every conversation
  view from there — the desk chat and Catch Up cards are one model (`app/src/attention`), streaming token by token
  whether a turn was typed in Desktop or in the canvas
- serves each conversation's full transcript from the local backend log (`history_get`), which survives compaction,
  and keeps the seen / snooze markers Catch Up needs
- adopts or spawns the Vite dev server, detached so it survives `/reload`
- tools: `desk_state`, `loki_camera` (one widget, or several framed together, with an optional dwell). Rendering and authoring are file writes.

## Install (development)

```bash
npm install
```

Shim. Everything in `~/.letta/mods/` is loaded as a mod, so only this file lives there:

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

Then `/reload` in Letta Code and open the loki app (`src-tauri/target/release/loki`), or run `bun run dev` and open the Vite URL for a browser tab.

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
Catch Up runs in the browser: it speaks Letta's app-server protocol (agent and conversation lists, message history,
runtime subscriptions, approvals) through the mod's `/appserver` tunnel, which exists because the app-server refuses
browser origins. The mod contributes only the tunnel and the seen markers in `~/.letta/loki/state/attention.json`.

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

Setup once: `brew install beads`, then `mkdir -p ~/.letta/loki/board && cd $_ && bd init --prefix lk --non-interactive`.

## Widget frame controls

Each frame has three buttons: **focus** (front, centre, zoomed in), **minimise** (to the tray at the bottom-left; the file stays), and **trash** (deletes the file after a confirm). The agent hears about all three on your next turn.

## Commands


## Development

```bash
npm test               # bun test
npm run typecheck      # tsc
npm run dev            # run Vite by hand (the mod normally does this)
```

Env: `LOKI_PORT` (mod, default 41414), `LOKI_WIDGETS_DIR` (default `~/.letta/loki/widgets`), `LOKI_APP_SERVER_URL` (skip discovery), `LOKI_NO_OPEN=1` (do not open a browser).
Trace log: `~/.letta/loki/mod.log`. Harness for running the mod without Letta: `node scripts/harness.mjs`.
Vite's log: `~/.letta/loki/vite.log`.

## Hard rules

- No real money amounts on screen, in the repo, or in recordings. Ever.
- Widget code runs with the page's full trust. This is your machine and your agent; it is not a sandbox.
