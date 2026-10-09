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
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { homedir } from "node:os";
import { DaemonChats } from "./chat-backend.ts";
import { Approvals, kindOf } from "./approvals.ts";
import { askExtension } from "./ask.ts";
import { KeychainCredentials, keychain, memorySecrets } from "./credentials.ts";
import { Providers } from "./providers.ts";
import { readLocalAgent } from "../mod/agents.ts";
import { ChatProjection } from "./chats.ts";
import { StoreManager } from "./kernel/stores.ts";
import { listAgents } from "./store/agents.ts";
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
const context = BACKGROUND_CONTEXT;
const mods = new ModRegistry(report);

// The daemon's agents, in the layout Letta's backend used (daemon/store/agents.ts), so the mod's agent and memory
// readers find them through LOKI_BACKEND_DIR; each agent's chats in its own store (daemon/kernel/stores.ts).
const backend = join(args.dir, "backend");
process.env.LOKI_BACKEND_DIR = backend;
// Every provider pi-ai knows; a provider's credential from the keychain (daemon/credentials.ts), else its environment
// variable. A keychain that cannot be reached leaves the environment, and says so.
const credentials = await keychain().then(
  (backend) => new KeychainCredentials(backend),
  (error: unknown) => (report(`keychain unavailable, keys come from the environment only: ${String(error)}`), undefined),
);
const models = builtinModels(credentials ? { credentials } : {});
const stores = new StoreManager(join(args.dir, "stores"), { models, registry: mods.registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? homedir() }) }, context, report);
// The approval gate and the question card, in every chat (daemon/approvals.ts, daemon/ask.ts).
const approvals = new Approvals({ widgetsDir: process.env.LOKI_WIDGETS_DIR ?? join(args.dir, "widgets"), kindOfTool: (name) => kindOf(name, mods.annotations(name)) });
mods.registry.install(approvals.extension());
mods.registry.install(askExtension(approvals));
const providers = new Providers(models, credentials ?? new KeychainCredentials(memorySecrets()), report);
const chat = new DaemonChats({ stores, mods, approvals, providers, models, backendDir: backend, context, report });
const chats = new ChatProjection(context, (id) => readLocalAgent(id, backend)?.name ?? null);
chats.follow(stores);
await Promise.all(
  listAgents(backend).map(async (id) => {
    const store = await stores.get(id);
    await store.setAgent({ id, name: readLocalAgent(id, backend)?.name ?? id }, context);
  }),
);

// loki's own mod, written for Letta's API, through the facade (daemon/mods/letta-facade.ts). It serves only inside a
// host that is not a terminal session (mod/gate.ts); the daemon always is one.
process.env.LOKI_MOD_SERVE ??= "1";
const core = (await import(pathToFileURL(args.mod).href)) as { default: (host: unknown) => unknown };
const loadCore = () => mods.load(fromLettaMod("loki", core.default, { chats, chat }));
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
    void stores.closeAll().finally(() => {
      lock.release();
      process.exit(0);
    });
  }
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
process.on("exit", () => lock.release());
