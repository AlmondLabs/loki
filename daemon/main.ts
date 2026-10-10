/**
 * The loki daemon (plan 017): the one long-running process the shell starts and supervises. It holds the lock, opens
 * every agent's store and runs every chat, and loads the mods: loki's own (canvas, board, Learn, the phone listener)
 * and any in the `mods` folder beside its state, on loki's mod API (daemon/mods).
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
import { BackgroundTasks, backgroundExtension } from "./background.ts";
import { Schedules, scheduleExtension } from "./schedule.ts";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { reflectionJob } from "./reflection.ts";
import { learnJob } from "./learn.ts";
import { PassRunner } from "./passes.ts";
import { JOBS, PassState } from "./passes-state.ts";
import { importFromLetta, importNeeded, type ImportPaths, type ImportReport } from "./import/letta.ts";
import { readLocalAgent } from "../mod/agents.ts";
import { ChatProjection } from "./chats.ts";
import { StoreManager } from "./kernel/stores.ts";
import { listAgents, healRecordModel } from "./store/agents.ts";
import { acquire, type Lock } from "./lock.ts";
import { loadModFolder, watchFiles } from "./mods/files.ts";
import { MOD_API_VERSION, type ModApi } from "./mods/api.ts";
import type { Host } from "../mod/index.ts";
import { ModRegistry } from "./mods/registry.ts";
import { appVersion, createAnalytics } from "../mod/analytics.ts";
import { isSubagent } from "../mod/agents.ts";
import { paths } from "../mod/paths.ts";
import { RecallStore, recallDir } from "../mod/recall.ts";
import { TurnTelemetry, harnessVersion } from "./telemetry.ts";

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

// The daemon's agents (records and memory, daemon/store/agents.ts) and the pinned chats live under its folder; the
// mod's readers are told where, for a daemon serving a folder other than ~/.loki. Each agent's chats are in its own
// store (daemon/kernel/stores.ts).
const backend = join(args.dir, "backend");
process.env.LOKI_BACKEND_DIR = backend;
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
// The background passes (daemon/passes.ts): reflection and Learn, one run at a time over chats that have gone quiet.
const passState = new PassState(join(args.dir, "state"));
const busy = (agentId: string, chatId: string): Promise<boolean> => chat.busy(agentId, chatId);
const passes = new PassRunner({ stores, chats, registry: mods.registry, state: passState, backendDir: backend, context, jobs: [reflectionJob, learnJob({ store: new RecallStore(), state: passState, chats })], busy, isSubagent: (id) => isSubagent(id, backend), capture: (event, properties) => analytics.capture("mod", event, properties), report });
// The first start after the passes came carries over reflection's and Learn's own settings and cursors, once every
// store has its chats loaded (before an import from Letta, whose chats then get cursors of their own).
const oldPassFiles = { reflectionSettings: join(args.dir, "state", "reflection.json"), reflectionRoot: join(args.dir, "reflection"), learnWorker: join(recallDir(), "worker.json") };
async function carryOverPasses(): Promise<void> {
  await chats.loaded();
  if (passState.started()) return;
  const list = chats.list().flatMap((c) => (c.agentId ? [{ agentId: c.agentId, chatId: c.conversationId, entries: chats.answers(c.conversationId, c.agentId, 0).entries }] : []));
  passState.migrate(oldPassFiles, list);
  report(`background passes: settings and cursors carried over for ${list.length} chats`);
}
// The import from Letta (daemon/import/letta.ts), for a Mac that ran loki on Letta: on its own at start until one run
// finishes, and again from Settings › loki › Import. A chat is held from the passes while its entries are written.
const importPaths: ImportPaths = {
  letta: join(homedir(), ".letta"),
  backendDir: backend,
  doneFile: join(args.dir, "state", "letta-import.json"),
  schedulesFile,
  pinsFile: process.env.LOKI_PINS_FILE!,
  recallWorkerFile: oldPassFiles.learnWorker,
};
let importing: Promise<ImportReport> | null = null;
const importLetta = (): Promise<ImportReport> =>
  (importing ??= (async () => {
    await carryOverPasses();
    return importFromLetta({
      paths: importPaths,
      stores,
      credentials: credentials ?? new KeychainCredentials(memorySecrets()),
      knownProviders: new Set(models.getProviders().map((p) => p.id)),
      context,
      passes: {
        importing: (agentId, chatId) => {
          for (const job of JOBS) passState.setCursor(job, agentId, chatId, Number.MAX_SAFE_INTEGER);
        },
        imported: (agentId, chatId, cursors) => {
          passState.setCursor("reflection", agentId, chatId, cursors.entries);
          passState.setCursor("learn", agentId, chatId, cursors.learn);
        },
      },
    });
  })().finally(() => (importing = null)));
const chat: DaemonChats = new DaemonChats({ stores, mods, approvals, providers, passes: { runner: passes, state: passState }, models, backendDir: backend, context, report, importLetta });
chats.follow(stores);
// Product analytics, local only (core/analytics.ts; `bun run analytics` reads it), one writer for the daemon and loki's
// mod. LOKI_ANALYTICS=0 turns it off. Each agent turn is one turn_finished line, measured from its store (daemon/telemetry.ts).
const analytics = createAnalytics({ path: process.env.LOKI_ANALYTICS === "0" ? null : paths.events, statePath: paths.analytics, appVersion: appVersion(paths.root) });
const telemetry = new TurnTelemetry({ capture: (event, properties) => analytics.capture("mod", event, properties), harnessVersion: harnessVersion(paths.root), isSubagent: (id) => isSubagent(id, backend), context, report });
telemetry.follow(stores);
// An agent whose record names its model as Letta did (imported before the import translated names) is renamed first.
const knownProvider = (id: string) => Boolean(models.getProvider(id));
for (const id of listAgents(backend)) if (healRecordModel(backend, id, knownProvider)) report(`${id}: its model now goes by pi-ai's name`);
await Promise.all(
  listAgents(backend).map(async (id) => {
    const store = await stores.get(id);
    await store.setAgent({ id, name: readLocalAgent(id, backend)?.name ?? id }, context);
  }),
);

// Before the mod opens its sockets, so the window never offers Welcome's first agent while Letta's are on their way.
if (importNeeded(importPaths)) {
  try {
    const r = await importLetta();
    report(`imported from Letta: ${r.agents.length} agents, ${r.chats} chats (${r.kept} already here), ${r.credentials.length} keys, ${r.schedules} schedules${r.notes.length ? `; ${r.notes.join("; ")}` : ""}`);
  } catch (error) {
    report(`import from Letta not done, tried again at the next start or from Settings › loki › Import: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// loki's own mod (mod/index.ts), on the mod API with the chats as its host: read (`chats`) and run (`chat`).
const core = (await import(pathToFileURL(args.mod).href)) as { default: (api: ModApi, host: Host) => unknown };
const loadCore = () => mods.load({ name: "loki", apiVersion: MOD_API_VERSION, activate: (api) => core.default(api, { chats, chat, analytics }) as Promise<() => void> | (() => void) });
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
// The passes' settings and cursors carried over (carryOverPasses, above); then the runner looks over the chats once a minute.
void carryOverPasses()
  .then(() => passes.start())
  .catch((error: unknown) => report(`background passes did not start: ${String(error)}`));
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
    passes.stop();
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
