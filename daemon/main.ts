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
import { deviceIdIn, Providers } from "./providers.ts";
import { memoryExtension } from "./memory.ts";
import { fileToolsExtension } from "./tools.ts";
import { skillsExtension } from "./skills.ts";
import { subagentExtension } from "./subagents.ts";
import { webSearchExtension } from "./web-search.ts";
import { importFromLetta } from "./import/letta.ts";
import { recallDir } from "../mod/recall.ts";
import { BackgroundTasks, backgroundExtension } from "./background.ts";
import { Schedules, scheduleExtension } from "./schedule.ts";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { Reflection } from "./reflection.ts";
import { readLocalAgent } from "../mod/agents.ts";
import { ChatProjection } from "./chats.ts";
import { StoreManager } from "./kernel/stores.ts";
import { listAgents } from "./store/agents.ts";
import { acquire, type Lock } from "./lock.ts";
import { loadModFolder, watchFiles } from "./mods/files.ts";
import { MOD_API_VERSION, type ModApi } from "./mods/api.ts";
import type { Host } from "../mod/index.ts";
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

// The daemon's agents (records and memory, daemon/store/agents.ts), reflection's counters and the pinned chats live
// under its folder; the mod's readers are told where, for a daemon serving a folder other than ~/.loki. Each agent's
// chats are in its own store (daemon/kernel/stores.ts).
const backend = join(args.dir, "backend");
process.env.LOKI_BACKEND_DIR = backend;
process.env.LOKI_REFLECTION_DIR = join(args.dir, "reflection");
process.env.LOKI_PINS_FILE ??= join(args.dir, "state", "pins.json");
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
// The tools every chat has: pi-durable's own (read, write, edit, bash), loki's file tools, memory, skills and the
// agent's project instructions, and helpers (subagents).
mods.registry.install(CodingTools);
mods.registry.install(fileToolsExtension());
mods.registry.install(memoryExtension(backend));
mods.registry.install(skillsExtension(backend));
mods.registry.install(subagentExtension());
mods.registry.install(webSearchExtension());
// Background tasks and scheduled prompts deliver into their chat through `chat`, made below (daemon/background.ts,
// daemon/schedule.ts).
const schedulesFile = join(args.dir, "state", "crons.json");
const deliver = (agentId: string, chatId: string, text: string) => chat.deliver(agentId, chatId, text);
const background = new BackgroundTasks((agentId, chatId, text) => void deliver(agentId, chatId, text).catch((e: unknown) => report(`task notice not delivered: ${String(e)}`)));
mods.registry.install(backgroundExtension(background));
const schedules = new Schedules(schedulesFile, deliver, report);
mods.registry.install(scheduleExtension(schedules));
const providers = new Providers(models, credentials ?? new KeychainCredentials(memorySecrets()), report, deviceIdIn(join(args.dir, "state", "device-id")));
const chats = new ChatProjection(context, (id) => readLocalAgent(id, backend)?.name ?? null);
const reflection = new Reflection({ stores, chats, registry: mods.registry, backendDir: backend, root: join(args.dir, "reflection"), settingsFile: join(args.dir, "state", "reflection.json"), context, report });
const importDone = join(args.dir, "state", "letta-import.json");
const importLetta = () =>
  importFromLetta({
    paths: {
      letta: join(homedir(), ".letta"),
      backendDir: backend,
      doneFile: importDone,
      schedulesFile,
      pinsFile: process.env.LOKI_PINS_FILE!,
      recallWorkerFile: join(recallDir(), "worker.json"),
    },
    stores,
    credentials: credentials ?? new KeychainCredentials(memorySecrets()),
    knownProviders: new Set(models.getProviders().map((p) => p.id)),
    context,
    imported: (agentId, chatId, entries) => reflection.markReflected(agentId, chatId, entries),
  });
const chat = new DaemonChats({ stores, mods, approvals, providers, reflection, models, backendDir: backend, context, report, importLetta });
chats.follow(stores);
await Promise.all(
  listAgents(backend).map(async (id) => {
    const store = await stores.get(id);
    await store.setAgent({ id, name: readLocalAgent(id, backend)?.name ?? id }, context);
  }),
);

// loki's own mod (mod/index.ts), on the mod API with the chats as its host: read (`chats`) and run (`chat`).
const core = (await import(pathToFileURL(args.mod).href)) as { default: (api: ModApi, host: Host) => unknown };
const loadCore = () => mods.load({ name: "loki", apiVersion: MOD_API_VERSION, activate: (api) => core.default(api, { chats, chat }) as Promise<() => void> | (() => void) });
await loadCore();
// A checkout's mod (mod/boot.ts bundles mod/index.ts afresh on every activate) reloads when its sources change.
const stopWatchingCore = args.mod.endsWith("boot.ts")
  ? watchFiles(dirname(args.mod), (f) => f.endsWith(".ts") && !f.includes(".loki-build"), async (file) => {
      const result = await loadCore();
      report(`mod loki reloaded after ${file} changed: ${"loaded" in result ? "ok" : result.refused}`);
    })
  : () => {};
const stopWatchingMods = await loadModFolder(mods, join(args.dir, "mods"), report);
schedules.start();
console.error(`loki-daemon: pid ${process.pid} serving ${args.dir} with mods ${mods.names().join(", ")}`);

let stopping = false;
function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  console.error(`loki-daemon: ${signal}, stopping`);
  try {
    stopWatchingCore();
    stopWatchingMods();
    schedules.stop();
    background.stopAll();
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
