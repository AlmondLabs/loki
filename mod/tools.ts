import type { ModApi, ModTool, ToolContext } from "../daemon/mods/api.ts";
import type { ChatSummary } from "../core/frame-types.ts";
import { parseSuggestionTarget } from "../core/frames.ts";
import type { Suggestions } from "./suggestions.ts";
import { linkLines, type ChatMessages } from "./chat-links.ts";
import { messageOf } from "../core/errors.ts";
import { log } from "./log.ts";

export interface ToolDeps {
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

const SCRIPTS_ONLY = ["tools"] as const;

/** A tool argument as text: the model sends strings, and now and then a number; anything else is no text. */
export const argText = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "");

export function registerTools(api: ModApi, deps: ToolDeps): Array<() => void> {
  return deps.chats ? registerChatTools(api, deps.chats) : [];
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
