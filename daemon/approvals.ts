import type { Context } from "@earendil-works/chord";
import { AgentDoc as PiAgentDoc, defineExtension, hook, ToolTask, type Extension, type HookApi } from "@earendil-works/pi-durable";
import { isAbsolute, relative, resolve } from "node:path";
import type { ChatEvent } from "../core/attention/model.ts";
import { AgentInfoDoc, ChatDoc } from "./kernel/index.ts";

/**
 * Approvals (plan 017, U7, KTD8): before a tool runs, the chat's permission mode decides whether the person is asked.
 * The question goes to every client following the chat; the first answer wins, an abort withdraws it, and the answer
 * is kept in the tool task's memo, so a turn resumed after a crash never asks again for a call already decided.
 * The gate is one pi-durable extension, selected by every conversation (subagents included), as the mods are.
 */

export type PermissionMode = "strict" | "standard" | "acceptEdits" | "unrestricted";
export const DEFAULT_MODE: PermissionMode = "unrestricted";
export const isPermissionMode = (m: unknown): m is PermissionMode => m === "strict" || m === "standard" || m === "acceptEdits" || m === "unrestricted";

/** What a tool does, for the mode table: reads, edits files, or anything else (a command). */
export type ToolKind = "read" | "edit" | "command";

/** The built-in tools and loki's own, by kind; a mod's tool says what it is in its annotations (daemon/mods/api.ts). */
const KINDS: Record<string, ToolKind> = {
  read: "read",
  grep: "read",
  find: "read",
  ls: "read",
  desk_state: "read",
  loki_camera: "read",
  web_search: "read",
  view_image: "read",
  Skill: "read",
  // A helper's own tool calls pass the gate; starting one does not ask on its own.
  Agent: "read",
  // Memory is the agent's own: changing it is not a permission.
  memory_read: "read",
  memory_write: "read",
  memory_edit: "read",
  write: "edit",
  edit: "edit",
};

/** A tool that is never a permission: a question card asks for answers, not leave. */
const NEVER_ASK = new Set(["AskUserQuestion"]);

export function kindOf(name: string, annotations?: { readOnly?: boolean; destructive?: boolean }): ToolKind {
  if (KINDS[name]) return KINDS[name];
  if (annotations?.readOnly) return "read";
  return "command";
}

/**
 * Whether the mode asks before this call. The table (GLOSSARY.md, Permission mode):
 *   strict        every tool, reads included
 *   standard      edits and commands; reads run freely
 *   acceptEdits   commands; edits and reads run freely
 *   unrestricted  nothing
 * An edit inside loki's widget folder never asks: the canvas is the agent's to furnish.
 */
export function asks(mode: PermissionMode, name: string, args: Record<string, unknown>, opts: { cwd?: string; widgetsDir?: string; kind?: ToolKind }): boolean {
  if (NEVER_ASK.has(name) || mode === "unrestricted") return false;
  const kind = opts.kind ?? kindOf(name);
  if (kind === "edit" && opts.widgetsDir && insideFolder(args.path ?? args.file_path, opts.widgetsDir, opts.cwd)) return false;
  if (mode === "strict") return true;
  if (kind === "read") return false;
  if (mode === "acceptEdits") return kind === "command";
  return true;
}

function insideFolder(path: unknown, folder: string, cwd: string | undefined): boolean {
  if (typeof path !== "string" || !path) return false;
  const full = isAbsolute(path) ? path : resolve(cwd ?? folder, path);
  const rel = relative(resolve(folder), full);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

type Decision = { allow: boolean; message?: string };
type Pending = { agentId: string; conversationId: string; event: ChatEvent; settle: (d: Decision | { answers: Record<string, unknown> }) => void };

export class Approvals {
  private readonly pending = new Map<string, Pending>();
  private push: (agentId: string, conversationId: string, events: ChatEvent[]) => void = () => {};
  private readonly widgetsDir: string | undefined;
  private readonly kindOfTool: (name: string) => ToolKind;

  constructor(opts: { widgetsDir?: string; kindOfTool?: (name: string) => ToolKind } = {}) {
    this.widgetsDir = opts.widgetsDir;
    this.kindOfTool = opts.kindOfTool ?? ((name) => kindOf(name));
  }

  attach(push: (agentId: string, conversationId: string, events: ChatEvent[]) => void): void {
    this.push = push;
  }

  /** The approvals and questions a chat is waiting on, for a client that opens it now. */
  waitingIn(agentId: string, conversationId: string): ChatEvent[] {
    return [...this.pending.values()].filter((p) => p.agentId === agentId && p.conversationId === conversationId).map((p) => p.event);
  }

  /** The person's decision on an approval; false when nothing is waiting under that id (already answered). */
  decide(requestId: string, allow: boolean, message?: string): boolean {
    const p = this.pending.get(requestId);
    if (!p || p.event.kind !== "approval") return false;
    p.settle({ allow, ...(message ? { message } : {}) });
    return true;
  }

  /** The person's answers to a question card. */
  answer(requestId: string, answers: Record<string, unknown>): boolean {
    const p = this.pending.get(requestId);
    if (!p || p.event.kind !== "question") return false;
    p.settle({ answers });
    return true;
  }

  /** Ask every client following the chat, and wait for the first answer or the turn's abort. */
  ask<T>(agentId: string, conversationId: string, event: ChatEvent & { requestId: string }, signal: AbortSignal | undefined): Promise<T> {
    return new Promise<T>((resolvePromise, reject) => {
      const done = () => {
        this.pending.delete(event.requestId);
        signal?.removeEventListener("abort", onAbort);
        this.push(agentId, conversationId, [{ kind: "loop", state: "running" }]);
      };
      const onAbort = () => {
        done();
        reject(new Error("the turn was stopped"));
      };
      if (signal?.aborted) return reject(new Error("the turn was stopped"));
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(event.requestId, {
        agentId,
        conversationId,
        event,
        settle: (d) => {
          done();
          resolvePromise(d as T);
        },
      });
      this.push(agentId, conversationId, [event, { kind: "loop", state: "approval" }]);
    });
  }

  /** The gate, as an extension every conversation selects. */
  extension(): Extension {
    return defineExtension({
      name: "loki.approvals",
      hooks: [
        hook(ToolTask, {
          beforeTool: async (call, api, context) => {
            const memoName = `approval:${call.id}`;
            const decided = await api.memo<Decision>(memoName, context);
            const decision = decided ?? (await this.decideCall(call.name, call.arguments as Record<string, unknown>, call.id, api, context));
            if (!decision) return undefined;
            if (!decided) await api.memo(memoName, decision, context);
            return decision.allow ? undefined : { block: decision.message || "The person declined this tool call." };
          },
        }),
      ],
    });
  }

  /** null when the mode lets the call run without asking. */
  private async decideCall(name: string, args: Record<string, unknown>, callId: string, api: HookApi, context: Context): Promise<Decision | null> {
    const [chat, agent, settings] = await Promise.all([api.snapshot(ChatDoc, api.conversationId, context), api.snapshot(AgentInfoDoc, context), api.snapshot(PiAgentDoc, api.conversationId, context)]);
    const mode = isPermissionMode(chat?.mode) ? chat.mode : DEFAULT_MODE;
    if (!asks(mode, name, args, { cwd: settings?.cwd, widgetsDir: this.widgetsDir, kind: this.kindOfTool(name) })) return null;
    const agentId = agent?.id ?? "";
    const conversationId = chat?.id || `conversation-${api.conversationId}`;
    return this.ask<Decision>(agentId, conversationId, { kind: "approval", requestId: `approval-${callId}`, toolName: name, input: args }, context.abortSignal);
  }
}
