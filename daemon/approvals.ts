import type { Context } from "@earendil-works/chord";
import { AgentDoc as PiAgentDoc, defineExtension, hook, ToolTask, type Extension, type HookApi } from "@earendil-works/pi-durable";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ChatEvent } from "../core/attention/model.ts";
import { AgentInfoDoc, ChatDoc } from "./kernel/index.ts";
import { CODING_TOOL_KINDS, RENAMED_TOOLS, type ToolKind } from "./tool-kinds.ts";

/**
 * Approvals (plan 017, U7, KTD8): before a tool runs, the chat's permission mode decides whether the person is asked.
 * The question goes to every client following the chat; the first answer wins, an abort withdraws it, and the answer
 * is kept in the tool task's memo, so a turn resumed after a crash never asks again for a call already decided.
 * The gate is one pi-durable extension, selected by every conversation (subagents included), as the mods are.
 */

/** A chat's permission mode: which tool calls ask the person first (the table is on `asks`, and in glossary.md). */
export type PermissionMode = "strict" | "standard" | "acceptEdits" | "unrestricted";
/** The mode of a chat that has none set: nothing asks. */
export const DEFAULT_MODE: PermissionMode = "unrestricted";
/** Whether a stored value is one of the four modes; a chat whose mode is anything else runs in DEFAULT_MODE. */
export const isPermissionMode = (m: unknown): m is PermissionMode => m === "strict" || m === "standard" || m === "acceptEdits" || m === "unrestricted";

export type { ToolKind } from "./tool-kinds.ts";

/** A tool that is never a permission: a question card asks for answers, not leave. */
const NEVER_ASK = new Set(["ask_user"]);

/**
 * A tool's kind for the mode table, when it is not one of loki's own (those declare theirs; daemon/extensions.ts
 * builtinKinds): pi-durable's coding tools by name, then a mod's or MCP server's `readOnly` annotation; anything else is
 * a command, the kind that asks most.
 */
export function kindOf(name: string, annotations?: { readOnly?: boolean; destructive?: boolean }): ToolKind {
  const coding = CODING_TOOL_KINDS[name];
  if (coding) return coding;
  if (annotations?.readOnly) return "read";
  return "command";
}

/**
 * Whether the mode asks before this call. The table (glossary.md, Permission mode):
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

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- a tool task's result must be a JsonValue, and an interface with an optional field cannot extend JsonObject
type Decision = { allow: boolean; message?: string; always?: boolean };
interface Pending {
  agentId: string;
  conversationId: string;
  event: ChatEvent;
  /** Whether "always allow" goes on loki's list; an ACP agent keeps its own (plan 020, KD10). */
  remember: boolean;
  settle: (d: Decision | { answers: Record<string, unknown> }) => void;
}

/**
 * The approval gate and everything a chat waits on the person for: each approval or question card is held until the
 * first client answers or the turn is stopped, and the tools answered "always allow" are remembered.
 */
export class Approvals {
  private readonly pending = new Map<string, Pending>();
  private push: (agentId: string, conversationId: string, events: ChatEvent[]) => void = () => {};
  private readonly widgetsDir: string | undefined;
  private readonly kindOfTool: (name: string) => ToolKind;
  /**
   * Tools you answered "always allow" for (any chat, any agent), kept in `alwaysPath`; Settings › Chat lists them to
   * take back. They run without asking in every mode but strict, which asks for everything by choice.
   */
  private readonly alwaysPath: string | null;
  private readonly alwaysAllowed: Set<string>;

  constructor(opts: { widgetsDir?: string; kindOfTool?: (name: string) => ToolKind; alwaysPath?: string } = {}) {
    this.widgetsDir = opts.widgetsDir;
    this.alwaysPath = opts.alwaysPath ?? null;
    // Tools allowed under their names from before October 2026 carry over to the new names, written back once.
    const stored = this.alwaysPath ? readAlways(this.alwaysPath) : [];
    this.alwaysAllowed = new Set(stored.map((name) => RENAMED_TOOLS[name] ?? name));
    if (stored.some((name) => name in RENAMED_TOOLS)) this.saveAlways();
    this.kindOfTool = opts.kindOfTool ?? ((name) => kindOf(name));
  }

  attach(push: (agentId: string, conversationId: string, events: ChatEvent[]) => void): void {
    this.push = push;
  }

  /** The approvals and questions a chat is waiting on, for a client that opens it now. */
  waitingIn(agentId: string, conversationId: string): ChatEvent[] {
    return [...this.pending.values()].filter((p) => p.agentId === agentId && p.conversationId === conversationId).map((p) => p.event);
  }

  /**
   * The person's decision on an approval; false when nothing is waiting under that id (already answered). `always`
   * with an allow remembers the tool: it does not ask again, in any chat, until taken back.
   */
  decide(requestId: string, allow: boolean, message?: string, always = false): boolean {
    const p = this.pending.get(requestId);
    if (p?.event.kind !== "approval") return false;
    if (allow && always && p.remember && p.event.tool_name) this.setAlways(p.event.tool_name, true);
    p.settle({ allow, ...(message ? { message } : {}), ...(always ? { always } : {}) });
    return true;
  }

  /** The tools that never ask (but in strict mode), sorted. */
  always(): string[] {
    return [...this.alwaysAllowed].sort();
  }

  /** Remember (or forget) a tool as always allowed. */
  setAlways(toolName: string, on: boolean): string[] {
    if (on) this.alwaysAllowed.add(toolName);
    else this.alwaysAllowed.delete(toolName);
    this.saveAlways();
    return this.always();
  }

  private saveAlways(): void {
    if (!this.alwaysPath) return;
    mkdirSync(dirname(this.alwaysPath), { recursive: true });
    writeFileSync(this.alwaysPath, `${JSON.stringify({ always: this.always() }, null, 2)}\n`);
  }

  /** The person's answers to a question card. */
  answer(requestId: string, answers: Record<string, unknown>): boolean {
    const p = this.pending.get(requestId);
    if (p?.event.kind !== "question") return false;
    p.settle({ answers });
    return true;
  }

  /**
   * Ask every client following the chat, and wait for the first answer or the turn's abort. `remember: false` keeps
   * an "always allow" answer off loki's list and only hands it back (an ACP agent's permission, which it remembers).
   */
  ask<T>(
    agentId: string,
    conversationId: string,
    event: ChatEvent & { request_id: string },
    signal: AbortSignal | undefined,
    opts: { remember?: boolean } = {},
  ): Promise<T> {
    return new Promise<T>((resolvePromise, reject) => {
      const done = () => {
        this.pending.delete(event.request_id);
        signal?.removeEventListener("abort", onAbort);
        this.push(agentId, conversationId, [{ kind: "loop", state: "running" }]);
      };
      const onAbort = () => {
        done();
        reject(new Error("the turn was stopped"));
      };
      if (signal?.aborted) return reject(new Error("the turn was stopped"));
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(event.request_id, {
        agentId,
        conversationId,
        event,
        remember: opts.remember ?? true,
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
            const decision = decided ?? (await this.decideCall(call.name, call.arguments, call.id, api, context));
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
    const [chat, agent, settings] = await Promise.all([
      api.snapshot(ChatDoc, api.conversationId, context),
      api.snapshot(AgentInfoDoc, context),
      api.snapshot(PiAgentDoc, api.conversationId, context),
    ]);
    const mode = isPermissionMode(chat?.mode) ? chat.mode : DEFAULT_MODE;
    if (!asks(mode, name, args, { cwd: settings?.cwd, widgetsDir: this.widgetsDir, kind: this.kindOfTool(name) })) return null;
    if (mode !== "strict" && this.alwaysAllowed.has(name)) return null;
    const agentId = agent?.id ?? "";
    const conversationId = chat?.id || `conversation-${api.conversationId}`;
    return this.ask<Decision>(
      agentId,
      conversationId,
      { kind: "approval", request_id: `approval-${callId}`, tool_name: name, input: args },
      context.abortSignal,
    );
  }
}

/** The always-allowed tools as saved; anything unreadable is none. */
function readAlways(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { always?: unknown };
    return Array.isArray(raw.always) ? raw.always.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
