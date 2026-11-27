import type { Scope } from "../core/canvas-core.ts";
import { KIT, SHARED_SCOPE, mergeData, scopeFor } from "../core/canvas-core.ts";
import type { ModApi, ModTool, ToolContext } from "../daemon/mods/api.ts";
import type { CanvasStore } from "./canvas-store.ts";
import type { WidgetsWatcher } from "./widgets-fs.ts";
import { scopeOfId } from "../core/canvas-core.ts";
import { log, withTimeout } from "./log.ts";
import type { ChatSummary } from "../core/frame-types.ts";
import { parseSuggestionTarget } from "../core/frames.ts";
import type { Suggestions } from "./suggestions.ts";
import { linkLines, type ChatMessages } from "./chat-links.ts";
import { messageOf } from "../core/errors.ts";

export interface ToolDeps {
  store: CanvasStore;
  widgets: WidgetsWatcher;
  widgetsDir: string;
  activeScope: () => Scope;
  remember?: (conversationId: string, agentId?: string | null) => Scope;
  broadcast(msg: object, scope?: Scope): void;
  chats?: ChatToolDeps;
}

export interface ListedAgent {
  id: string;
  name: string;
  mac: string;
  reachable: boolean;
}

export interface ChatToolDeps {
  suggestions: Pick<Suggestions, "add">;
  agents(): ListedAgent[] | Promise<ListedAgent[]>;
  chats(): ChatSummary[];
  passChat(conversationId: string): boolean;
  messages?: Pick<ChatMessages, "send" | "linksOf">;
}

export function scopeForCall(deps: ToolDeps, args?: Record<string, unknown>, ctx?: Pick<ToolContext, "chatId" | "agentId">): Scope {
  const desk = args?.desk;
  if (typeof desk === "string" && desk) return scopeFor(desk);
  const conv = ctx?.chatId;
  const agentId = ctx?.agentId || null;
  if (conv) return deps.remember ? deps.remember(conv, agentId) : scopeFor(conv, agentId);
  return deps.activeScope();
}

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

const SCRIPTS_ONLY = ["tools"] as const;

/** A tool argument as text: the model sends strings, and now and then a number; anything else is no text. */
export const argText = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "");

export function registerTools(api: ModApi, deps: ToolDeps): Array<() => void> {
  const kitLine = Object.entries(KIT)
    .map(([t, k]) => `${t}: ${k.data_shape}`)
    .join("; ");

  const disposers: Array<() => void> = [];

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
    api.tools.register({
      name: "canvas_read",
      annotations: { readOnly: true },
      callers: SCRIPTS_ONLY,
      outputSchema: { type: "object" },
      description:
        "Read the loki canvas (the user's widgets beside this chat). Returns the widgets on this conversation's canvas " +
        "and on the shared canvas: file, type, title, data (with the user's gesture edits applied), position, and any " +
        "build/runtime error, and each canvas's folder. The result is for the conversation you are in (pass `desk` to look at another).",
      parameters: {
        type: "object",
        properties: {
          desk: { type: "string", description: 'Canvas id (a conversation id); omit for the active conversation. "shared" for the shared canvas only.' },
        },
        additionalProperties: false,
      },
      async execute(args, ctx) {
        log("tool:canvas_read:start", args);
        await withTimeout(deps.widgets.rescan(), 2000, "canvas_read rescan", undefined);
        const scope = scopeForCall(deps, args, ctx);
        const out: Record<string, unknown> = {
          desk: scope,
          widgets_dir: `${deps.widgetsDir}/${scope}`,
          widgets: deskSnapshot(deps, scope),
        };
        if (scope !== SHARED_SCOPE) {
          out.shared_widgets_dir = `${deps.widgetsDir}/${SHARED_SCOPE}`;
          out.shared = deskSnapshot(deps, SHARED_SCOPE);
        }
        log("tool:canvas_read:done", { desk: scope, widgets: (out.widgets as unknown[]).length });
        return JSON.stringify(out, null, 2);
      },
    }),
  );

  disposers.push(
    api.tools.register({
      name: "canvas_focus",
      annotations: { readOnly: true },
      callers: SCRIPTS_ONLY,
      description:
        "Glide the user's canvas camera to one widget, or frame several together (eased zoom-to; the targets are " +
        "highlighted for a few seconds). Use it to direct attention after writing a widget or when referring to " +
        "widgets while you talk. Ignored while the user is mid-interaction.",
      parameters: {
        type: "object",
        properties: {
          widget_id: { type: "string", description: 'One widget id as returned by canvas_read, e.g. "shared/sleep"' },
          widget_ids: { type: "array", items: { type: "string" }, description: "Several widget ids to fit in view together" },
        },
        additionalProperties: false,
      },
      execute(args) {
        const ids = Array.isArray(args.widget_ids)
          ? (args.widget_ids as unknown[]).filter((x): x is string => typeof x === "string")
          : typeof args.widget_id === "string" && args.widget_id
            ? [args.widget_id]
            : [];
        log("tool:canvas_focus", { ids });
        if (ids.length === 0) throw new Error("give widget_id or widget_ids");
        const missing = ids.filter((id) => !deps.widgets.get(id));
        if (missing.length) throw new Error(`no widget ${missing.map((m) => `"${m}"`).join(", ")} — check canvas_read`);
        const scopes = new Set(ids.map(scopeOfId));
        const scope = scopes.size === 1 ? [...scopes][0] : SHARED_SCOPE;
        deps.broadcast({ type: "camera", widget_id: ids[0], widget_ids: ids }, scope === SHARED_SCOPE ? undefined : scope);
        return ids.length === 1 ? `camera gliding to "${ids[0]}" (suppressed if the user is mid-interaction)` : `camera framing ${ids.length} widgets`;
      },
    }),
  );

  const chats = deps.chats;
  if (chats) disposers.push(...registerChatTools(api, chats));

  return disposers;
}

type OpenChat = ChatSummary & { conversation_id: string; agent_id: string };
const openChats = (rows: ChatSummary[]): OpenChat[] => rows.filter((d): d is OpenChat => d.status === "live" && !!d.conversation_id && !!d.agent_id);

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

function registerChatTools(api: ModApi, deps: ChatToolDeps): Array<() => void> {
  const passError = () => new Error("a background pass has no chat screen to show suggestions in, so it cannot list chats or suggest");
  const source = (ctx: ToolContext) => ({ agent_id: ctx.agentId, conversation_id: ctx.chatId });
  const fail = (err: unknown): never => {
    throw err instanceof Error ? err : new Error(messageOf(err));
  };

  const chatList: ModTool = {
    name: "chat_list",
    annotations: { readOnly: true },
    callers: SCRIPTS_ONLY,
    outputSchema: { type: "object" },
    description:
      "List the person's agents (id, name, mac, reachable) and their open chats on this Mac " +
      "and paired Macs (conversation_id, agent_id, agent_name, title, cwd, labels, pinned, last_active, purpose, this_chat), " +
      "plus this chat's links. Call it before suggestion_create to pick the chat a piece of work fits " +
      "best. `filter` keeps only entries matching its text.",
    parameters: {
      type: "object",
      properties: { filter: { type: "string", description: "Text a row must contain (any case), such as a label, folder or word of a purpose." } },
      additionalProperties: false,
    },
    async execute(args, ctx) {
      if (deps.passChat(ctx.chatId)) throw passError();
      const filter = argText(args.filter).trim().toLowerCase();
      const keep = (line: string) => !filter || line.toLowerCase().includes(filter);
      const agents = (await deps.agents()).filter((a) => keep(`${a.id} · ${a.name} · on ${a.mac}${a.reachable ? "" : ", out of reach"}`));
      const chats = openChats(deps.chats())
        .filter((d) => keep(chatLine(d, ctx.chatId)))
        .map((d) => ({
          conversation_id: d.conversation_id,
          agent_id: d.agent_id,
          agent_name: d.agent_name,
          title: d.title,
          cwd: d.cwd,
          home_name: d.home_name ?? null,
          reachable: d.reachable ?? true,
          labels: d.labels,
          pinned: d.pinned,
          last_active: d.last_active,
          purpose: d.purpose,
          this_chat: d.conversation_id === ctx.chatId,
        }));
      log("tool:chat_list", { agents: agents.length, chats: chats.length });
      const rawLinks = deps.messages ? deps.messages.linksOf(source(ctx)) : [];
      const me = source(ctx);
      const links = rawLinks
        .filter((l, i) => !filter || (linkLines([l], me)[0] ?? `#${i}`).toLowerCase().includes(filter))
        .map((l) => {
          const other = l.from.agent_id === me.agent_id && l.from.conversation_id === me.conversation_id ? l.to : l.from;
          return {
            agent_id: other.agent_id,
            conversation_id: other.conversation_id,
            title: other.title ?? null,
            direction: l.direction,
            expires_at: l.expires_at,
          };
        });
      return { agents, chats, links };
    },
  };

  const create: ModTool = {
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
    async execute(args, ctx) {
      if (deps.passChat(ctx.chatId)) throw passError();
      const target = parseSuggestionTarget(args.target);
      if (!target) throw new Error("suggestion_create needs a target: { agent_id, conversation_id } for an open chat, or { agent_id, folder } for a new one");
      const agents = await deps.agents();
      if (!agents.some((a) => a.id === target.agent_id))
        throw new Error(`no agent ${target.agent_id}: the agents are ${agents.map((a) => `${a.id} (${a.name})`).join(", ") || "none"}`);
      const chats = openChats(deps.chats());
      if ("conversation_id" in target) {
        const chat = chats.find((d) => d.conversation_id === target.conversation_id);
        if (!chat)
          throw new Error(
            `no open chat ${target.conversation_id}: the open chats are ${chats.map((d) => `${d.conversation_id} "${d.title ?? "untitled"}" (agent ${d.agent_id})`).join(", ") || "none"}`,
          );
        if (chat.agent_id !== target.agent_id) throw new Error(`chat ${target.conversation_id} belongs to agent ${chat.agent_id}, not ${target.agent_id}`);
      } else {
        const folders = [...new Set(chats.map((d) => d.cwd).filter((f): f is string => !!f))];
        if (!folders.includes(target.folder)) throw new Error(`no chat works in ${target.folder}: the folders are ${folders.join(", ") || "none"}`);
      }
      try {
        const made = await deps.suggestions.add(source(ctx), { title: argText(args.title), text: argText(args.text), target });
        log("tool:suggestion_create", { conversation: ctx.chatId, id: made.id });
        return `suggested ${made.id} "${made.title}": it waits for the person to send, save or reject it. Name it in one line of your reply.`;
      } catch (err) {
        return fail(err);
      }
    },
  };

  const message: ModTool = {
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
    async execute(args, ctx) {
      if (deps.passChat(ctx.chatId)) throw new Error("a background pass has no chat screen to ask the person in, so it cannot message chats");
      if (!deps.messages) throw new Error("chat links are not kept by this daemon");
      const target = { agent_id: argText(args.agent_id), conversation_id: argText(args.conversation_id) };
      if (!target.agent_id || !target.conversation_id) throw new Error("chat_message needs agent_id and conversation_id: list them with chat_list in a script");
      const chat = openChats(deps.chats()).find((d) => d.conversation_id === target.conversation_id);
      if (chat && chat.agent_id !== target.agent_id)
        throw new Error(`chat ${target.conversation_id} belongs to agent ${chat.agent_id}, not ${target.agent_id}`);
      const out = await deps.messages.send(source(ctx), target, argText(args.text), ctx.signal).catch(fail);
      log("tool:chat_message", { conversation: ctx.chatId, to: target.conversation_id, ok: out.ok });
      if (!out.ok) throw new Error(out.message);
      return out.message;
    },
  };

  return [chatList, create, ...(deps.messages ? [message] : [])].map((tool) => api.tools.register(tool));
}
