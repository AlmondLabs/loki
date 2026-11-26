import { messageOf } from "../core/errors.ts";
import type { ReplyProposal } from "../core/frame-types.ts";
import type { ChatState } from "../core/frames.ts";
import type { ModApi, ModTool, ToolContext } from "../daemon/mods/api.ts";
import { ownedAccount, type Accounts } from "./accounts.ts";
import type { ChatBackend } from "./frames/chat.ts";
import { inChatFolder } from "./google-tools/core.ts";
import { log } from "./log.ts";
import {
  MAX_REPLY_BYTES,
  MAX_REPLY_FILES,
  bytesWords,
  proposalLine,
  type NewConversationInput,
  type ReplyInput,
  type TicketInput,
} from "./reply-proposal-format.ts";
import type { ChatKey } from "./suggestions.ts";
import { argText } from "./tools.ts";

export interface ReplyToolBackend {
  open(chat: ChatKey): ReplyProposal[];
  propose(chat: ChatKey, input: ReplyInput): Promise<ReplyProposal>;
  proposeNew(chat: ChatKey, input: NewConversationInput): Promise<ReplyProposal>;
  proposeTicket(chat: ChatKey, input: TicketInput): Promise<ReplyProposal>;
  takeNotices(chat: ChatKey): string[];
}

export function registerReplyTools(api: ModApi, deps: { accounts: Pick<Accounts, "ownedBy">; replies: ReplyToolBackend }): Array<() => void> {
  const fail = (err: unknown): never => {
    throw err instanceof Error ? err : new Error(messageOf(err));
  };
  const forAgent = (agentId: string) => deps.accounts.ownedBy(agentId).length > 0;
  const chatOf = (ctx: ToolContext): ChatKey => ({ agent_id: ctx.agentId, conversation_id: ctx.chatId });

  const propose: ModTool = {
    name: "reply_propose",
    annotations: { readOnly: true },
    forAgent,
    description:
      "Propose a reply in a thread of an account you own: one the person handed to this chat, or one a script found " +
      "(flow_list, google_gmail_search, google_gmail_read, slack_read, jira_read). The person reviews it on a card, may edit " +
      "it or take its files off, and sends it from there as themselves; you cannot send it, and nothing goes before their " +
      "Send. It goes to the thread's own people (Gmail: reply-all to the newest message, with the person's signature; " +
      "Slack: the same conversation and thread; a channel or DM id, or #channel, posts a new message at the top of it, and " +
      "you then hear its `channel:ts` to answer in its thread), and to no one else but " +
      "the people in `mentions`. On a Jira site it is a comment on any ticket you can see, its files attached to the ticket. The thread " +
      "need not be in Flow. " +
      "You hear what became of it with the next message.",
    parameters: {
      type: "object",
      properties: {
        account: { type: "string", description: "The account's id or name, from the prompt's list of your accounts, a script or the hand-off." },
        thread: {
          type: "string",
          description:
            "The thread: Gmail's thread id (from the hand-off or a script); Slack's `channel:ts`, a channel or DM id, a message link or #channel; Jira's ticket key, id or link.",
        },
        text: { type: "string", description: "The reply, as plain text. Write each person in `mentions` into it as @<entry>." },
        mentions: {
          type: "array",
          items: { type: "string" },
          description:
            "People to mention, each as written after its @ in the text: a full name, an address, a Slack handle, or a token a refusal gave; a script's people_find looks them up first. Slack and Jira notify them; Gmail adds them to cc. A name that matches several people or nobody is refused with who matched: ask the person which one they mean. Any other @ in the text stays plain text.",
        },
        attachments: {
          type: "array",
          items: { type: "string" },
          description: `Files for the reply to carry, as paths in this chat's folder; at most ${String(MAX_REPLY_FILES)}, ${bytesWords(MAX_REPLY_BYTES)} together. A file from another mail gets there with google_gmail_attachment first.`,
        },
      },
      required: ["account", "thread", "text"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const name = argText(args.account);
      const account = ownedAccount(deps.accounts, ctx.agentId, name);
      if (!account) throw new Error(`this agent owns no account "${name}"`);
      const thread = argText(args.thread);
      if (!thread) throw new Error("reply_propose needs thread");
      try {
        const named = Array.isArray(args.attachments) ? args.attachments.map(argText).filter(Boolean) : [];
        const attachments = named.map((path) => inChatFolder(ctx, path));
        const p = await deps.replies.propose(chatOf(ctx), {
          account_id: account.account_id,
          thread_id: thread,
          text: argText(args.text),
          ...(attachments.length ? { attachments } : {}),
          ...(Array.isArray(args.mentions) ? { mentions: args.mentions.map(argText).filter(Boolean) } : {}),
        });
        log("tool:reply_propose", { agent: ctx.agentId, provider: p.provider });
        return `Proposed ${p.id}: it waits for the person to review and send it.\n${proposalLine(p)}`;
      } catch (err) {
        return fail(err);
      }
    },
  };

  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(argText).filter(Boolean) : []);
  const startNew: ModTool = {
    name: "message_propose",
    annotations: { readOnly: true },
    forAgent,
    description:
      "Propose a new conversation from an account you own: a new email from a Gmail account (`to`, `cc`, `subject`), or a " +
      "new Slack DM (`people`, one to eight). Name each person by full name or address, a Slack handle, or a token a " +
      "refusal or a script's people_find gave; a name that fits several people or nobody is refused with who matched: ask " +
      "the person which one they mean. The person reviews it on a card, may edit its words or take its files off, and " +
      "sends it from there as themselves; you cannot send it, and nothing goes, and no DM is opened, before their Send. " +
      "To answer an existing thread, or post in a channel you are in, use reply_propose. You hear what became of it, and " +
      "the new thread to answer, with the next message.",
    parameters: {
      type: "object",
      properties: {
        account: { type: "string", description: "The account's id or name, from the prompt's list of your accounts." },
        to: { type: "array", items: { type: "string" }, description: "Gmail: whom the email goes to." },
        cc: { type: "array", items: { type: "string" }, description: "Gmail: whom it copies." },
        subject: { type: "string", description: "Gmail: the email's subject." },
        people: { type: "array", items: { type: "string" }, description: "Slack: the people of the new DM, one to eight." },
        text: { type: "string", description: "The message, as plain text. Write each person in `mentions` into it as @<entry>." },
        mentions: {
          type: "array",
          items: { type: "string" },
          description: "People to mention in the text, as for reply_propose: Slack notifies them; Gmail adds them to cc.",
        },
        attachments: {
          type: "array",
          items: { type: "string" },
          description: `Files to carry, as paths in this chat's folder; at most ${String(MAX_REPLY_FILES)}, ${bytesWords(MAX_REPLY_BYTES)} together.`,
        },
      },
      required: ["account", "text"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const name = argText(args.account);
      const account = ownedAccount(deps.accounts, ctx.agentId, name);
      if (!account) throw new Error(`this agent owns no account "${name}"`);
      try {
        const attachments = strings(args.attachments).map((path) => inChatFolder(ctx, path));
        const common = {
          account_id: account.account_id,
          text: argText(args.text),
          ...(attachments.length ? { attachments } : {}),
          mentions: strings(args.mentions),
        };
        if (account.provider === "jira") throw new Error("a Jira site starts no conversation here: comment on a ticket with reply_propose");
        const input: NewConversationInput =
          account.provider === "gmail"
            ? { ...common, kind: "email", to: strings(args.to), cc: strings(args.cc), subject: argText(args.subject) }
            : { ...common, kind: "dm", people: strings(args.people) };
        const p = await deps.replies.proposeNew(chatOf(ctx), input);
        log("tool:message_propose", { agent: ctx.agentId, provider: p.provider, kind: p.kind ?? null });
        return `Proposed ${p.id}: it waits for the person to review and send it.\n${proposalLine(p)}`;
      } catch (err) {
        return fail(err);
      }
    },
  };

  const newTicket: ModTool = {
    name: "ticket_propose",
    annotations: { readOnly: true },
    forAgent: (agentId) => deps.accounts.ownedBy(agentId).some((a) => a.provider === "jira"),
    description:
      "Propose a new Jira ticket on a site you own: `project` (its key or name) and `type` (an issue type of it, as jira_projects lists), a " +
      "`title` and a `description`, and if wanted an `assignee` (a full name or account id), a `priority`, `labels` and a `parent` " +
      "ticket's key (which a sub-task needs). A project that requires another field is refused with the field's name: the person creates " +
      "that ticket in Jira. The person reviews it on a card, may edit its title and description, and creates it from there as " +
      "themselves; you cannot create it, and nothing is made before their Send. You hear the new ticket's key with the next message.",
    parameters: {
      type: "object",
      properties: {
        account: { type: "string", description: "The Jira site's account id or name, from the prompt's list of your accounts." },
        project: { type: "string", description: "The project's key (OPS) or name." },
        type: { type: "string", description: "The issue type's name (Task, Bug, …)." },
        title: { type: "string", description: "The ticket's title." },
        description: { type: "string", description: "The description, as plain text. Write each person in `mentions` into it as @<entry>." },
        assignee: {
          type: "string",
          description: "Whom it is assigned to: a full name or a Jira account id; one who fits several is refused with who matched.",
        },
        priority: { type: "string", description: "A priority's name, as jira_projects lists them." },
        labels: { type: "array", items: { type: "string" }, description: "Labels, each one word." },
        parent: { type: "string", description: "The key of the ticket it goes under, which a sub-task needs." },
        mentions: { type: "array", items: { type: "string" }, description: "People to mention in the description, as for reply_propose: Jira notifies them." },
      },
      required: ["account", "project", "type", "title", "description"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const name = argText(args.account);
      const account = ownedAccount(deps.accounts, ctx.agentId, name);
      if (!account) throw new Error(`this agent owns no account "${name}"`);
      try {
        const optional = (key: string) => (argText(args[key]) ? { [key]: argText(args[key]) } : {});
        const p = await deps.replies.proposeTicket(chatOf(ctx), {
          account_id: account.account_id,
          project: argText(args.project),
          type: argText(args.type),
          title: argText(args.title),
          description: argText(args.description),
          ...optional("assignee"),
          ...optional("priority"),
          ...optional("parent"),
          labels: strings(args.labels),
          mentions: strings(args.mentions),
        });
        log("tool:ticket_propose", { agent: ctx.agentId });
        return `Proposed ${p.id}: it waits for the person to review and create it.\n${proposalLine(p)}`;
      } catch (err) {
        return fail(err);
      }
    },
  };

  const disposers = [propose, startNew, newTicket].map((tool) => api.tools.register(tool));
  disposers.push(
    api.message.transform((m) => {
      const notices = deps.replies.takeNotices({ agent_id: m.agentId, conversation_id: m.chatId });
      if (notices.length === 0) return undefined;
      const block = notices.map((n) => `<system-reminder>${n}</system-reminder>`).join("\n");
      return typeof m.content === "string" ? `${m.content}\n\n${block}` : [...m.content, { type: "text", text: block }];
    }),
    api.prompt.section("replies", ({ agentId }) => {
      const owned = new Set(deps.accounts.ownedBy(agentId).map((a) => a.provider));
      if (owned.size === 0) return undefined;
      const start = [
        owned.has("gmail") || owned.has("slack") ? "to start a new email or Slack DM, use message_propose" : "",
        owned.has("jira") ? "to open a new Jira ticket, use ticket_propose" : "",
      ].filter(Boolean);
      return `To answer a thread in an account you own, handed to you, found with a script, or named by the person (an id, a link, a #channel, a Jira key), or to post in a channel you are in, use reply_propose${start.length ? `; ${start.join("; ")}` : ""}. Use \`attachments\` for files and \`mentions\` for the people a message should tell: the person reviews it on a card and sends it from there; you cannot send it. When a name fits several people, ask the person which one they mean. Never send mail, Slack messages or Jira comments any other way.`;
    }),
  );
  return disposers;
}

export function withRepliesOnOpen(backend: ChatBackend, replies: Pick<ReplyToolBackend, "open">): ChatBackend {
  const open = async (agentId: string, conversationId: string, mode: string | null): Promise<ChatState> => {
    const state = await backend.open(agentId, conversationId, mode);
    return { ...state, reply_proposals: replies.open({ agent_id: agentId, conversation_id: conversationId }) };
  };
  return new Proxy(backend, {
    get: (target, prop, receiver) => {
      if (prop === "open") return open;
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
