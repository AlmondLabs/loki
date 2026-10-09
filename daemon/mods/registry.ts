import type { Context } from "@earendil-works/chord";
import {
  createRegistry,
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  section,
  ToolTask,
  type ConversationId,
  type DocumentReader,
  type Extension,
  type HookRegistration,
  type Registry,
} from "@earendil-works/pi-durable";
import { AgentInfoDoc, ChatDoc } from "../kernel/index.ts";
import { MOD_API_VERSION, type BeforeToolResult, type ChatRef, type LokiMod, type ModApi, type ModEvents, type ModTool, type OutgoingMessage, type SectionInput, type ToolCall } from "./api.ts";

/**
 * Mods in the daemon (plan 017, U4). Each mod is activated once against a ModApi and becomes one pi-durable extension
 * named after it; the one pi-durable registry is shared by every agent's store, so one install reaches every chat.
 * Loading a mod under a name already loaded replaces it in place: the old activation is aborted and undone first (a mod
 * that holds a port lets go of it before its new copy binds), and pi-durable lets work already under way finish on the
 * old code (KTD15). A new copy that then fails to load leaves the mod unloaded, and says so.
 */

type Pieces = {
  tools: ModTool[];
  sections: Array<{ key: string; render: (input: SectionInput) => string | undefined | Promise<string | undefined> }>;
  transforms: Array<(message: OutgoingMessage) => OutgoingMessage["content"] | undefined>;
  beforeTools: Array<(call: ToolCall) => BeforeToolResult | Promise<BeforeToolResult>>;
  listeners: Map<keyof ModEvents, Set<(event: never) => void>>;
};

type Loaded = { mod: LokiMod; pieces: Pieces; abort: AbortController; dispose?: () => void };

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

export class ModRegistry {
  /** The pi-durable registry every agent's store is opened with. */
  readonly registry: Registry = createRegistry();
  private readonly loaded = new Map<string, Loaded>();
  private readonly report: (message: string) => void;

  constructor(report: (message: string) => void = (m) => console.error(`loki-daemon: ${m}`)) {
    this.report = report;
  }

  /** Activate a mod and install it; a mod of the same name is replaced. A mod that is refused or throws changes nothing. */
  async load(mod: LokiMod): Promise<LoadResult> {
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
    let dispose: void | (() => void);
    try {
      dispose = await mod.activate(api);
    } catch (error) {
      abort.abort();
      if (replacing) this.unload(mod.name);
      const refused = `mod ${mod.name} failed to load: ${error instanceof Error ? error.message : String(error)}`;
      this.report(refused);
      return { refused };
    }
    this.loaded.set(mod.name, { mod, pieces, abort, ...(typeof dispose === "function" ? { dispose } : {}) });
    this.install(mod.name);
    return { loaded: true };
  }

  /** Undo a mod and take its extension out of every chat. */
  unload(name: string): void {
    const extension = this.registry.snapshot().extension(name);
    this.retire(name);
    if (extension) this.registry.uninstall(extension);
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
    const tools = pieces.tools.map((tool) =>
      defineTool({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as never,
        execute: async (args, api, context) => {
          const ref = await chatRef(api, api.conversationId, context);
          const value = await tool.execute(args as Record<string, unknown>, { ...ref, signal: context.abortSignal ?? NO_SIGNAL, output: (text) => api.output(text) });
          const text = resultText(value);
          return text === undefined ? {} : { content: [{ type: "text", text }] };
        },
      }),
    );
    const sections = pieces.sections.map(({ key, render }) =>
      section(key, async (input, context) => render({ ...(await chatRef(input.read, input.conversationId, context)), cwd: input.agent.cwd })),
    );
    const hooks: HookRegistration[] = [];
    const watchesTools = Boolean(pieces.listeners.get("tool_start")?.size || pieces.listeners.get("tool_end")?.size);
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
