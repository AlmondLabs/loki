import type { Context } from "@earendil-works/chord/context";
import { AgentDoc as PiAgentDoc, defineExtension, hook, ToolTask, type Extension, type HookApi } from "@earendil-works/pi-durable";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { NEVER_ALWAYS_TOOLS, type ChatEvent } from "../core/attention/model.ts";
import { readOnlyRefusal, type ReadOnlyFolders } from "./read-only-gate.ts";
import { AgentInfoDoc, ChatDoc, type ChatInfo } from "./kernel/index.ts";
import { lokiModeOf, modeOf, stricterMode, type PermissionMode } from "../core/chat-links.ts";
import { isReadOnlyCommand } from "./read-only-command.ts";
import { SCRIPT_TOOL } from "./scripts.ts";
import { CODING_TOOL_KINDS, type ToolKind } from "./tool-kinds.ts";

export type { ToolKind } from "./tool-kinds.ts";

const NEVER_ASK = new Set(["plan", "user_ask", "chat_list", "suggestion_create", "chat_message", "reply_propose", "message_propose", "ticket_propose"]);

export function kindOf(name: string, annotations?: { readOnly?: boolean; destructive?: boolean }): ToolKind {
  const coding = CODING_TOOL_KINDS[name];
  if (coding) return coding;
  if (annotations?.readOnly) return "read";
  return "command";
}

export function asks(mode: PermissionMode, name: string, args: Record<string, unknown>, opts: { cwd?: string; kind?: ToolKind }): boolean {
  if (NEVER_ASK.has(name) || mode === "unrestricted") return false;
  const kind = callKind(name, args) ?? opts.kind ?? kindOf(name);
  if (mode === "strict") return true;
  if (kind === "read") return false;
  if (mode === "acceptEdits") return kind === "command";
  return true;
}

function callKind(name: string, args: Record<string, unknown>): ToolKind | undefined {
  if (name === "bash" && isReadOnlyCommand(args.command) && args.background !== true && args.wait_ms === undefined) return "read";
  if (name === "background_watch" && (args.input !== undefined || args.stop === true)) return "command";
  if (name === "subagent" && args.workspace === "worktree" && args.read_only !== true) return "command";
  return undefined;
}

const scriptCode = (args: Record<string, unknown>): string => (typeof args.code === "string" ? args.code : "");

// oxlint-disable-next-line typescript/consistent-type-definitions -- a tool task's result must be a JsonValue, and an interface with an optional field cannot extend JsonObject
type Decision = { allow: boolean; message?: string; always?: boolean };
interface Pending {
  agentId: string;
  conversationId: string;
  event: ChatEvent;
  remember: boolean;
  settle: (d: Decision | { answers: Record<string, unknown> }) => void;
}

export class Approvals {
  private readonly pending = new Map<string, Pending>();
  private push: (agentId: string, conversationId: string, events: ChatEvent[]) => void = () => {};
  private readonly kindOfTool: (name: string) => ToolKind;
  private readonly alwaysPath: string | null;
  private readonly alwaysAllowed: Set<string>;
  private readonly scriptRuns = new Map<string, { code: string; answer?: Promise<Decision> }>();

  private readonly scriptMayCall: ((name: string) => boolean) | undefined;
  private readonly readOnlyFolders: ReadOnlyFolders | undefined;

  constructor(
    opts: {
      kindOfTool?: (name: string) => ToolKind;
      alwaysPath?: string;
      scriptMayCall?: (name: string) => boolean;
      readOnlyFolders?: ReadOnlyFolders;
    } = {},
  ) {
    this.readOnlyFolders = opts.readOnlyFolders;
    this.scriptMayCall = opts.scriptMayCall;
    this.alwaysPath = opts.alwaysPath ?? null;
    const stored = this.alwaysPath ? readAlways(this.alwaysPath) : [];
    this.alwaysAllowed = new Set(stored.filter((name) => !NEVER_ALWAYS_TOOLS.has(name)));
    this.kindOfTool = opts.kindOfTool ?? ((name) => kindOf(name));
  }

  attach(push: (agentId: string, conversationId: string, events: ChatEvent[]) => void): void {
    this.push = push;
  }

  waitingIn(agentId: string, conversationId: string): ChatEvent[] {
    return [...this.pending.values()].filter((p) => p.agentId === agentId && p.conversationId === conversationId).map((p) => p.event);
  }

  decide(requestId: string, allow: boolean, message?: string, always = false): boolean {
    const p = this.pending.get(requestId);
    if (p?.event.kind !== "approval") return false;
    if (allow && always && p.remember && p.event.tool_name) this.setAlways(p.event.tool_name, true);
    p.settle({ allow, ...(message ? { message } : {}), ...(always ? { always } : {}) });
    return true;
  }

  always(): string[] {
    return [...this.alwaysAllowed].sort();
  }

  setAlways(toolName: string, on: boolean): string[] {
    if (on && NEVER_ALWAYS_TOOLS.has(toolName)) return this.always();
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

  answer(requestId: string, answers: Record<string, unknown>): boolean {
    const p = this.pending.get(requestId);
    if (p?.event.kind !== "question") return false;
    p.settle({ answers });
    return true;
  }

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

  extension(): Extension {
    return defineExtension({
      name: "loki.approvals",
      hooks: [
        hook(ToolTask, {
          beforeTool: async (call, api, context) => {
            const own = await api.snapshot(ChatDoc, api.conversationId, context);
            if (own?.read_only === true) {
              const refused = await this.readOnlyRefusal(own.id, call.name, call.arguments, api, context);
              return refused === null ? undefined : { block: refused };
            }
            const mayCall = call.parent === undefined ? undefined : this.scriptMayCall;
            if (mayCall && !mayCall(call.name)) return { block: `A script may not call ${call.name}.` };
            if (call.parent === undefined && call.name === SCRIPT_TOOL) this.scriptRuns.set(call.id, { code: scriptCode(call.arguments) });
            const memoName = `approval:${call.id}`;
            const decided = await api.memo<Decision>(memoName, context);
            const decision =
              decided ??
              (mayCall === undefined || !call.parent
                ? await this.decideCall(own, call.name, call.arguments, call.id, api, context)
                : await this.decideCall(own, call.name, call.arguments, call.id, api, context, call.parent.callId));
            if (!decision) return undefined;
            if (!decided) await api.memo(memoName, decision, context);
            return decision.allow ? undefined : { block: decision.message || "The person declined this tool call." };
          },
          afterTool: (call, result) => {
            if (call.parent === undefined && call.name === SCRIPT_TOOL) this.scriptRuns.delete(call.id);
            return result;
          },
        }),
      ],
    });
  }

  private async readOnlyRefusal(chatId: string, name: string, args: Record<string, unknown>, api: HookApi, context: Context): Promise<string | null> {
    const [agent, settings] = await Promise.all([api.snapshot(AgentInfoDoc, context), api.snapshot(PiAgentDoc, api.conversationId, context)]);
    return readOnlyRefusal({ name, args, cwd: settings?.cwd, agentId: agent?.id ?? "", chatId }, this.readOnlyFolders);
  }

  private async decideCall(
    own: Readonly<ChatInfo> | undefined,
    name: string,
    args: Record<string, unknown>,
    callId: string,
    api: HookApi,
    context: Context,
    script?: string,
  ): Promise<Decision | null> {
    const [agent, settings] = await Promise.all([api.snapshot(AgentInfoDoc, context), api.snapshot(PiAgentDoc, api.conversationId, context)]);
    const chat = own?.helper_for === undefined ? own : ((await api.snapshot(ChatDoc, own.helper_for, context)) ?? own);
    const mode = chat?.turn_cap ? stricterMode(modeOf(chat.mode), lokiModeOf(chat.turn_cap, false)) : modeOf(chat?.mode);
    if (!asks(mode, name, args, { cwd: settings?.cwd, kind: this.kindOfTool(name) })) return null;
    if (mode !== "strict" && this.alwaysAllowed.has(name)) return null;
    const agentId = agent?.id ?? "";
    const conversationId = chat?.id || `conversation-${api.conversationId}`;
    if (script !== undefined && mode !== "strict") {
      const run = this.scriptRuns.get(script) ?? { code: "" };
      this.scriptRuns.set(script, run);
      run.answer ??= this.ask<Decision>(
        agentId,
        conversationId,
        {
          kind: "approval",
          request_id: `approval-script-${script}`,
          tool_name: SCRIPT_TOOL,
          input: { code: run.code, first_call: { tool: name, input: args } },
        },
        context.abortSignal,
      ).catch((error: unknown) => {
        delete run.answer;
        throw error;
      });
      const answer = await run.answer;
      return answer.allow ? answer : { allow: false, message: answer.message || "The person declined this script's changes." };
    }
    return this.ask<Decision>(
      agentId,
      conversationId,
      { kind: "approval", request_id: `approval-${callId}`, tool_name: name, input: args },
      context.abortSignal,
    );
  }
}

function readAlways(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { always?: unknown };
    return Array.isArray(raw.always) ? raw.always.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
