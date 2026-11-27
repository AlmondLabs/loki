import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { homedir } from "node:os";
import { Advisors } from "./advisor.ts";
import { AdvisorConsults } from "./advisor-consults.ts";
import { DaemonChats } from "./chat-backend.ts";
import { ChatImages } from "./chat-images.ts";
import { Approvals, kindOf } from "./approvals.ts";
import { randomUUID } from "node:crypto";
import { parseLinkAnswer } from "../core/chat-links.ts";
import { KeychainCredentials, keychain, memorySecrets } from "./credentials.ts";
import { deviceIdIn, Providers } from "./providers.ts";
import { BackgroundTasks } from "./background.ts";
import { SubagentManager } from "./subagents.ts";
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
import { MOD_API_VERSION } from "./mods/api.ts";
import { activateLoki } from "../mod/index.ts";
import { ModRegistry } from "./mods/registry.ts";
import { McpTools } from "./mcp/index.ts";
import { appVersion, paths } from "../mod/paths.ts";
import { LearnStore } from "../mod/learn.ts";
import { UsageLedger } from "./usage.ts";
import { readAcpAgents } from "./acp/agents.ts";
import { AcpChats } from "./acp/chats.ts";
import { LokiTools } from "./acp/loki-tools.ts";
import { openInBrowser } from "./acp/open-url.ts";
import { agentPrompt } from "./acp/prompt.ts";
import { reporter } from "./report.ts";
import { watchParent } from "./parent-watch.ts";
import { SCRIPT_TIMEOUT_MS, SCRIPT_TOOL, checkScripts, scriptExtensions, scriptSandbox } from "./scripts.ts";

export const EXIT_HELD = 3;

/**
 * The flag every start passes so the shell can tell loki's daemon from any other Node process: desktop/procs.ts
 * matches it, with the token file, on a leftover daemon's command line. The daemon never reads it.
 */
const DAEMON_MARKER = "loki-daemon";

const report = reporter({ pid: process.pid, write: (line) => console.error(line) });

const { values: args } = parseArgs({
  options: {
    [DAEMON_MARKER]: { type: "boolean" },
    dir: { type: "string" },
    "token-file": { type: "string" },
    "parent-pid": { type: "string" },
    "check-scripts": { type: "boolean" },
  },
});
if (args["check-scripts"]) {
  console.log(await checkScripts());
  process.exit(0);
}
if (!args.dir) {
  report("--dir is required");
  process.exit(2);
}

mkdirSync(args.dir, { recursive: true });
const taken = acquire(join(args.dir, "daemon.lock"));
if (!("release" in taken)) {
  report(`another daemon (pid ${taken.heldBy}) is serving ${args.dir}`);
  process.exit(EXIT_HELD);
}
const lock: Lock = taken;

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
// Outside (pi-ai): it loads each sign-in flow (ChatGPT, OpenRouter, GitHub Copilot…) through a variable path a bundler
// cannot follow, which in the release bundle pointed at files that are not there. Its Bun helper imports them
// statically, which suits Node and the bundle alike.
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
const subagents = new SubagentManager({
  notify: (agentId, chatId, text) =>
    void chat
      .deliver(agentId, chatId, text, "steer")
      .then((delivery) => delivery?.outcome)
      .catch((e: unknown) => report(`subagent notice not delivered: ${String(e)}`)),
  harnessFor: async (agentId) => (await stores.get(agentId)).harness,
  context,
  worktreesDir: join(args.dir, "worktrees"),
});
const schedules = new Schedules(schedulesFile, deliver, report);
const approvals = new Approvals({
  widgetsDir: process.env.LOKI_WIDGETS_DIR ?? join(args.dir, "widgets"),
  kindOfTool: (name) => builtinToolKinds.get(name) ?? kindOf(name, mcp.annotations(name) ?? mods.annotations(name)),
  alwaysPath: join(args.dir, "state", "approvals.json"),
  advisorFolders: { dataDir: args.dir, backendDir: backend, home: homedir() },
  scriptMayCall: (name) => mods.isScriptCallable(name),
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
  subagents,
  scripts: scriptExtensions(sandbox, undefined, (name) => mods.annotations(name)?.strangerText === true),
});
const builtinToolKinds = builtinKinds(builtins);
for (const extension of builtins) mods.registry.install(extension);
const installId = deviceIdIn(join(args.dir, "state", "device-id"));
const providers = new Providers(models, credentials ?? new KeychainCredentials(memorySecrets()), report, installId);
const passState = new PassState(join(args.dir, "state"));
const busy = (agentId: string, chatId: string): Promise<boolean> => chat.busy(agentId, chatId);
const passScratch = join(args.dir, "scratch");
const canRun = async (handle: string): Promise<boolean> => {
  const available = await models.getAvailable();
  const slash = handle.indexOf("/");
  if (slash <= 0) return available.length > 0;
  return available.some((m) => m.provider === handle.slice(0, slash) && m.id === handle.slice(slash + 1));
};
const passes = new PassRunner({
  stores,
  chats,
  registry: mods.registry,
  state: passState,
  backendDir: backend,
  context,
  jobs: [reflectionJob, learnJob({ store: new LearnStore(), state: passState, chats })],
  busy,
  canRun,
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
  report,
});
async function startPassCursors(): Promise<void> {
  await chats.loaded();
  if (passState.started()) return;
  const list = chats
    .list()
    .flatMap((c) => (c.agentId ? [{ agentId: c.agentId, chatId: c.conversationId, entries: chats.entryCount(c.conversationId, c.agentId) }] : []));
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
  report,
});
const advisors = new AdvisorConsults({
  advisors: new Advisors({ stores, registry: mods.registry, backendDir: backend, home: homedir(), context, canRun }),
  stores,
  agents: () => listAgents(backend),
  context,
  deliver: (agentId, chatId, advice) => chat.advise(agentId, chatId, advice),
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
  subagents,
  usualModel: (agentId) => topUsualModel(agentId),
  advisors,
});
chats.follow(stores, report);
const eventsLog = join(args.dir, "logs", "events.jsonl");
const usage = new UsageLedger({
  file: join(paths.state, "usage.json"),
  context,
  inputRate: (model) => {
    const slash = model.indexOf("/");
    return slash > 0 ? (models.getModel(model.slice(0, slash), model.slice(slash + 1))?.cost.input ?? null) : null;
  },
  eventsFiles: [`${eventsLog}.1`, eventsLog],
  report,
});
usage.follow(stores);
const agentsReady = Promise.all(
  listAgents(backend).map(async (id) => {
    const store = await stores.get(id);
    await store.setAgent({ id, name: readLocalAgent(id, backend)?.name ?? id }, context);
  }),
).then(() => chats.metadataLoaded());

const here = fileURLToPath(new URL(import.meta.url));
const checkout = here.endsWith(".ts") ? dirname(dirname(here)) : null;
const builtPage = checkout && process.env.LOKI_BUILT_PAGE === "1" ? checkout : null;
const devReload: DevReload = new DevReload({
  ...(builtPage ? { buildPage: () => buildPage(builtPage) } : {}),
  restart: (why) => stop(`${why}, restarting as asked`),
  idle: async () => {
    for (const c of chats.list()) if (c.agentId && (await busy(c.agentId, c.conversationId))) return false;
    return true;
  },
  report,
});
await agentsReady;
await mods.load({
  name: "loki",
  apiVersion: MOD_API_VERSION,
  activate: (api) =>
    activateLoki(api, {
      chats,
      chat,
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
          // Outside (ACP): an agent prices its own calls, and reports dollars rather than rates.
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
mcp.start();
void lokiTools.start().catch((error: unknown) => report(`loki tools did not start: ${String(error)}`));
void advisors.start().catch((error: unknown) => report(`advisor consults did not settle: ${String(error)}`));
const sources = (f: string) => f.endsWith(".ts") && !f.includes(".loki-build");
const watching = checkout
  ? [
      watchFiles(join(checkout, "mod"), sources, (file) => devReload.daemonChanged(`mod/${file}`)),
      watchFiles(join(checkout, "core"), sources, (file) => {
        devReload.daemonChanged(`core/${file}`);
        devReload.pageChanged(`core/${file}`);
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
report(`serving ${args.dir} with mods ${mods.names().join(", ")}`, "info");

let stopping = false;
function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  report(`${signal}, stopping`, "info");
  try {
    stopWatchingCore();
    stopWatchingMods();
    schedules.stop();
    passes.stop();
    usage.close();
    background.stopAll();
    void subagents.stopAll();
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
process.on("message", (message) => {
  if (message === "stop") stop("asked to stop");
});
process.on("disconnect", () => stop("loki is gone"));
const parentPid = Number(args["parent-pid"]);
if (Number.isInteger(parentPid) && parentPid > 0) watchParent({ pid: parentPid, gone: () => stop("loki is gone") });
for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
process.on("exit", () => {
  background.killAll();
  lock.release();
});
