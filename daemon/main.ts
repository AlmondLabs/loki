/**
 * The loki daemon (plan 017): the one long-running process the shell starts and supervises. It holds the lock, opens
 * every agent's store and runs every chat, and loads the mods: loki's own (canvas, Tasks, Learn, the phone listener)
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
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { homedir } from "node:os";
import { DaemonChats } from "./chat-backend.ts";
import { Approvals, kindOf } from "./approvals.ts";
import { KeychainCredentials, keychain, memorySecrets } from "./credentials.ts";
import { deviceIdIn, Providers } from "./providers.ts";
import { BackgroundTasks } from "./background.ts";
import { Schedules } from "./schedule.ts";
import { builtinExtensions, builtinKinds } from "./extensions.ts";
import { chatEnvs } from "./tool-results.ts";
import { reflectionJob } from "./reflection.ts";
import { learnJob } from "./learn.ts";
import { PassRunner } from "./passes.ts";
import { JOBS, PassState } from "./passes-state.ts";
import { describeReport, importFromLetta, importNeeded, importStatus, recordAttempt, type ImportPaths, type ImportReport } from "./import/letta.ts";
import { readLocalAgent } from "../mod/agents.ts";
import { ChatProjection } from "./chats.ts";
import { StoreManager } from "./kernel/stores.ts";
import { listAgents, healRecordModel } from "./store/agents.ts";
import { acquire, type Lock } from "./lock.ts";
import { loadModFolder, watchFiles } from "./mods/files.ts";
import { DevReload } from "./dev-reload.ts";
import { MOD_API_VERSION, type ModApi } from "./mods/api.ts";
import type { Host } from "../mod/index.ts";
import { ModRegistry, type LoadResult } from "./mods/registry.ts";
import { appVersion, createAnalytics } from "../mod/analytics.ts";
import { McpTools } from "./mcp/index.ts";
import { isSubagent } from "../mod/agents.ts";
import { paths } from "../mod/paths.ts";
import { RecallStore, recallDir } from "../mod/recall.ts";
import { TurnTelemetry, harnessVersion } from "./telemetry.ts";
import { UsageLedger } from "./usage.ts";
import { readAcpAgents } from "./acp/agents.ts";
import { AcpChats } from "./acp/chats.ts";
import { agentPrompt } from "./acp/prompt.ts";

/** The exit code when another daemon already holds this folder: the app then leaves that one serving rather than restarting this one (src-tauri/src/harness.rs). */
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
// LOKI_KEYCHAIN=0 keeps secrets in memory for this daemon's life: a test or a scratch run never writes the login keychain.
const secrets =
  process.env.LOKI_KEYCHAIN === "0"
    ? memorySecrets()
    : await keychain().catch((error: unknown) => (report(`keychain unavailable, keys come from the environment only: ${String(error)}`), undefined));
const credentials = secrets ? new KeychainCredentials(secrets) : undefined;
// The sign-in flows (ChatGPT, OpenRouter, GitHub Copilot…), imported statically. pi-ai loads each through a variable
// path so a bundler cannot follow it, and in the release bundle (daemon.mjs) that path pointed beside the bundle at
// files that are not there: every sign-in failed with "Cannot find module …/openai-chatgpt.js". Its Bun helper is
// plain static imports, which suits Node and the bundle alike.
registerBunOAuthFlows();
const models = builtinModels(credentials ? { credentials } : {});
const stores = new StoreManager(join(args.dir, "stores"), { models, registry: mods.registry, env: chatEnvs(args.dir) }, context, report);
// MCP servers (daemon/mcp/): their tools wait behind mcp_search, and their own hints say which only read.
const mcp = new McpTools({
  registry: mods.registry,
  configPath: join(args.dir, "mcp.json"),
  lokiDir: args.dir,
  report,
  version: appVersion(paths.root) ?? undefined,
  ...(secrets ? { secrets } : {}),
});
// Background tasks and scheduled prompts deliver into their chat through `chat`, made below (daemon/background.ts,
// daemon/schedule.ts).
const schedulesFile = join(args.dir, "state", "crons.json");
const deliver = (agentId: string, chatId: string, text: string) => chat.deliver(agentId, chatId, text);
const background = new BackgroundTasks(
  (agentId, chatId, text) => void chat.deliver(agentId, chatId, text, "steer").catch((e: unknown) => report(`task notice not delivered: ${String(e)}`)),
);
const schedules = new Schedules(schedulesFile, deliver, report);
// The approval gate asks by each tool's kind: loki's own declare theirs (builtinToolKinds, filled below, before any
// chat runs); a mod's or an MCP server's tools say so in their annotations. "Always allow" answers are kept beside the
// other state, for every chat.
const approvals = new Approvals({
  widgetsDir: process.env.LOKI_WIDGETS_DIR ?? join(args.dir, "widgets"),
  kindOfTool: (name) => builtinToolKinds.get(name) ?? kindOf(name, mcp.annotations(name) ?? mods.annotations(name)),
  alwaysPath: join(args.dir, "state", "approvals.json"),
});
// Every chat's built-in tools, in order, the permission gate first (daemon/extensions.ts).
const builtins = builtinExtensions({ approvals, backendDir: backend, background, schedules });
const builtinToolKinds = builtinKinds(builtins);
for (const extension of builtins) mods.registry.install(extension);
// The install's id names this Mac to the providers that ask for one, and to other paired Macs (plan 023).
const installId = deviceIdIn(join(args.dir, "state", "device-id"));
const providers = new Providers(models, credentials ?? new KeychainCredentials(memorySecrets()), report, installId);
const chats = new ChatProjection(context, (id) => readLocalAgent(id, backend)?.name ?? null);
// The background passes (daemon/passes.ts): reflection and Learn, one run at a time over chats that have gone quiet.
const passState = new PassState(join(args.dir, "state"));
const busy = (agentId: string, chatId: string): Promise<boolean> => chat.busy(agentId, chatId);
const passes = new PassRunner({
  stores,
  chats,
  registry: mods.registry,
  state: passState,
  backendDir: backend,
  context,
  jobs: [reflectionJob, learnJob({ store: new RecallStore(), state: passState, chats })],
  busy,
  // A pass runs on the agent's own model; with no provider for it (only Claude Code chats, say), passes wait.
  // An agent with no model of its own runs on pi's default, so then any reachable model will do.
  canRun: async (handle) => {
    const available = await models.getAvailable();
    const slash = handle.indexOf("/");
    if (slash <= 0) return available.length > 0;
    return available.some((m) => m.provider === handle.slice(0, slash) && m.id === handle.slice(slash + 1));
  },
  isSubagent: (id) => isSubagent(id, backend),
  capture: (event, properties) => analytics.capture("mod", event, properties),
  report,
});
// The first start after the passes came carries over reflection's and Learn's own settings and cursors, once every
// store has its chats loaded (before an import from Letta, whose chats then get cursors of their own).
const oldPassFiles = {
  reflectionSettings: join(args.dir, "state", "reflection.json"),
  reflectionRoot: join(args.dir, "reflection"),
  learnWorker: join(recallDir(), "worker.json"),
};
async function carryOverPasses(): Promise<void> {
  await chats.loaded();
  if (passState.started()) return;
  const list = chats
    .list()
    .flatMap((c) => (c.agentId ? [{ agentId: c.agentId, chatId: c.conversationId, entries: chats.answers(c.conversationId, c.agentId, 0).entries }] : []));
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
  pinsFile: process.env.LOKI_PINS_FILE,
  recallWorkerFile: oldPassFiles.learnWorker,
};
let importing: Promise<ImportReport> | null = null;
const importLetta = (): Promise<ImportReport> =>
  (importing ??= (async () => {
    await carryOverPasses();
    return recorded(
      importFromLetta({
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
      }),
    );
  })().finally(() => (importing = null)));
/** Each run's outcome is kept for Settings (daemon/import/letta.ts, recordAttempt), whichever way it went. */
async function recorded(run: Promise<ImportReport>): Promise<ImportReport> {
  try {
    const r = await run;
    recordAttempt(importPaths, true, describeReport(r) + (r.notes.length ? `; ${r.notes.join("; ")}` : ""));
    return r;
  } catch (error) {
    recordAttempt(importPaths, false, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
// Chats on ACP agents (plan 020): Claude Code built in, others added in state/acp.json.
const acpFile = join(args.dir, "state", "acp.json");
const acp = new AcpChats({
  stores,
  approvals,
  context,
  agents: () => readAcpAgents(acpFile),
  systemPrompt: (agentId) => agentPrompt(backend, agentId, readLocalAgent(agentId, backend)?.name ?? null),
  homeDir: homedir(),
  configFile: acpFile,
  cacheFile: join(args.dir, "state", "acp-offered.json"),
  // An ACP turn is not in pi-durable's runs, which TurnTelemetry follows, so the chats measure it themselves.
  capture: (event, properties) => analytics.capture("mod", event, properties),
});
const chat: DaemonChats = new DaemonChats({
  stores,
  mods,
  approvals,
  providers,
  passes: { runner: passes, state: passState },
  mcp,
  models,
  acp,
  labelsFile: join(paths.state, "labels.json"),
  backendDir: backend,
  context,
  report,
  importLetta,
  importStatus: () => importStatus(importPaths),
  macId: installId(),
  schedules,
});
chats.follow(stores);
// Product analytics, local only (core/analytics.ts; `npm run analytics` reads it), one writer for the daemon and loki's
// mod. LOKI_ANALYTICS=0 turns it off. Each agent turn is one turn_finished line, measured from its store (daemon/telemetry.ts).
const analytics = createAnalytics({
  path: process.env.LOKI_ANALYTICS === "0" ? null : paths.events,
  statePath: paths.analytics,
  appVersion: appVersion(paths.root),
});
mcp.setCapture((event, properties) => analytics.capture("mod", event, properties));
mcp.start();
const telemetry = new TurnTelemetry({
  capture: (event, properties) => analytics.capture("mod", event, properties),
  harnessVersion: harnessVersion(paths.root),
  isSubagent: (id) => isSubagent(id, backend),
  context,
  report,
});
telemetry.follow(stores);
// What every model call cost, by hour, agent, model and origin, for the usage page (daemon/usage.ts); not analytics,
// so LOKI_ANALYTICS=0 leaves it on.
const usage = new UsageLedger({
  file: join(paths.state, "usage.json"),
  context,
  inputRate: (model) => {
    const slash = model.indexOf("/");
    return slash > 0 ? (models.getModel(model.slice(0, slash), model.slice(slash + 1))?.cost.input ?? null) : null;
  },
  isSubagent: (id) => isSubagent(id, backend),
  eventsFiles: [`${paths.events}.1`, paths.events],
  report,
});
usage.follow(stores);
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
    report(`imported from Letta: ${describeReport(r)}${r.notes.length ? `; ${r.notes.join("; ")}` : ""}`);
  } catch (error) {
    report(
      `import from Letta not done, tried again at the next start or from Settings › loki › Import: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// loki's own mod (mod/index.ts), on the mod API with the chats as its host: read (`chats`) and run (`chat`).
const core = (await import(pathToFileURL(args.mod).href)) as { default: (api: ModApi, host: Host) => unknown };
const loadCore = (): Promise<LoadResult> =>
  mods.load({
    name: "loki",
    apiVersion: MOD_API_VERSION,
    activate: (api) =>
      core.default(api, {
        chats,
        chat,
        analytics,
        // This Mac as other Macs know it (plan 023): its install id, and the keychain for the tokens it presents to them.
        macId: installId(),
        secrets: secrets ?? memorySecrets(),
        // A restart due after a checkout's daemon code changed, and restarting when the person asks (plan 024).
        daemon: devReload,
        usage: {
          rows: () => usage.rows(),
          priced: (model) => {
            // An ACP agent prices its own calls, and reports dollars rather than rates (plan 020, R9).
            if (model.startsWith("acp:")) return true;
            const slash = model.indexOf("/");
            const cost = slash > 0 ? models.getModel(model.slice(0, slash), model.slice(slash + 1))?.cost : undefined;
            return !!cost && cost.input + cost.output > 0;
          },
          seeded: () => usage.seeded(),
          onChange: (listener) => usage.onChange(listener),
        },
      }),
  });
// A checkout keeps up with its sources (plan 024): the mod (mod/boot.ts bundles mod/index.ts and core afresh on every
// activate) reloads when mod/ or core/ changes, and a change to daemon/ or core/ makes a restart due, which the window
// offers; the restart itself is the person's (any loki can be asked for one).
const devReload: DevReload = new DevReload({
  reloadMod: async () => {
    const result = await loadCore();
    return "loaded" in result ? "ok" : result.refused;
  },
  // A moment later, so the window hears that the restart is under way before its socket closes.
  restart: (why) => void setTimeout(() => stop(`${why}, restarting as asked`), 200),
  idle: async () => {
    for (const c of chats.list()) if (c.agentId && (await busy(c.agentId, c.conversationId))) return false;
    return true;
  },
  report,
});
await loadCore();
const checkout = args.mod.endsWith("boot.ts") ? dirname(dirname(args.mod)) : null;
const sources = (f: string) => f.endsWith(".ts") && !f.includes(".loki-build");
const watching = checkout
  ? [
      watchFiles(join(checkout, "mod"), sources, (file) => devReload.modChanged(`mod/${file}`)),
      watchFiles(join(checkout, "core"), sources, (file) => {
        devReload.daemonChanged(`core/${file}`);
        return devReload.modChanged(`core/${file}`);
      }),
      watchFiles(join(checkout, "daemon"), sources, (file) => devReload.daemonChanged(`daemon/${file}`)),
    ]
  : [];
const stopWatchingCore = () => {
  for (const unwatch of watching) unwatch();
};
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
    usage.close();
    background.stopAll();
    void mcp.close();
    void acp.close();
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
