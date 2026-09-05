# loci

A memory palace your agent builds. loci is a [Letta Code](https://docs.letta.com) mod plus a browser
widget desk. **The desk is a directory**: the agent writes `.json` and `.tsx` files into
`~/.letta/loci/widgets/<desk>/`, Vite hot-loads them into the open tab, you drag and operate them, and what you
did rides along on your next message.

Each conversation gets its own desk, created lazily on first widget. A `shared` desk holds widgets that
belong to no conversation. The tab follows the active conversation.

## Layout

```text
mod/            Letta mod, plain TypeScript; boot.ts bundles it fresh on each /reload (no manual build)
shared/         desk-core: types + the pure gesture reducer both halves use
app/            Vite + React canvas
skills/loci/    the vocabulary the agent reads (kit types, .tsx contract, rules)
test/           bun tests
```

## What the mod does

Only the things a mod can do:

- owns geometry and gesture state per desk (`~/.letta/loci/state/<desk>.json`); places new widgets in the first free spot using sizes the tab reports back, and can tidy a desk into a grid (the `arrange` button or ⌘⇧A)
- watches `~/.letta/loci/widgets/`, syntax-checks `.tsx` with esbuild, tells the tab what changed
- appends the user's desk activity to their next turn (`turn_start`)
- mirrors the desk's conversation into the canvas chat, live, through Letta's app-server: every turn streams
  token by token whether it was typed in Desktop or in the canvas, and canvas messages are queued by Letta if a turn
  is running. Falls back to direct sends on the conversation handle where no app-server exists (plain CLI without channels).
- adopts or spawns the Vite dev server, detached so it survives `/reload`
- tools: `desk_state`, `loci_camera` (one widget, or several framed together, with an optional dwell). Rendering and authoring are file writes.

## Install (development)

```bash
npm install
```

Shim. Everything in `~/.letta/mods/` is loaded as a mod, so only this file lives there:

```ts
// ~/.letta/mods/loci.ts
import { pathToFileURL } from "node:url";
export default async function activate(letta: unknown) {
  const url = pathToFileURL("/ABSOLUTE/PATH/TO/loci/mod/boot.ts");
  url.searchParams.set("v", String(Date.now())); // boot.ts re-bundles the mod's files on every /reload
  const mod = await import(url.href);
  return mod.default(letta);
}
```

Skill, so the agent knows the vocabulary:

```bash
ln -s /ABSOLUTE/PATH/TO/loci/skills/loci ~/.agents/skills/loci
```

Then `/reload` in Letta Code and `/canvas`.

## Install as an app (Chrome)

The canvas ships a web app manifest, so Chrome can install it: open the canvas
tab, then menu → Save and share → Install page as app. It opens in its own
window with the loci icon. The tab remembers its token and last desk in
localStorage, so the installed app resumes where you left off even though its
launch URL carries no parameters. It still needs Letta Desktop running: the mod
starts the Vite server when you run `/canvas`.

Vim-key extensions (Vimium, Surfingkeys) run inside installed apps too and bind
plain `r` to reload, which also swallows loci's own shortcuts. Exclude the canvas
in the extension's options, e.g. Vimium → Excluded URLs: `http://127.0.0.1:5173*`.

## Catch Up

The canvas knows which conversations are waiting on you. A chip at the top-right shows the count; click it or press
⌘⇧K for a Slack-style deck, one conversation per card with the recent thread inside it (newest at the bottom,
tool calls as muted markers): approvals first (approve/deny inline), then questions, failures, and finished work. → marks seen, ← keeps unread, R replies from the card, O opens that desk, Z undoes.
Catch Up runs in the browser: it speaks Letta's app-server protocol (agent and conversation lists, message history,
runtime subscriptions, approvals) through the mod's `/appserver` tunnel, which exists because the app-server refuses
browser origins. The mod contributes only the tunnel and the seen markers in `~/.letta/loci/state/attention.json`.

Every desk, switcher row, chat header, and Catch Up card carries a colour-coded chip naming the agent that owns the
conversation, so multi-agent setups stay legible.

## Widget frame controls

Each frame has three buttons: **focus** (front, centre, zoomed in), **minimise** (to the tray at the bottom-left; the file stays), and **trash** (deletes the file after a confirm). The agent hears about all three on your next turn.

## Commands

- `/canvas` — start the desk server and Vite if needed, open this conversation's desk.

## Development

```bash
npm test               # bun test
npm run typecheck      # tsc
npm run dev            # run Vite by hand (the mod normally does this)
```

Env: `LOCI_PORT` (mod, default 41414), `LOCI_APP_PORT` (Vite, default 5173), `LOCI_WIDGETS_DIR` (default `~/.letta/loci/widgets`), `LOCI_APP_SERVER_URL` (skip discovery), `LOCI_NO_OPEN=1` (do not open a browser).
Trace log: `~/.letta/loci/mod.log`. Harness for running the mod without Letta: `node scripts/harness.mjs`.
Vite's log: `~/.letta/loci/vite.log`.

## Hard rules

- No real money amounts on screen, in the repo, or in recordings. Ever.
- Widget code runs with the page's full trust. This is your machine and your agent; it is not a sandbox.
