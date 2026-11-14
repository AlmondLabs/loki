import type { Context, JsonValue } from "@earendil-works/chord";
import {
  configure,
  createRegistry,
  defineExtension,
  GenerationTask,
  hook,
  section,
  ToolTask,
  type Conversation,
  type ConversationId,
  type DocumentReader,
  type Extension,
  type HookRegistration,
  type Registry,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { kindOf } from "../approvals.ts";
import { piTool, type ChatTool } from "../chat-tools.ts";
import { SCRIPT_TOOL } from "../scripts.ts";
import { AgentInfoDoc, ChatDoc, type AgentStore } from "../kernel/index.ts";
import {
  MOD_API_VERSION,
  type BeforeToolResult,
  type ChatRef,
  type LokiMod,
  type ModApi,
  type ModEvents,
  type ModTool,
  type OutgoingMessage,
  type SectionInput,
  type ToolCall,
} from "./api.ts";
import { messageOf } from "../../core/errors.ts";

/**
 * Mods in the daemon (plan 017, U4). Each mod is activated once against a ModApi and becomes one pi-durable extension
 * named after it; the one pi-durable registry is shared by every agent's store, so one install reaches every chat.
 * Loading a mod under a name already loaded replaces it in place: the old activation is aborted and undone first (a mod
 * that holds a port lets go of it before its new copy binds), and pi-durable lets work already under way finish on the
 * old code (KTD15). A new copy that then fails to load leaves the mod unloaded, and says so.
 */

interface Pieces {
  tools: ModTool[];
  sections: Array<{ key: string; render: (input: SectionInput) => string | undefined | Promise<string | undefined> }>;
  transforms: Array<(message: OutgoingMessage) => OutgoingMessage["content"] | undefined>;
  beforeTools: Array<(call: ToolCall) => BeforeToolResult | Promise<BeforeToolResult>>;
  listeners: Map<keyof ModEvents, Set<(event: never) => void>>;
}

interface Loaded {
  mod: LokiMod;
  pieces: Pieces;
  abort: AbortController;
  dispose?: () => void;
}

/** How a load went: loaded, or refused with the line also reported (a mod API too new, or an `activate` that threw). */
export type LoadResult = { loaded: true } | { refused: string };

const NO_SIGNAL = new AbortController().signal;

/** loki's ids for a pi-durable conversation, from the documents its store keeps (daemon/kernel). */
async function chatRef(read: DocumentReader, conversationId: ConversationId, context: Context): Promise<ChatRef> {
  const [chat, agent] = await Promise.all([read.snapshot(ChatDoc, conversationId, context), read.snapshot(AgentInfoDoc, context)]);
  return { chatId: chat?.id || `conversation-${conversationId}`, agentId: agent?.id ?? "", agentName: agent?.name ?? "" };
}

/** A tool's return value as the model reads it. */
function resultText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/**
 * A mod's tool as one of loki's chat tools: it hears the chat's ids, the abort signal and an output stream, and its
 * `forAgent`, when it has one, as `forAgent` (a predicate that throws hides the tool, said through `report`).
 */
function modChatTool(tool: ModTool, report: (message: string) => void): ChatTool {
  const forAgent = tool.forAgent;
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    kind: kindOf(tool.name, tool.annotations),
    ...(forAgent ? { forAgent: (agentId: string) => listedFor(tool.name, forAgent, agentId, report) } : {}),
    ...(tool.callers ? { callers: tool.callers } : {}),
    ...(tool.replay ? { replay: tool.replay } : {}),
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    run: async (args, call, context) => {
      const ref = await chatRef(call.read, call.conversationId, context);
      const value = await tool.execute(args, { ...ref, signal: call.signal, output: call.output, ...(call.cwd === undefined ? {} : { cwd: call.cwd }) });
      const text = resultText(value);
      if (text === undefined) return {};
      // A typed tool's value goes to scripts as JSON: the text round-trips it, so what a script gets is what the model would read.
      return { output: [{ type: "text", text }], ...(tool.outputSchema ? { structuredOutput: JSON.parse(text) as JsonValue } : {}) };
    },
  };
}

/** Whether a tool's `forAgent` offers it to `agentId`; one that throws (a mod is the person's own code) does not. */
function listedFor(name: string, forAgent: (agentId: string) => boolean, agentId: string, report: (message: string) => void): boolean {
  try {
    return forAgent(agentId);
  } catch (error) {
    report(`tool ${name}: forAgent failed, so it is hidden: ${messageOf(error)}`);
    return false;
  }
}

/** The same names, in any order. */
const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && new Set([...a, ...b]).size === new Set(a).size;

/** The daemon's mods, by name, each as one pi-durable extension in the shared `registry`. */
export class ModRegistry {
  /** The pi-durable registry every agent's store is opened with. */
  readonly registry: Registry = createRegistry();
  private readonly loaded = new Map<string, Loaded>();
  /** Each mod's load in progress: a load of the same name waits for it (see `load`). */
  private readonly loading = new Map<string, Promise<unknown>>();
  private readonly report: (message: string) => void;

  constructor(report: (message: string) => void = (m) => console.error(`loki-daemon: ${m}`)) {
    this.report = report;
  }

  /**
   * Activate a mod and install it; a mod of the same name is replaced. A refused mod changes nothing; one whose
   * `activate` throws is not loaded, and the copy it was replacing is unloaded too. Loads of one name run one after
   * another: two at once (a checkout's files saved together) would each retire what was loaded before, and the first
   * to finish would be replaced without being disposed, holding its server's port while the second fails to bind.
   */
  load(mod: LokiMod): Promise<LoadResult> {
    const before = this.loading.get(mod.name) ?? Promise.resolve();
    const next = before.then(
      () => this.loadNow(mod),
      () => this.loadNow(mod),
    );
    this.loading.set(mod.name, next);
    void next.finally(() => {
      if (this.loading.get(mod.name) === next) this.loading.delete(mod.name);
    });
    return next;
  }

  private async loadNow(mod: LokiMod): Promise<LoadResult> {
    if (!Number.isInteger(mod.apiVersion) || mod.apiVersion < 1 || mod.apiVersion > MOD_API_VERSION) {
      const refused = `mod ${mod.name} needs mod API ${mod.apiVersion}; this loki has ${MOD_API_VERSION}`;
      this.report(refused);
      return { refused };
    }
    const pieces: Pieces = { tools: [], sections: [], transforms: [], beforeTools: [], listeners: new Map() };
    const abort = new AbortController();
    const reinstall = () => {
      if (this.loaded.get(mod.name)?.pieces === pieces) this.install(mod.name);
    };
    const add = <T>(list: T[], item: T) => {
      list.push(item);
      reinstall();
      return () => {
        const at = list.indexOf(item);
        if (at >= 0) list.splice(at, 1);
        reinstall();
      };
    };
    const api: ModApi = {
      apiVersion: MOD_API_VERSION,
      tools: { register: (tool) => add(pieces.tools, tool) },
      prompt: { section: (key, render) => add(pieces.sections, { key, render }) },
      message: { transform: (handler) => add(pieces.transforms, handler) },
      beforeTool: (handler) => add(pieces.beforeTools, handler),
      events: {
        on: (name, handler) => {
          const set = pieces.listeners.get(name) ?? new Set();
          pieces.listeners.set(name, set);
          set.add(handler);
          reinstall();
          return () => {
            set.delete(handler);
            reinstall();
          };
        },
      },
      diagnostics: { report: (d) => this.report(`${mod.name}: ${d.severity}: ${d.message}`) },
      signal: abort.signal,
    };
    const replacing = this.loaded.has(mod.name);
    this.retire(mod.name);
    let dispose: unknown;
    try {
      dispose = await mod.activate(api);
    } catch (error) {
      abort.abort();
      if (replacing) this.unload(mod.name);
      const refused = `mod ${mod.name} failed to load: ${messageOf(error)}`;
      this.report(refused);
      return { refused };
    }
    this.loaded.set(mod.name, { mod, pieces, abort, ...(typeof dispose === "function" ? { dispose: dispose as () => void } : {}) });
    this.install(mod.name);
    return { loaded: true };
  }

  /** Undo a mod and take its extension out of every chat. */
  unload(name: string): void {
    const extension = this.registry.snapshot().extension(name);
    this.retire(name);
    if (extension) this.registry.uninstall(extension);
  }

  /** Every loaded mod's tools, for a chat on an ACP agent (plan 044); each runs as it does on loki's own engine. */
  chatTools(): ChatTool[] {
    return [...this.loaded.values()].flatMap((entry) => entry.pieces.tools.map((tool) => modChatTool(tool, (m) => this.report(`${entry.mod.name}: ${m}`))));
  }

  /**
   * Set a chat's tool filter before it runs on loki's engine (plan 067, KTD10): the mod tools whose `forAgent` says no
   * for the chat's agent are hidden, the rest shown, and the names others hid (MCP's, daemon/mcp/) are kept. Asked
   * before each turn, so the list follows what `forAgent` answers now. The script tool is every chat's (plan 099): loki's
   * own history, schedule, canvas and chat tools are scripts' only, so every agent has something to call. A chat that
   * hid it before plan 099 shows it again, since its name is among loki's own here. A chat that names its tools outright
   * (a background pass's) is left alone. Writes only when something changed.
   */
  async prepare(store: AgentStore, chat: Conversation, context: Context): Promise<void> {
    const settings = (await store.agentSettings(chat.id, context)) as { tools?: string[] | { remove: string[] } } | undefined;
    if (Array.isArray(settings?.tools)) return;
    const agentId = (await store.harness.snapshot(AgentInfoDoc, context))?.id ?? "";
    const tools = this.chatTools();
    const ours = new Set([...tools.map((t) => t.name), SCRIPT_TOOL]);
    const removed = settings?.tools?.remove ?? [];
    const shown = tools.filter((t) => !t.forAgent || t.forAgent(agentId));
    const hide = tools.filter((t) => !shown.includes(t)).map((t) => t.name);
    const next = [...removed.filter((n) => !ours.has(n)), ...hide];
    if (sameSet(next, removed)) return;
    const registered = new Map(
      this.registry
        .snapshot()
        .tools()
        .map(({ tool }) => [tool.name, tool]),
    );
    await chat.commit(async (tx) => {
      await configure(tx, chat.id, { tools: { remove: next.map((n) => registered.get(n) ?? ({ name: n } as ToolRegistration)) } });
    }, context);
  }

  /** What a mod says a tool of its does (daemon/approvals.ts), when one of the loaded mods has it. */
  annotations(toolName: string): ModTool["annotations"] | undefined {
    for (const { pieces } of this.loaded.values()) {
      const tool = pieces.tools.find((t) => t.name === toolName);
      if (tool) return tool.annotations;
    }
    return undefined;
  }

  /** The names of the loaded mods, in load order. */
  names(): string[] {
    return [...this.loaded.keys()];
  }

  /**
   * Every loaded mod's prompt sections for one chat, in load order, each tagged `<key>…</key>` as pi-durable shows them
   * on loki's engine; a section that says nothing is left out, and one that throws is reported and left out. For a chat
   * on an ACP agent (plan 067), whose system prompt loki writes itself rather than through pi-durable.
   */
  async renderSections(input: SectionInput): Promise<string[]> {
    const shown: string[] = [];
    for (const { pieces, mod } of this.loaded.values()) {
      for (const { key, render } of pieces.sections) {
        try {
          const text = await render(input);
          if (text !== undefined) shown.push(`<${key}>\n${text}\n</${key}>`);
        } catch (error) {
          this.report(`${mod.name}: section ${key} failed: ${messageOf(error)}`);
        }
      }
    }
    return shown;
  }

  /** The person's message after every mod's transform, in load order (U5 calls this before sending). */
  transformMessage(message: OutgoingMessage): OutgoingMessage["content"] {
    let content = message.content;
    for (const { pieces, mod } of this.loaded.values()) {
      for (const transform of pieces.transforms) {
        try {
          content = transform({ ...message, content }) ?? content;
        } catch (error) {
          this.report(`${mod.name}: message transform failed: ${String(error)}`);
        }
      }
    }
    return content;
  }

  /** Tell every mod listening for `name`. A listener that throws is reported and the rest still hear it. */
  emit<K extends keyof ModEvents>(name: K, event: ModEvents[K]): void {
    for (const { pieces, mod } of this.loaded.values()) this.notify(mod.name, pieces, name, event);
  }

  private notify<K extends keyof ModEvents>(modName: string, pieces: Pieces, name: K, event: ModEvents[K]): void {
    for (const listener of (pieces.listeners.get(name) ?? []) as Set<(e: ModEvents[K]) => void>) {
      try {
        listener(event);
      } catch (error) {
        this.report(`${modName}: ${name} listener failed: ${String(error)}`);
      }
    }
  }

  private retire(name: string): void {
    const previous = this.loaded.get(name);
    if (!previous) return;
    this.loaded.delete(name);
    previous.abort.abort();
    try {
      previous.dispose?.();
    } catch (error) {
      this.report(`${name}: dispose failed: ${String(error)}`);
    }
  }

  private install(name: string): void {
    const entry = this.loaded.get(name);
    if (entry) this.registry.install(this.extension(name, entry.pieces));
  }

  /** One mod's pieces as a pi-durable extension. */
  private extension(name: string, pieces: Pieces): Extension {
    const notify = <K extends keyof ModEvents>(event: K, payload: ModEvents[K]) => this.notify(name, pieces, event, payload);
    const tools = pieces.tools.map((tool) => piTool(modChatTool(tool, (m) => this.report(`${name}: ${m}`))));
    const sections = pieces.sections.map(({ key, render }) =>
      section(key, async (input, context) => render({ ...(await chatRef(input.read, input.conversationId, context)), cwd: input.agent.cwd })),
    );
    const hooks: HookRegistration[] = [];
    const watchesTools = Boolean(pieces.listeners.get("tool_start")?.size) || Boolean(pieces.listeners.get("tool_end")?.size);
    if (pieces.beforeTools.length || watchesTools) {
      hooks.push(
        hook(ToolTask, {
          beforeTool: async (call, api, context) => {
            const ref = await chatRef(api, api.conversationId, context);
            let args = call.arguments as Record<string, unknown>;
            let changed = false;
            for (const handler of pieces.beforeTools) {
              const result = await handler({ ...ref, name: call.name, args, signal: context.abortSignal ?? NO_SIGNAL });
              if (result && "block" in result) return { block: result.block };
              if (result && "args" in result) {
                args = result.args;
                changed = true;
              }
            }
            notify("tool_start", { ...ref, name: call.name, args });
            return changed ? { arguments: args as never } : undefined;
          },
          afterTool: async (call, result, api, context) => {
            if (watchesTools) notify("tool_end", { ...(await chatRef(api, api.conversationId, context)), name: call.name, failed: result.isError === true });
            return undefined;
          },
        }),
      );
    }
    if (pieces.listeners.get("turn_end")?.size) {
      hooks.push(
        hook(GenerationTask, {
          onYield: async (_answer, api, context) => {
            notify("turn_end", await chatRef(api, api.conversationId, context));
            return undefined;
          },
        }),
      );
    }
    return defineExtension({ name, tools, sections, hooks });
  }
}
