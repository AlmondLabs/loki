import type { Scope } from "../core/desk-core.ts";
import { KIT, SHARED_SCOPE, mergeData, scopeFor } from "../core/desk-core.ts";
import type { ModApi } from "../daemon/mods/api.ts";
import type { DeskStore } from "./desk-store.ts";
import type { WidgetsWatcher } from "./widgets-fs.ts";
import type { GestureLog } from "./gestures.ts";
import { scopeOfId } from "../core/desk-core.ts";
import { log, withTimeout } from "./log.ts";
import type { DeskSummary } from "../core/frame-types.ts";
import { parseSuggestionTarget } from "../core/frames.ts";
import type { Suggestions } from "./suggestions.ts";
import { linkLines, type ChatMessages } from "./chat-links.ts";
import { messageOf } from "../core/errors.ts";

/**
 * Two canvas tools, and chat_list with the suggestion tools (and chat_message, plan 067) when the daemon keeps suggestions. Rendering and authoring are file writes, not tool calls — the
 * agent uses its own Write/Edit on <widgetsDir>/<desk>/. The desk tools exist for
 * reading back and for directing attention.
 */

/**
 * What the agent's tools need from the mod: the desk state, widget files and gestures, how to find a call's desk, the
 * broadcast, and the chat list with the suggestions.
 */
export interface ToolDeps {
  store: DeskStore;
  widgets: WidgetsWatcher;
  gestures: GestureLog;
  widgetsDir: string;
  /** Fallback only: the last conversation that started a turn. Tool calls know their own conversation. */
  activeScope: () => Scope;
  /** Bind a conversation to its desk and return the scope. */
  remember?: (conversationId: string, agentId?: string | null) => Scope;
  broadcast(msg: object, scope?: Scope): void;
  /** The chat list and the suggestions (plan 049, U3), when this daemon keeps suggestions. */
  chats?: ChatToolDeps;
}

/** An agent as chat_list names it: the Mac it lives on, by name, and whether that Mac is in reach now. */
export interface ListedAgent {
  id: string;
  name: string;
  mac: string;
  reachable: boolean;
}

/** What chat_list and the suggestion tools read and change. */
export interface ChatToolDeps {
  suggestions: Pick<Suggestions, "add">;
  /** The person's agents, each with its Mac. */
  agents(): ListedAgent[] | Promise<ListedAgent[]>;
  /** Every chat in the lists, this Mac's and the paired Macs', archived ones included (they are left out here). */
  chats(): DeskSummary[];
  /** A background pass's own chat (reflection, Learn), which has no chat screen for a suggestion to show in (KTD12). */
  passChat(conversationId: string): boolean;
  /** Chat links and their messages (plan 067), when this daemon keeps them. */
  messages?: Pick<ChatMessages, "send" | "linksOf">;
}

/**
 * The desk a tool call is about: the explicit `desk` argument, else the desk of
 * the conversation making the call, else the mod's active desk. Never the
 * active desk when the call's own conversation is known — other conversations
 * (schedules, subagents, another chat) move the active desk under our feet.
 * The calling agent counts: every agent's main chat is `default`, and its desk is `default-<agent>`.
 */
export function scopeForCall(
  deps: ToolDeps,
  ctx: { args?: Record<string, unknown>; conversation?: { id: string | null } | null; agent?: { id: string } | null } | undefined,
): Scope {
  const desk = ctx?.args?.desk;
  if (typeof desk === "string" && desk) return scopeFor(desk);
  const conv = ctx?.conversation?.id;
  const agentId = ctx?.agent?.id || null;
  if (conv) return deps.remember ? deps.remember(conv, agentId) : scopeFor(conv, agentId);
  return deps.activeScope();
}

/**
 * A desk's widgets as canvas_read answers: each one's file, kind, title and data with the person's edits merged in, its
 * place on the desk when it has one, and any error.
 */
export function deskSnapshot(deps: ToolDeps, scope: Scope) {
  const state = deps.store.get(scope);
  return deps.widgets.entries(scope).map((w) => {
    const l = Object.hasOwn(state.layout, w.id) ? state.layout[w.id] : undefined;
    return {
      id: w.id,
      file: `${deps.widgetsDir}/${w.file}`,
      kind: w.kind,
      ...(w.type ? { type: w.type } : {}),
      title: w.title,
      data: mergeData(w.data, state.overlay[w.id]),
      ...(l ? { position: l.position, ...(l.size ? { size: l.size } : {}), z: l.z, ...(l.hidden ? { minimised_by_user: true } : {}) } : {}),
      ...(w.error ? { error: w.error } : {}),
    };
  });
}

/** What a tool's body is told about its call: the arguments, and the chat and agent making it. */
export interface Call {
  args: Record<string, unknown>;
  conversation: { id: string };
  agent: { id: string; name: string };
  /** The turn's stop: a call waiting on the person ends with it. */
  signal?: AbortSignal;
}
/** One of loki's own tools as this mod writes it; `run` returning `{ status: "error", content }` fails the call. */
export interface LokiTool {
  name: string;
  description: string;
  parameters: object;
  annotations?: { readOnly?: boolean };
  /** The agents whose chats are offered the tool (plan 067, KTD10); absent, every agent's. */
  forAgent?: (agentId: string) => boolean;
  /** Who may call it (ModTool.callers); `["tools"]` is for scripts only (plan 099). */
  callers?: ReadonlyArray<"model" | "tools">;
  /** JSON Schema of the value scripts get, for a tool whose result is JSON text (ModTool.outputSchema). */
  outputSchema?: object;
  run(ctx: Call): unknown;
}

/** Who calls the canvas tools and chat_list: scripts only (plan 099). The model reaches them with one. */
const SCRIPTS_ONLY = ["tools"] as const;

/** A tool argument as text: the model sends strings, and now and then a number; anything else is no text. */
export const argText = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "");

/**
 * Registers loki's own tools through the mod API, each returning the function that unregisters it. A result of
 * `{ status: "error", content }` is a failed call with that message.
 */
export function toolRegistrar(api: ModApi): { register: (tool: LokiTool) => () => void } {
  return {
    register: (tool: LokiTool) =>
      api.tools.register({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
        ...(tool.forAgent ? { forAgent: tool.forAgent } : {}),
        ...(tool.callers ? { callers: tool.callers } : {}),
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        execute: async (args, c) => {
          const out = await tool.run({ args, conversation: { id: c.chatId }, agent: { id: c.agentId, name: c.agentName }, signal: c.signal });
          if (out && typeof out === "object" && (out as { status?: unknown }).status === "error") {
            const content = (out as { content?: unknown }).content;
            throw new Error(content === undefined || content === null ? "the tool failed" : typeof content === "string" ? content : JSON.stringify(content));
          }
          return out;
        },
      }),
  };
}

/**
 * Registers the agent's tools with the daemon (canvas_read, canvas_focus, and chat_list with the suggestion tools when
 * the daemon keeps suggestions, with chat_message when it keeps chat links); returns the functions that unregister them.
 */
export function registerTools(api: ModApi, deps: ToolDeps): Array<() => void> {
  const tools = toolRegistrar(api);
  const kitLine = Object.entries(KIT)
    .map(([t, k]) => `${t}: ${k.data_shape}`)
    .join("; ");

  const disposers: Array<() => void> = [];

  // How to make a widget reaches every chat as a section (plan 099, KTD5): canvas_read, which said it before, is a
  // script's now, and the model would not see its description.
  disposers.push(
    api.prompt.section(
      "canvas",
      () =>
        "The canvas beside this chat shows widgets you make by writing files, never through a tool: " +
        `${deps.widgetsDir}/<desk>/<name>.json for a kit widget ({ "type", "title", "data" }; kit types: ${kitLine}) ` +
        `or <name>.tsx for a custom React component (export default function Widget({ data, onSet }); import kit pieces from "@loki/kit"). ` +
        'The desk is this chat\'s canvas id, or "shared" for every chat. A file appears at once; read the canvas with canvas_read in a script to find your desk and confirm a widget mounted without error.',
    ),
  );

  disposers.push(
    tools.register({
      name: "canvas_read",
      annotations: { readOnly: true },
      callers: SCRIPTS_ONLY,
      outputSchema: { type: "object" },
      description:
        "Read the loki canvas (the user's widgets beside this chat). Returns the widgets on this conversation's canvas " +
        "and on the shared canvas: file, type, title, data (with the user's gesture edits applied), position, and any " +
        "build/runtime error, and each canvas's folder. The result is for the conversation you are in (pass `desk` to " +
        "look at another). User gestures are also attached automatically to your next turn.",
      parameters: {
        type: "object",
        properties: {
          desk: { type: "string", description: 'Canvas id (a conversation id); omit for the active conversation. "shared" for the shared canvas only.' },
        },
        additionalProperties: false,
      },
      async run(ctx) {
        const args = ctx.args;
        log("tool:canvas_read:start", args);
        // A scan must never hold a turn hostage; the manifest is at most one scan stale.
        await withTimeout(deps.widgets.rescan(), 2000, "canvas_read rescan", undefined);
        const scope = scopeForCall(deps, ctx);
        const out: Record<string, unknown> = {
          desk: scope,
          widgets_dir: `${deps.widgetsDir}/${scope}`,
          widgets: deskSnapshot(deps, scope),
        };
        if (scope !== SHARED_SCOPE) {
          out.shared_widgets_dir = `${deps.widgetsDir}/${SHARED_SCOPE}`;
          out.shared = deskSnapshot(deps, SHARED_SCOPE);
        }
        const pending = [...deps.gestures.peek(scope), ...(scope !== SHARED_SCOPE ? deps.gestures.peek(SHARED_SCOPE) : [])];
        if (pending.length) out.pending_canvas_activity = pending;
        log("tool:canvas_read:done", { desk: scope, widgets: (out.widgets as unknown[]).length });
        return JSON.stringify(out, null, 2);
      },
    }),
  );

  disposers.push(
    tools.register({
      name: "canvas_focus",
      annotations: { readOnly: true },
      callers: SCRIPTS_ONLY,
      description:
        "Glide the user's canvas camera to one widget, or frame several together (eased zoom-to; the targets are " +
        "highlighted for a few seconds). Use it to direct attention after writing a widget or when referring to " +
        "widgets while you talk. `dwell` (ms, up to 8000) makes the call wait before returning, useful when " +
        "moving between several widgets. Ignored while the user is mid-interaction.",
      parameters: {
        type: "object",
        properties: {
          widget_id: { type: "string", description: 'One widget id as returned by canvas_read, e.g. "shared/sleep"' },
          widget_ids: { type: "array", items: { type: "string" }, description: "Several widget ids to fit in view together" },
          dwell: { type: "number", description: "Milliseconds to hold before returning (0–8000)." },
        },
        additionalProperties: false,
      },
      async run(ctx) {
        const args = ctx.args;
        const ids = Array.isArray(args.widget_ids)
          ? (args.widget_ids as unknown[]).filter((x): x is string => typeof x === "string")
          : typeof args.widget_id === "string" && args.widget_id
            ? [args.widget_id]
            : [];
        log("tool:canvas_focus", { ids, dwell: args.dwell });
        if (ids.length === 0) return { status: "error", content: "give widget_id or widget_ids" };
        const missing = ids.filter((id) => !deps.widgets.get(id));
        if (missing.length) return { status: "error", content: `no widget ${missing.map((m) => `"${m}"`).join(", ")} — check canvas_read` };
        const scopes = new Set(ids.map(scopeOfId));
        const scope = scopes.size === 1 ? [...scopes][0] : SHARED_SCOPE; // mixed desks: every tab may have them
        deps.broadcast({ type: "camera", widget_id: ids[0], widget_ids: ids }, scope === SHARED_SCOPE ? undefined : scope);
        const dwell = Math.max(0, Math.min(8000, Number(args.dwell) || 0));
        if (dwell) await new Promise((r) => setTimeout(r, dwell));
        return ids.length === 1
          ? `camera gliding to "${ids[0]}"${dwell ? `, held ${dwell}ms` : ""} (suppressed if the user is mid-interaction)`
          : `camera framing ${ids.length} widgets${dwell ? `, held ${dwell}ms` : ""}`;
      },
    }),
  );

  if (deps.chats) disposers.push(...registerChatTools(tools, deps.chats));

  return disposers;
}

/** A chat the lists show as open: live, with a conversation behind it. */
type OpenChat = DeskSummary & { conversation_id: string; agent_id: string };
const openChats = (rows: DeskSummary[]): OpenChat[] => rows.filter((d): d is OpenChat => d.status === "live" && !!d.conversation_id && !!d.agent_id);

/** One chat as chat_list prints it: ids first, then what tells the agent what the chat is for. */
function chatLine(d: OpenChat, calling: string): string {
  return [
    d.conversation_id,
    `agent ${d.agent_id} (${d.agent_name ?? "unknown"})`,
    `"${d.title ?? "untitled"}"`,
    `folder ${d.cwd ?? "none"}`,
    d.home_name ? `on ${d.home_name}${d.reachable === false ? ", out of reach" : ""}` : null,
    d.labels?.length ? `labels ${d.labels.join(", ")}` : null,
    d.pinned ? "pinned" : null,
    `last active ${d.last_active ?? "never"}`,
    d.purpose ? `purpose: ${d.purpose}` : null,
    d.conversation_id === calling ? "this chat" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * chat_list and suggestion_create (plan 049, U3), and chat_message (plan 067). The agent hears what became of each
 * suggestion when the person acts on it, so there is no tool to list or take one back (plan 094).
 * All are marked read-only (KTD4): a suggestion is the person's decision when they act on it, so making one never stops
 * a turn for approval, and a chat message asks on its own link card, which no mode stands in for.
 */
function registerChatTools(tools: { register: (tool: LokiTool) => () => void }, deps: ChatToolDeps): Array<() => void> {
  const failed = (content: string) => ({ status: "error", content });
  const passError = failed("a background pass has no chat screen to show suggestions in, so it cannot list chats or suggest");
  const source = (ctx: Call) => ({ agent_id: ctx.agent.id, conversation_id: ctx.conversation.id });
  const reason = (err: unknown) => messageOf(err);

  const chatList: LokiTool = {
    name: "chat_list",
    annotations: { readOnly: true },
    callers: SCRIPTS_ONLY,
    description:
      "List the person's agents (id, name, the Mac each lives on, whether it is in reach) and their open chats on this Mac " +
      "and paired Macs, one line each: conversation id, agent, name, folder, labels, pinned, last active, the person's " +
      "purpose line, and which one is this chat. Call it before suggestion_create to pick the chat a piece of work fits " +
      "best. `filter` keeps only the lines that contain its text.",
    parameters: {
      type: "object",
      properties: { filter: { type: "string", description: "Text a line must contain (any case), such as a label, folder or word of a purpose." } },
      additionalProperties: false,
    },
    async run(ctx) {
      if (deps.passChat(ctx.conversation.id)) return passError;
      const filter = argText(ctx.args.filter).trim().toLowerCase();
      const keep = (line: string) => !filter || line.toLowerCase().includes(filter);
      const agents = (await deps.agents()).map((a) => `${a.id} · ${a.name} · on ${a.mac}${a.reachable ? "" : ", out of reach"}`).filter(keep);
      const chats = openChats(deps.chats())
        .map((d) => chatLine(d, ctx.conversation.id))
        .filter(keep);
      log("tool:chat_list", { agents: agents.length, chats: chats.length });
      const links = deps.messages ? linkLines(deps.messages.linksOf(source(ctx)), source(ctx)) : [];
      return [
        "Agents (id · name · Mac):",
        ...(agents.length ? agents : ["none"]),
        "",
        "Open chats (conversation id · agent · name · folder · …):",
        ...(chats.length ? chats : ["none"]),
        ...(links.length ? ["", "This chat's links (chat_message goes along them without asking):", ...links] : []),
      ].join("\n");
    },
  };

  const create: LokiTool = {
    name: "suggestion_create",
    annotations: { readOnly: true },
    description:
      "Suggest a message for another chat; the person sends it, saves it as a draft there, or rejects it, and you never " +
      "send it yourself. Suggest on your own whenever a piece of work, a side finding or part of the current task, would " +
      "be done better in another chat: a themed chat it belongs to, another agent, or a new chat running in parallel. " +
      "Suggest never for work you can do in this chat. One piece of work per suggestion. The text must stand alone, " +
      "as if the person typed it there: what to do and why, with absolute paths, since it may go to another agent or " +
      "folder. Pick the target with chat_list, in a script, first. The " +
      "target is an open chat { agent_id, conversation_id } or a new chat { agent_id, folder }. It returns the " +
      "suggestion's id at once; name the suggestion in one line of your reply.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "One line the person reads on the card." },
        text: { type: "string", description: "The message as it would be sent: self-contained, absolute paths." },
        target: {
          type: "object",
          description: "An open chat from chat_list ({ agent_id, conversation_id }), or a new chat for an agent in a folder ({ agent_id, folder }).",
          properties: {
            agent_id: { type: "string" },
            conversation_id: { type: "string" },
            folder: { type: "string", description: "A folder chat_list shows, for a new chat." },
          },
          required: ["agent_id"],
          additionalProperties: false,
        },
      },
      required: ["title", "text", "target"],
      additionalProperties: false,
    },
    async run(ctx) {
      if (deps.passChat(ctx.conversation.id)) return passError;
      const target = parseSuggestionTarget(ctx.args.target);
      if (!target) return failed("suggestion_create needs a target: { agent_id, conversation_id } for an open chat, or { agent_id, folder } for a new one");
      // Checked against the lists the agent reads in chat_list, so a made-up target is refused before anything is stored.
      const agents = await deps.agents();
      if (!agents.some((a) => a.id === target.agent_id))
        return failed(`no agent ${target.agent_id}: the agents are ${agents.map((a) => `${a.id} (${a.name})`).join(", ") || "none"}`);
      const chats = openChats(deps.chats());
      if ("conversation_id" in target) {
        const chat = chats.find((d) => d.conversation_id === target.conversation_id);
        if (!chat)
          return failed(
            `no open chat ${target.conversation_id}: the open chats are ${chats.map((d) => `${d.conversation_id} "${d.title ?? "untitled"}" (agent ${d.agent_id})`).join(", ") || "none"}`,
          );
        if (chat.agent_id !== target.agent_id) return failed(`chat ${target.conversation_id} belongs to agent ${chat.agent_id}, not ${target.agent_id}`);
      } else {
        const folders = [...new Set(chats.map((d) => d.cwd).filter((f): f is string => !!f))];
        if (!folders.includes(target.folder)) return failed(`no chat works in ${target.folder}: the folders are ${folders.join(", ") || "none"}`);
      }
      try {
        const made = await deps.suggestions.add(source(ctx), { title: argText(ctx.args.title), text: argText(ctx.args.text), target });
        log("tool:suggestion_create", { conversation: ctx.conversation.id, id: made.id });
        return `suggested ${made.id} "${made.title}": it waits for the person to send, save or reject it. Name it in one line of your reply.`;
      } catch (err) {
        return failed(reason(err));
      }
    },
  };

  const message: LokiTool = {
    name: "chat_message",
    annotations: { readOnly: true },
    description:
      "Send a message to another open chat's agent, to work on something together: ask it a question, hand it a piece " +
      "of the work and hear back, or answer a message it sent you. The first message to a chat this one has no link to " +
      "shows the person a card, and waits: they allow a link one way or both ways, for a while, or refuse. Along a live " +
      "link it goes at once. The other agent reads it as a message from you, not from the person, and its turn runs " +
      "with no more power than this chat has. Use suggestion_create instead for work the person should decide on, or " +
      "for a new chat. Call chat_list first for the chat's ids. The text must stand alone: what you need and why, with " +
      "absolute paths.",
    parameters: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "The other chat's agent, from chat_list." },
        conversation_id: { type: "string", description: "The other chat, from chat_list." },
        text: { type: "string", description: "The message, self-contained." },
      },
      required: ["agent_id", "conversation_id", "text"],
      additionalProperties: false,
    },
    async run(ctx) {
      if (deps.passChat(ctx.conversation.id)) return failed("a background pass has no chat screen to ask the person in, so it cannot message chats");
      if (!deps.messages) return failed("chat links are not kept by this daemon");
      const target = { agent_id: argText(ctx.args.agent_id), conversation_id: argText(ctx.args.conversation_id) };
      if (!target.agent_id || !target.conversation_id) return failed("chat_message needs agent_id and conversation_id: list them with chat_list in a script");
      const chat = openChats(deps.chats()).find((d) => d.conversation_id === target.conversation_id);
      if (chat && chat.agent_id !== target.agent_id) return failed(`chat ${target.conversation_id} belongs to agent ${chat.agent_id}, not ${target.agent_id}`);
      try {
        const out = await deps.messages.send(source(ctx), target, argText(ctx.args.text), ctx.signal ?? new AbortController().signal);
        log("tool:chat_message", { conversation: ctx.conversation.id, to: target.conversation_id, ok: out.ok });
        return out.ok ? out.message : failed(out.message);
      } catch (err) {
        return failed(reason(err));
      }
    },
  };

  return [chatList, create, ...(deps.messages ? [message] : [])].map((tool) => tools.register(tool));
}
