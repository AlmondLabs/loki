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
import { keyedQueue } from "../../core/serial.ts";
import type { Report } from "../report.ts";

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

export type LoadResult = { loaded: true } | { refused: string };

const NO_SIGNAL = new AbortController().signal;

async function chatRef(read: DocumentReader, conversationId: ConversationId, context: Context): Promise<ChatRef> {
  const [chat, agent] = await Promise.all([read.snapshot(ChatDoc, conversationId, context), read.snapshot(AgentInfoDoc, context)]);
  return { chatId: chat?.id || `conversation-${conversationId}`, agentId: agent?.id ?? "", agentName: agent?.name ?? "" };
}

function resultText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

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
      return { output: [{ type: "text", text }], ...(tool.outputSchema ? { structuredOutput: JSON.parse(text) as JsonValue } : {}) };
    },
  };
}

function listedFor(name: string, forAgent: (agentId: string) => boolean, agentId: string, report: (message: string) => void): boolean {
  try {
    return forAgent(agentId);
  } catch (error) {
    report(`tool ${name}: forAgent failed, so it is hidden: ${messageOf(error)}`);
    return false;
  }
}

function keepingDescription(replacement: Record<string, unknown>, original: Record<string, unknown>): Record<string, unknown> {
  return replacement.description === undefined && typeof original.description === "string"
    ? { ...replacement, description: original.description }
    : replacement;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && new Set([...a, ...b]).size === new Set(a).size;

export class ModRegistry {
  readonly registry: Registry = createRegistry();
  private readonly loaded = new Map<string, Loaded>();
  private readonly loading = keyedQueue();
  private readonly report: Report;

  constructor(report: Report) {
    this.report = report;
  }

  load(mod: LokiMod): Promise<LoadResult> {
    return this.loading(mod.name, () => this.loadNow(mod));
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
      diagnostics: { report: (d) => this.report(`${mod.name}: ${d.message}`, d.severity) },
      signal: abort.signal,
    };
    const previous = this.loaded.get(mod.name);
    this.retire(mod.name);
    let dispose: unknown;
    try {
      dispose = await mod.activate(api);
    } catch (error) {
      abort.abort();
      const refused = `mod ${mod.name} failed to load: ${messageOf(error)}`;
      this.report(refused);
      if (previous) await this.putBack(previous.mod);
      return { refused };
    }
    this.loaded.set(mod.name, { mod, pieces, abort, ...(typeof dispose === "function" ? { dispose: dispose as () => void } : {}) });
    this.install(mod.name);
    return { loaded: true };
  }

  private async putBack(mod: LokiMod): Promise<void> {
    if ("loaded" in (await this.loadNow(mod))) this.report(`mod ${mod.name}: the one that was running is back`, "info");
    else this.unload(mod.name);
  }

  unload(name: string): void {
    const extension = this.registry.snapshot().extension(name);
    this.retire(name);
    if (extension) this.registry.uninstall(extension);
  }

  chatTools(): ChatTool[] {
    return [...this.loaded.values()].flatMap((entry) => entry.pieces.tools.map((tool) => modChatTool(tool, (m) => this.report(`${entry.mod.name}: ${m}`))));
  }

  async prepare(store: AgentStore, chat: Conversation, context: Context): Promise<void> {
    // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- tsgolint 7.0.2005 calls this a no-op, but tsc needs it: agentSettings returns object, which has no fields to read.
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

  annotations(toolName: string): ModTool["annotations"] | undefined {
    for (const { pieces } of this.loaded.values()) {
      const tool = pieces.tools.find((t) => t.name === toolName);
      if (tool) return tool.annotations;
    }
    return undefined;
  }

  names(): string[] {
    return [...this.loaded.keys()];
  }

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
            const original = call.arguments as Record<string, unknown>;
            let args = original;
            let changed = false;
            for (const handler of pieces.beforeTools) {
              const result = await handler({ ...ref, name: call.name, args, signal: context.abortSignal ?? NO_SIGNAL });
              if (result && "block" in result) return { block: result.block };
              if (result && "args" in result) {
                args = keepingDescription(result.args, original);
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
