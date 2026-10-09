/**
 * The loki daemon (plan 017): the one long-running process the shell starts and supervises in place of
 * `letta server`. It holds the lock and loads the mods: loki's own (canvas, board, Learn, the phone listener) and
 * any in the `mods` folder beside its state, on loki's mod API (daemon/mods). The chats themselves follow (U5, U6).
 *
 *   node daemon.mjs --loki-daemon --dir <loki folder> --mod <mod entry> [--token-file <file>]
 *
 * `--loki-daemon` and the token file mark the command line as loki's, so a shell finds a leftover from a crash.
 * Exit code 3: another daemon holds this folder's lock; the shell then leaves that one serving.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { acquire, type Lock } from "./lock.ts";
import { loadModFolder, watchFiles } from "./mods/files.ts";
import { fromLettaMod } from "./mods/letta-facade.ts";
import { ModRegistry } from "./mods/registry.ts";

export const EXIT_HELD = 3;

const { values: args } = parseArgs({
  options: {
    "loki-daemon": { type: "boolean" },
    dir: { type: "string" },
    mod: { type: "string" },
    "token-file": { type: "string" },
  },
});
if (!args.dir || !args.mod) {
  console.error("loki-daemon: --dir and --mod are required");
  process.exit(2);
}

mkdirSync(args.dir, { recursive: true });
const taken = acquire(join(args.dir, "daemon.lock"));
if (!("release" in taken)) {
  console.error(`loki-daemon: another daemon (pid ${taken.heldBy}) is serving ${args.dir}`);
  process.exit(EXIT_HELD);
}
const lock: Lock = taken;

const report = (message: string) => console.error(`loki-daemon: ${message}`);
const mods = new ModRegistry(report);

// loki's own mod, written for Letta's API, through the facade (daemon/mods/letta-facade.ts). It serves only inside a
// host that is not a terminal session (mod/gate.ts); the daemon always is one.
process.env.LOKI_MOD_SERVE ??= "1";
const core = (await import(pathToFileURL(args.mod).href)) as { default: (host: unknown) => unknown };
const loadCore = () => mods.load(fromLettaMod("loki", core.default));
await loadCore();
// A checkout's mod (mod/boot.ts bundles mod/index.ts afresh on every activate) reloads when its sources change.
const stopWatchingCore = args.mod.endsWith("boot.ts")
  ? watchFiles(dirname(args.mod), (f) => f.endsWith(".ts") && !f.includes(".loki-build"), async (file) => {
      const result = await loadCore();
      report(`mod loki reloaded after ${file} changed: ${"loaded" in result ? "ok" : result.refused}`);
    })
  : () => {};
const stopWatchingMods = await loadModFolder(mods, join(args.dir, "mods"), report);
console.error(`loki-daemon: pid ${process.pid} serving ${args.dir} with mods ${mods.names().join(", ")}`);

let stopping = false;
function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  console.error(`loki-daemon: ${signal}, stopping`);
  try {
    stopWatchingCore();
    stopWatchingMods();
    for (const name of mods.names()) mods.unload(name);
  } finally {
    lock.release();
    process.exit(0);
  }
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
process.on("exit", () => lock.release());
