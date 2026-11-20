import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { homedir } from "node:os";
import { DaemonChats } from "./chat-backend.ts";
import { ChatImages } from "./chat-images.ts";
import { Approvals, kindOf } from "./approvals.ts";
import { randomUUID } from "node:crypto";
import { parseLinkAnswer } from "../core/chat-links.ts";
import { KeychainCredentials, keychain, memorySecrets } from "./credentials.ts";
import { deviceIdIn, Providers } from "./providers.ts";
import { BackgroundTasks } from "./background.ts";
import { Schedules, scheduleTools } from "./schedule.ts";
import { memoryRepos } from "./memory-sync.ts";
import { memoryRoot, memoryTools } from "./memory.ts";
import { historyTools } from "./history-tools.ts";
import { askTool } from "./ask.ts";
import { builtinExtensions, builtinKinds } from "./extensions.ts";
import { chatEnvs } from "./tool-results.ts";
import { reflectionJob } from "./reflection.ts";
import { learnJob } from "./learn.ts";
import { PassRunner } from "./passes.ts";
import { PassState } from "./passes-state.ts";
import { readLocalAgent } from "../mod/agents.ts";
import { topUsualModel } from "../mod/usual-models.ts";
import { ChatProjection } from "./chats.ts";
import { StoreManager } from "./kernel/stores.ts";
import { listAgents } from "./store/agents.ts";
import { acquire, type Lock } from "./lock.ts";
import { loadModFolder, watchFiles } from "./mods/files.ts";
import { DevReload } from "./dev-reload.ts";
import { buildPage, isPageSource } from "./page-build.ts";
import { MOD_API_VERSION, type ModApi } from "./mods/api.ts";
import type { Host } from "../mod/index.ts";
import { ModRegistry, type LoadResult } from "./mods/registry.ts";
import { appVersion, createAnalytics } from "../mod/analytics.ts";
import { McpTools } from "./mcp/index.ts";
import { paths } from "../mod/paths.ts";
import { RecallStore } from "../mod/recall.ts";
import { TurnTelemetry, harnessVersion } from "./telemetry.ts";
import { UsageLedger } from "./usage.ts";
import { readAcpAgents } from "./acp/agents.ts";
import { AcpChats } from "./acp/chats.ts";
import { LokiTools } from "./acp/loki-tools.ts";
import { openInBrowser } from "./acp/open-url.ts";
import { agentPrompt } from "./acp/prompt.ts";
import { SCRIPT_TIMEOUT_MS, SCRIPT_TOOL, checkScripts, scriptExtensions, scriptMayCall, scriptSandbox } from "./scripts.ts";

export const EXIT_HELD = 3;

/**
 * The flag every start passes so the shell can tell loki's daemon from any other Node process: `is_own_daemon` in
 * `src-tauri/src/procs.rs` matches it, with the token file, on a leftover daemon's command line. The daemon never reads it.
 */
const DAEMON_MARKER = "loki-daemon";

const { values: args } = parseArgs({
  options: {
    [DAEMON_MARKER]: { type: "boolean" },
    dir: { type: "string" },
    mod: { type: "string" },
    "token-file": { type: "string" },
    "check-scripts": { type: "boolean" },
  },
});
if (args["check-scripts"]) {
  console.log(await checkScripts());
  process.exit(0);
}
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

const backend = join(args.dir, "backend");
process.env.LOKI_BACKEND_DIR = backend;
process.env.LOKI_PINS_FILE ??= join(args.dir, "state", "pins.json");
const secrets =
  process.env.LOKI_KEYCHAIN === "0"
    ? memorySecrets()
    : await keychain().catch((error: unknown) => (report(`keychain unavailable, keys come from the environment only: ${String(error)}`), undefined));
const credentials = secrets ? new KeychainCredentials(secrets) : undefined;
// The sign-in flows (ChatGPT, OpenRouter, GitHub Copilot…), imported statically. pi-ai loads each through a variable
registerBunOAuthFlows();
const models = builtinModels(credentials ? { credentials } : {});
const stores = new StoreManager(join(args.dir, "stores"), { models, registry: mods.registry, env: chatEnvs(args.dir) }, context, report);
const mcp = new McpTools({
  registry: mods.registry,
  configPath: join(args.dir, "mcp.json"),
  lokiDir: args.dir,
  report,
  version: appVersion(paths.root) ?? undefined,
  ...(secrets ? { secrets } : {}),
});
const schedulesFile = join(args.dir, "state", "crons.json");
const deliver = (agentId: string, chatId: string, text: string) => chat.deliver(agentId, chatId, text);
const background = new BackgroundTasks(
  (agentId, chatId, text) =>
    void chat
      .deliver(agentId, chatId, text, "steer")
      .then((delivery) => delivery?.outcome)
      .catch((e: unknown) => report(`task notice not delivered: ${String(e)}`)),
);
const schedules = new Schedules(schedulesFile, deliver, report);
const approvals = new Approvals({
  widgetsDir: process.env.LOKI_WIDGETS_DIR ?? join(args.dir, "widgets"),
  kindOfTool: (name) => builtinToolKinds.get(name) ?? kindOf(name, mcp.annotations(name) ?? mods.annotations(name)),
  alwaysPath: join(args.dir, "state", "approvals.json"),
  scriptMayCall: (name) =>
    mods.registry
      .snapshot()
      .tools()
      .some(({ tool }) => tool.name === name && scriptMayCall(tool)),
});
const chatImages = new ChatImages(join(args.dir, "chat-images"));
const nameImage = (image: { data: string; mimeType: string }) => chatImages.name(image);
const chats = new ChatProjection(context, (id) => readLocalAgent(id, backend)?.name ?? null, nameImage);
const sandbox = scriptSandbox({}, (running) => report(`a script was refused: ${running} scripts were already running, the most at once (plan 099, R8)`));
const builtins = builtinExtensions({
  approvals,
  backendDir: backend,
  background,
  schedules,
  history: chats,
  scripts: scriptExtensions(sandbox, undefined, (name) => mods.annotations(name)?.strangerText === true),
});
const builtinToolKinds = builtinKinds(builtins);
for (const extension of builtins) mods.registry.install(extension);
const installId = deviceIdIn(join(args.dir, "state", "device-id"));
const providers = new Providers(models, credentials ?? new KeychainCredentials(memorySecrets()), report, installId);
const passState = new PassState(join(args.dir, "state"));
const busy = (agentId: string, chatId: string): Promise<boolean> => chat.busy(agentId, chatId);
const passScratch = join(args.dir, "scratch");
const passes = new PassRunner({
  stores,
  chats,
  registry: mods.registry,
  state: passState,
  backendDir: backend,
  context,
  jobs: [reflectionJob, learnJob({ store: new RecallStore(), state: passState, chats })],
  busy,
  canRun: async (handle) => {
    const available = await models.getAvailable();
    const slash = handle.indexOf("/");
    if (slash <= 0) return available.length > 0;
    return available.some((m) => m.provider === handle.slice(0, slash) && m.id === handle.slice(slash + 1));
  },
  acp: {
    engineFor: async (agentId) => {
      const infos = await (await stores.get(agentId)).chats(context);
      const newest = infos
        .filter((i) => !i.hidden && i.engine?.kind === "acp" && acp.agent(i.engine.agent))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .at(0);
      return newest?.engine ?? null;
    },
    ask: async (agentId, engine, spec) => {
      const root = memoryRoot(backend, agentId);
      const cwd = existsSync(root) ? root : passScratch;
      mkdirSync(cwd, { recursive: true });
      lokiTools.takeCalls(agentId, spec.chatId);
      const text = await acp.runPass({ ...spec, agentId, engine, cwd });
      return { text, toolCalls: lokiTools.takeCalls(agentId, spec.chatId) };
    },
  },
  capture: (event, properties) => analytics.capture("mod", event, properties),
  report,
});
async function startPassCursors(): Promise<void> {
  await chats.loaded();
  if (passState.started()) return;
  const list = chats
    .list()
    .flatMap((c) => (c.agentId ? [{ agentId: c.agentId, chatId: c.conversationId, entries: chats.answers(c.conversationId, c.agentId, 0).entries }] : []));
  passState.startCursors(list);
}
const lokiTools = new LokiTools({
  tools: () => [...memoryTools(backend), ...historyTools(chats), ...scheduleTools(schedules), askTool(approvals), ...mods.chatTools()],
  stores,
  context,
  version: appVersion(paths.root) ?? "0",
  scripts: {
    sandbox,
    timeoutMs: SCRIPT_TIMEOUT_MS,
    strangerText: (name) => mods.annotations(name)?.strangerText === true,
    ask: (agentId, conversationId, input, signal) =>
      approvals.ask<{ allow: boolean; message?: string }>(
        agentId,
        conversationId,
        { kind: "approval", request_id: `approval-script-${randomUUID()}`, tool_name: SCRIPT_TOOL, input },
        signal,
        { remember: false },
      ),
  },
});
await lokiTools.start();
const acpFile = join(args.dir, "state", "acp.json");
const acp = new AcpChats({
  stores,
  approvals,
  context,
  agents: () => readAcpAgents(acpFile),
  systemPrompt: (agentId, withTools) => agentPrompt(backend, agentId, readLocalAgent(agentId, backend)?.name ?? null, withTools),
  homeDir: homedir(),
  mods,
  mcpServers: async (agentId, conversationId) => {
    const own = lokiTools.serverFor(agentId, conversationId);
    return [...(own ? [own] : []), ...(await mcp.acpServers(agentId))];
  },
  allowedTools: (agentId) => [...lokiTools.readOnly(), ...mcp.acpReadOnly(agentId)],
  passServer: (agentId, conversationId, tools) => lokiTools.serverFor(agentId, conversationId, tools),
  openUrl: (url) => openInBrowser(url, report),
  configFile: acpFile,
  cacheFile: join(args.dir, "state", "acp-offered.json"),
  capture: (event, properties) => analytics.capture("mod", event, properties),
  report,
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
  nameImage,
  backendDir: backend,
  context,
  report,
  macId: installId(),
  schedules,
  background,
  usualModel: (agentId) => topUsualModel(agentId),
});
chats.follow(stores, report);
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
  context,
  report,
});
telemetry.follow(stores);
const usage = new UsageLedger({
  file: join(paths.state, "usage.json"),
  context,
  inputRate: (model) => {
    const slash = model.indexOf("/");
    return slash > 0 ? (models.getModel(model.slice(0, slash), model.slice(slash + 1))?.cost.input ?? null) : null;
  },
  eventsFiles: [`${paths.events}.1`, paths.events],
  report,
});
usage.follow(stores);
await Promise.all(
  listAgents(backend).map(async (id) => {
    const store = await stores.get(id);
    await store.setAgent({ id, name: readLocalAgent(id, backend)?.name ?? id }, context);
  }),
);

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
        macId: installId(),
        secrets: secrets ?? memorySecrets(),
        memory: memoryRepos,
        suggestions: {
          read: async (agentId, id) => {
            const store = await stores.get(agentId);
            const conversation = await store.chat(id, context);
            const info = conversation ? await store.chatInfo(conversation.id, context) : undefined;
            return info ? { suggestions: info.suggestions ?? [], archived: info.archived } : null;
          },
          write: async (agentId, id, suggestions) => {
            if (!(await (await stores.get(agentId)).updateChat(id, { suggestions }, context))) throw new Error(`no chat ${id}`);
          },
        },
        askLink: async (agentId, conversationId, link, signal) => {
          const reply = await approvals.ask<{ answers: Record<string, unknown> }>(
            agentId,
            conversationId,
            { kind: "question", request_id: `link-${randomUUID()}`, input: { link } },
            signal,
          );
          return parseLinkAnswer(reply.answers.answers);
        },
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
const checkout = args.mod.endsWith("boot.ts") ? dirname(dirname(args.mod)) : null;
const builtPage = checkout && process.env.LOKI_BUILT_PAGE === "1" ? checkout : null;
const devReload: DevReload = new DevReload({
  reloadMod: async () => {
    const result = await loadCore();
    return "loaded" in result ? "ok" : result.refused;
  },
  ...(builtPage ? { buildPage: () => buildPage(builtPage) } : {}),
  restart: (why) => stop(`${why}, restarting as asked`),
  idle: async () => {
    for (const c of chats.list()) if (c.agentId && (await busy(c.agentId, c.conversationId))) return false;
    return true;
  },
  report,
});
await loadCore();
const sources = (f: string) => f.endsWith(".ts") && !f.includes(".loki-build");
const watching = checkout
  ? [
      watchFiles(join(checkout, "mod"), sources, (file) => devReload.modChanged(`mod/${file}`)),
      watchFiles(join(checkout, "core"), sources, (file) => {
        devReload.daemonChanged(`core/${file}`);
        devReload.pageChanged(`core/${file}`);
        return devReload.modChanged(`core/${file}`);
      }),
      watchFiles(join(checkout, "daemon"), sources, (file) => devReload.daemonChanged(`daemon/${file}`)),
      ...(builtPage ? [watchFiles(join(checkout, "app"), isPageSource, (file) => devReload.pageChanged(`app/${file}`))] : []),
    ]
  : [];
const stopWatchingCore = () => {
  for (const unwatch of watching) unwatch();
};
const stopWatchingMods = await loadModFolder(mods, join(args.dir, "mods"), report);
schedules.start();
void startPassCursors()
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
    void lokiTools.stop();
    for (const name of mods.names()) mods.unload(name);
  } finally {
    void sandbox
      .close()
      .catch((error: unknown) => report(`the script sandbox did not close: ${String(error)}`))
      .then(() => stores.closeAll())
      .finally(() => {
        lock.release();
        process.exit(0);
      });
  }
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
process.on("exit", () => {
  background.killAll();
  lock.release();
});
