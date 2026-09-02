# loci

A memory palace your agent builds. loci is a [Letta Code](https://docs.letta.com) mod that turns a browser tab into a shared widget desk: the agent renders and *authors* live React widgets, you operate them, and a camera glides you around your own life.

Status: spike phase. Plan: `docs/plans/2026-09-01-001-feat-loci-plan.md`.

## Install (development)

```bash
npm install
npm run build
```

Then create the shim that Letta Code's mod loader picks up:

```bash
cat > ~/.letta/mods/loci.ts <<'EOF'
import { pathToFileURL } from "node:url";
export default async function activate(letta: unknown) {
  const url = pathToFileURL("/ABSOLUTE/PATH/TO/loci/dist/mod.js");
  url.searchParams.set("v", String(Date.now()));
  const mod = await import(url.href);
  return mod.default(letta);
}
EOF
```

(Replace the path with this repo's location. Everything in `~/.letta/mods/` is loaded as a mod, so only the shim lives there; the project stays here. The cache-busting query matters: a plain static re-export would pin Node's ESM cache to the first build ever loaded and `/reload` would silently keep running stale code. Mod cleanup runs via `letta.signal` abort, so the lost-disposer risk of an async activate is covered.)

Run `/reload` in Letta Code, then `/canvas`.

## Commands

- `/canvas` — start the desk server (127.0.0.1, tokenized URL) and open the canvas tab.

## Development

```bash
npm run watch   # rebuild mod + web on change; /reload in Letta Code to pick up mod changes
npm test        # bun test
```

## Hard rules

- No real money amounts on screen, in the repo, or in recordings. Ever.
