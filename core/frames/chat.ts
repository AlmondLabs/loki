import { Type } from "typebox";
import { parseLink, isLinkDuration } from "../chat-links.ts";
import { LABEL_COLORS, chatLabels, labelName } from "../labels.ts";
import type { ReasoningEffort } from "../models.ts";
import type { SavedDraft } from "../frame-types.ts";
import {
  AgentIdSchema,
  EngineIdSchema,
  NonEmptyStr,
  ShaSchema,
  agent,
  allStrings,
  chatRef,
  compiledCheck,
  isAgentId,
  isInstant,
  isNum,
  linkEnd,
  lokiMode,
  nothing,
  parseSuggestionTarget,
  replyMentionOf,
  str,
  strOr,
  strings,
  type Raw,
} from "./primitives.ts";
import { BY_CHAT, BY_CHAT_RELISTED, PHONE, push, request } from "./types.ts";

const SuggestionActionSchema = Type.Union([Type.Literal("send"), Type.Literal("draft"), Type.Literal("reject")]);
const ReplyActionSchema = Type.Union([Type.Literal("approve"), Type.Literal("undo"), Type.Literal("reject")]);
const SavedDraftSchema = Type.Object({
  text: NonEmptyStr,
  suggestion_id: Type.String(),
  source: Type.Object({
    agent_id: AgentIdSchema,
    conversation_id: NonEmptyStr,
  }),
});

const checkSuggestionAction = compiledCheck(SuggestionActionSchema);
const checkReplyAction = compiledCheck(ReplyActionSchema);
const checkSavedDraft = compiledCheck(SavedDraftSchema);
const checkSha = compiledCheck(ShaSchema);
const checkEngineId = compiledCheck(EngineIdSchema);
const checkNonEmpty = compiledCheck(NonEmptyStr);

const stringRecord = (v: unknown): Record<string, string> | null => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) {
    if (typeof x !== "string") return null;
    out[k] = x;
  }
  return out;
};

function mcpEdit(
  v: unknown,
): { command: string; args: string[]; env: Record<string, string>; cwd: string | null } | { url: string; headers: Record<string, string> } | null | string {
  if (v === null) return null;
  if (!v || typeof v !== "object") return "edit required (or null to remove)";
  const e = v as Raw;
  if (str(e.command)) {
    const env = e.env === undefined ? {} : stringRecord(e.env);
    return env ? { command: e.command, args: strings(e.args), env, cwd: strOr(e.cwd, null) } : "env must map names to strings";
  }
  if (str(e.url)) {
    const headers = e.headers === undefined ? {} : stringRecord(e.headers);
    return headers ? { url: e.url, headers } : "headers must map names to strings";
  }
  return "a server needs a command or a url";
}

const savedDraft = (v: unknown): SavedDraft | null => {
  if (!checkSavedDraft(v)) return null;
  return {
    text: v.text,
    suggestion_id: v.suggestion_id,
    source: { agent_id: v.source.agent_id, conversation_id: v.source.conversation_id },
  };
};

const suggestionRef = (m: Raw): { agent_id: string; conversation_id: string; suggestion_id: string } | string => {
  const c = chatRef(m);
  if (typeof c === "string") return c;
  return checkNonEmpty(m.suggestion_id) ? { ...c, suggestion_id: m.suggestion_id } : "suggestion_id required";
};

export const chatFrames = {
  history_get: request(
    "history",
    "up to `limit` rows of a chat's log before position `before` (its newest without), where they start, and whether older ones remain",
    (m: Raw) =>
      str(m.conversation_id)
        ? {
            agent_id: strOr(m.agent_id, null),
            conversation_id: m.conversation_id,
            limit: isNum(m.limit) ? m.limit : null,
            before: isNum(m.before) && m.before >= 0 ? m.before : null,
          }
        : "conversation_id required",
    PHONE,
    BY_CHAT,
  ),
  history_step_get: request(
    "history_step",
    "the whole step (input and output) of the tool row, or the whole detail of the event, at position `row` of a chat's log, which a history page sent lean",
    (m: Raw) =>
      str(m.conversation_id) && isNum(m.row) && m.row >= 0
        ? { agent_id: strOr(m.agent_id, null), conversation_id: m.conversation_id, row: Math.floor(m.row) }
        : "conversation_id and row required",
    PHONE,
    BY_CHAT,
  ),
  flow_get: request("flow", "every open conversation from disk, with who spoke last", nothing, PHONE),

  chat_open: request(
    "chat_state",
    "follow a chat: its state now, then its chat_event pushes; `mode` sets its permission mode",
    (m: Raw) => {
      const c = chatRef(m);
      return typeof c === "string" ? c : { ...c, mode: strOr(m.mode, null) };
    },
    PHONE,
    BY_CHAT,
  ),
  chat_approve: request(
    "chat_accepted",
    "the person's decision on a tool call the chat asked about",
    (m: Raw) => {
      const c = chatRef(m);
      if (typeof c === "string") return c;
      return str(m.approval_id) && typeof m.allow === "boolean"
        ? { ...c, approval_id: m.approval_id, allow: m.allow, message: strOr(m.message, null), always: m.always === true }
        : "approval_id and allow required";
    },
    PHONE,
    BY_CHAT,
  ),
  chat_answer: request(
    "chat_accepted",
    "the person's answers to a question card (the tool input with `answers` filled in)",
    (m: Raw) => {
      const c = chatRef(m);
      if (typeof c === "string") return c;
      return str(m.question_id) && m.input && typeof m.input === "object"
        ? { ...c, question_id: m.question_id, input: m.input as Raw }
        : "question_id and input required";
    },
    PHONE,
    BY_CHAT,
  ),
  chat_create: request(
    "chat_created",
    "a new chat for an agent, in a folder; `home` is the Mac it lives on, else its agent's when that Mac is in reach",
    (m: Raw) =>
      isAgentId(m.agent_id) ? { agent_id: m.agent_id, cwd: strOr(m.cwd, null), title: strOr(m.title, null), home: strOr(m.home, null) } : "agent_id required",
    PHONE,
    { route: "new-chat", relists: true },
  ),
  chat_send: request(
    "chat_accepted",
    "a message from the person; when the chat is busy, queued for after the turn, or with steer put into it; sent once per send_id",
    (m: Raw) => {
      const c = chatRef(m);
      if (typeof c === "string") return c;
      if (!str(m.text)) return "text required";
      const images = Array.isArray(m.images)
        ? (m.images as Raw[]).filter((i) => str(i.media_type) && str(i.data)).map((i) => ({ media_type: i.media_type as string, data: i.data as string }))
        : [];
      return { ...c, text: m.text, images, send_id: strOr(m.send_id, null), context: strOr(m.context, null), ...(m.steer === true ? { steer: true } : {}) };
    },
    PHONE,
    BY_CHAT,
  ),
  chat_abort: request("chat_done", "stop the chat's turn", chatRef, PHONE, BY_CHAT),
  suggestion_decide: request(
    "suggestion_decided",
    "send a suggestion made in this chat, save it as a draft in its target's box, or reject it; the first action wins",
    (m: Raw) => {
      const r = suggestionRef(m);
      if (typeof r === "string") return r;
      return checkSuggestionAction(m.action) ? { ...r, action: m.action } : "action must be send, draft or reject";
    },
    PHONE,
    BY_CHAT,
  ),
  suggestion_retarget: request(
    "suggestion_decided",
    "point a pending suggestion made in this chat at another chat, or at a new chat of an agent in a folder",
    (m: Raw) => {
      const r = suggestionRef(m);
      if (typeof r === "string") return r;
      const target = parseSuggestionTarget(m.target);
      return target ? { ...r, target } : "target needs agent_id and a conversation_id or a folder";
    },
    PHONE,
    BY_CHAT,
  ),
  reply_people_find: request(
    "reply_people_found",
    "the people of a proposed reply's account whose names match `query` (plan 2026-11-14-1530, R18), for the card's @ picker: on Jira those who can see the ticket, on Slack marked when they are not in the conversation; answered by the Mac the chat lives on, which holds the account",
    (m: Raw) => {
      const c = chatRef(m);
      if (typeof c === "string") return c;
      if (!checkNonEmpty(m.proposal_id)) return "proposal_id required";
      if (!str(m.query) || !m.query.trim() || m.query.length > 100) return "query required";
      return { ...c, proposal_id: m.proposal_id, query: m.query };
    },
    PHONE,
    BY_CHAT,
  ),
  reply_decide: request(
    "reply_decided",
    "send a reply its agent proposed in this chat (`approve`, with `text` as edited and `files`, the names of the files kept; all of them when left out), held 10 seconds before it goes in its thread; `undo` it while it is held; or reject it; the first action wins, and the answer comes at once, with the reply's fate pushed as the chat's `reply_proposals` event (plan 2026-11-14-1134)",
    (m: Raw) => {
      const c = chatRef(m);
      if (typeof c === "string") return c;
      if (!checkNonEmpty(m.proposal_id)) return "proposal_id required";
      if (!checkReplyAction(m.action)) return "action must be approve, undo or reject";
      if (m.files !== undefined && m.files !== null && !allStrings(m.files)) return "files must be a list of file names";
      const files = allStrings(m.files) ? m.files : null;
      if (m.mentions !== undefined && m.mentions !== null && !(Array.isArray(m.mentions) && m.mentions.every((x: unknown) => replyMentionOf(x) !== null)))
        return "mentions must be a list of people, each with a display name and an id or address";
      const mentions = Array.isArray(m.mentions) ? m.mentions.flatMap((x: unknown) => replyMentionOf(x) ?? []) : null;
      if (m.title !== undefined && m.title !== null && (!str(m.title) || m.title.length > 255)) return "title must be text of 255 characters at most";
      const title = str(m.title) && m.title.trim() ? m.title : null;
      return { ...c, proposal_id: m.proposal_id, action: m.action, text: str(m.text) ? m.text : null, files, mentions, title };
    },
    PHONE,
    BY_CHAT,
  ),
  chat_message: request(
    "chat_accepted",
    "a message from another chat's agent along a link: delivered only when a live link on this Mac allows it",
    (m: Raw) => {
      const c = chatRef(m);
      if (typeof c === "string") return c;
      const from = linkEnd(m.from);
      if (!from || !str(m.text) || !checkNonEmpty(m.send_id)) return "from, text and send_id required";
      return { ...c, from, text: m.text, send_id: m.send_id, cap: lokiMode(m.cap) };
    },
    false,
    BY_CHAT,
  ),
  chat_link_put: request(
    "chat_accepted",
    "keep a link one of this Mac's chats has, opened on the other chat's Mac",
    (m: Raw) => {
      const c = chatRef(m);
      if (typeof c === "string") return c;
      const link = parseLink(m.link);
      return link ? { ...c, link } : "link required";
    },
    false,
    BY_CHAT,
  ),
  chat_link_close: request(
    "chat_accepted",
    "close a link of this chat, here and on the other chat's Mac",
    (m: Raw) => {
      const c = chatRef(m);
      if (typeof c === "string") return c;
      return checkNonEmpty(m.link_id) ? { ...c, link_id: m.link_id } : "link_id required";
    },
    PHONE,
    BY_CHAT,
  ),
  chat_links_get: request("chat_links", "the live links of this Mac's chats, and the duration the link card starts on", nothing),
  chat_links_default: request("chat_links", "the duration the link card starts on: hour, day or always", (m: Raw) =>
    isLinkDuration(m.duration) ? { duration: m.duration } : "duration must be hour, day or always",
  ),
  chat_update: request(
    "chat_done",
    "rename, archive or hide a chat, or set its labels, purpose line or saved draft",
    (m: Raw) => {
      const c = chatRef(m);
      if (typeof c === "string") return c;
      if (m.purpose !== undefined && m.purpose !== null && !str(m.purpose)) return "purpose must be text";
      const draft = m.draft === undefined || m.draft === null ? m.draft : savedDraft(m.draft);
      if (draft === null && m.draft !== null) return "draft needs text, suggestion_id and source";
      return {
        ...c,
        title: m.title === null || str(m.title) ? m.title : undefined,
        archived: typeof m.archived === "boolean" ? m.archived : undefined,
        hidden: typeof m.hidden === "boolean" ? m.hidden : undefined,
        labels: Array.isArray(m.labels) ? chatLabels(strings(m.labels)) : undefined,
        ...(m.purpose !== undefined ? { purpose: (str(m.purpose) && m.purpose.replace(/\s+/g, " ").trim()) || null } : {}),
        ...(draft !== undefined ? { draft } : {}),
      };
    },
    PHONE,
    BY_CHAT_RELISTED,
  ),
  chat_folder: request(
    "chat_state",
    "move a chat to another folder",
    (m: Raw) => {
      const c = chatRef(m);
      return typeof c === "string" ? c : checkNonEmpty(m.cwd) ? { ...c, cwd: m.cwd } : "cwd required";
    },
    PHONE,
    BY_CHAT_RELISTED,
  ),
  chat_model: request(
    "chat_done",
    "the model and reasoning effort a chat runs with",
    (m: Raw) => {
      const c = chatRef(m);
      if (typeof c === "string") return c;
      return checkNonEmpty(m.handle)
        ? { ...c, handle: m.handle, reasoning_effort: strOr(m.reasoning_effort, null) as ReasoningEffort | null }
        : "handle required";
    },
    PHONE,
    BY_CHAT_RELISTED,
  ),
  chat_models: request("chat_models", "the models the connected providers offer", nothing, PHONE),
  chat_agents: request("chat_agents", "the person's agents", nothing, PHONE),
  chat_agent_create: request("chat_agent_created", "a new agent, with its main chat; `persona` is who it is, written to its memory", (m: Raw) =>
    str(m.name) && m.name.trim()
      ? { name: m.name.trim(), description: strOr(m.description, null), persona: strOr(m.persona, null), model: strOr(m.model, null) }
      : "name required",
  ),
  chat_agent_update: request("chat_done", "an agent's name, description, model, or home Mac", (m: Raw) => {
    if (!isAgentId(m.agent_id)) return "agent_id required";
    return {
      agent_id: m.agent_id,
      name: strOr(m.name, undefined),
      description: strOr(m.description, undefined),
      model: strOr(m.model, undefined),
      home_mac: strOr(m.home_mac, undefined),
    };
  }),
  chat_agent_delete: request("chat_done", "delete an agent, its memory and its chats", agent),
  chat_passes_get: request(
    "chat_passes",
    "whether reflection and Learn run in the background, Learn's cards a day, and whether they run on an ACP agent when no loki model can",
    nothing,
  ),
  chat_passes_set: request("chat_passes", "turn reflection, Learn or their ACP fallback on or off, or set Learn's cards a day", (m: Raw) => {
    const part = (v: unknown) => (v && typeof v === "object" ? (v as Raw) : undefined);
    const r = part(m.reflection),
      l = part(m.learn),
      a = part(m.acp);
    if (r?.enabled !== undefined && typeof r.enabled !== "boolean") return "reflection.enabled must be true or false";
    if (a?.enabled !== undefined && typeof a.enabled !== "boolean") return "acp.enabled must be true or false";
    if (l?.enabled !== undefined && typeof l.enabled !== "boolean") return "learn.enabled must be true or false";
    if (l?.daily_cap !== undefined && !(isNum(l.daily_cap) && l.daily_cap >= 0)) return "learn.daily_cap must be a number, 0 or more";
    return {
      ...(r?.enabled !== undefined ? { reflection: { enabled: r.enabled } } : {}),
      ...(a?.enabled !== undefined ? { acp: { enabled: a.enabled } } : {}),
      ...(l
        ? {
            learn: {
              ...(l.enabled !== undefined ? { enabled: l.enabled } : {}),
              ...(l.daily_cap !== undefined ? { daily_cap: Math.floor(l.daily_cap) } : {}),
            },
          }
        : {}),
    };
  }),
  chat_command: request(
    "chat_command_done",
    "run a slash command in a chat: compact, clear, remember, reflect, or doctor",
    (m: Raw) => {
      const c = chatRef(m);
      if (typeof c === "string") return c;
      return checkNonEmpty(m.command) ? { ...c, command: m.command, args: strOr(m.args, null) } : "command required";
    },
    PHONE,
  ),
  chat_memory_write: request("chat_done", "write a memory file (null content removes it), committed as yours", (m: Raw) =>
    isAgentId(m.agent_id) && checkNonEmpty(m.path)
      ? { agent_id: m.agent_id, path: m.path, content: m.content === null ? null : strOr(m.content, ""), message: strOr(m.message, undefined) }
      : "agent_id and path required",
  ),
  chat_memory_revert: request("chat_done", "undo one memory commit with a new commit, as yours", (m: Raw) =>
    isAgentId(m.agent_id) && checkSha(m.sha) ? { agent_id: m.agent_id, sha: m.sha } : "agent_id and a commit sha required",
  ),
  chat_approvals_get: request("chat_approvals", "the tools you always allow", nothing),
  chat_approvals_set: request("chat_approvals", "always allow a tool, or take that back", (m: Raw) =>
    checkNonEmpty(m.tool) && typeof m.on === "boolean" ? { tool: m.tool, on: m.on } : "tool and on required",
  ),
  chat_labels_get: request("chat_labels", "every label on a chat, its colour and how many chats carry it", nothing, PHONE),
  chat_label_set: request("chat_labels", "rename, recolour or delete a label on every chat that carries it", (m: Raw) => {
    const name = str(m.name) ? labelName(m.name) : null;
    if (!name) return "name required";
    if (m.remove === true) return { name, remove: true as const };
    const rename = str(m.rename) ? labelName(m.rename) : null;
    if (str(m.rename) && !rename) return "rename to a label of letters, digits or dashes";
    const color = typeof m.color === "number" && Number.isInteger(m.color) && m.color >= 0 && m.color < LABEL_COLORS ? m.color : null;
    return rename || color !== null ? { name, ...(rename ? { rename } : {}), ...(color !== null ? { color } : {}) } : "rename, color or remove required";
  }),
  chat_engines_get: request("chat_engines", "the ACP agents a chat can run on, and how each stands", nothing),
  chat_engine_set: request("chat_engines", "add or change an ACP agent: its name and how loki starts it", (m: Raw) =>
    checkEngineId(m.id) && str(m.name) && m.name.trim() && str(m.command) && m.command.trim()
      ? { id: m.id, name: m.name.trim(), command: m.command.trim(), args: strings(m.args) }
      : "id (lowercase letters, digits and dashes), name and command required",
  ),
  chat_engine_remove: request("chat_engines", "remove an ACP agent, or put a built-in one back as loki ships it", (m: Raw) =>
    checkNonEmpty(m.id) ? { id: m.id } : "id required",
  ),
  chat_engine_check: request("chat_engines", "start an ACP agent now, to see that it starts", (m: Raw) => (checkNonEmpty(m.id) ? { id: m.id } : "id required")),
  chat_mcp_get: request("chat_mcp", "the MCP servers: state, tools and their costs, who has each switched off", nothing),
  chat_mcp_server: request("chat_mcp", "add, change, rename or remove an MCP server in mcp.json", (m: Raw) => {
    if (!str(m.entry) || !m.entry.trim()) return "entry required";
    const edit = mcpEdit(m.edit);
    if (typeof edit === "string") return edit;
    return { entry: m.entry, edit, rename: strOr(m.rename, null) };
  }),
  chat_mcp_always_load: request("chat_mcp", "the tools of an MCP server that skip search", (m: Raw) =>
    checkNonEmpty(m.entry) ? { entry: m.entry, tools: strings(m.tools) } : "entry required",
  ),
  chat_mcp_restart: request("chat_mcp", "start an MCP server again now", (m: Raw) => (checkNonEmpty(m.name) ? { name: m.name } : "name required")),
  chat_mcp_signout: request("chat_mcp", "forget a remote MCP server's sign-in", (m: Raw) => (checkNonEmpty(m.name) ? { name: m.name } : "name required")),
  chat_mcp_agent: request("chat_mcp", "switch an MCP server on or off for one agent", (m: Raw) =>
    isAgentId(m.agent_id) && checkNonEmpty(m.server) && typeof m.on === "boolean"
      ? { agent_id: m.agent_id, server: m.server, on: m.on }
      : "agent_id, server and on required",
  ),
  chat_mcp_secret: request("chat_mcp_secret", "keep a value in the keychain for mcp.json to name", (m: Raw) =>
    checkNonEmpty(m.name) && checkNonEmpty(m.value) ? { name: m.name, value: m.value } : "name and value required",
  ),
  chat_skill_enable: request("chat_skill_enabled", "make a skill folder global: a link to it in the global skills folder", (m: Raw) =>
    checkNonEmpty(m.path) ? { path: m.path } : "path required",
  ),
  chat_skill_disable: request("chat_done", "take a global skill away: its link in the global skills folder", (m: Raw) =>
    checkNonEmpty(m.name) && !m.name.includes("/") && !m.name.includes("..") ? { name: m.name } : "a skill name required",
  ),
  chat_providers: request("chat_providers", "the model providers, connected or not", nothing),
  chat_provider_connect: request("chat_providers", "keep a provider's API key, once the provider accepts it", (m: Raw) =>
    checkNonEmpty(m.provider_id) && str(m.api_key) ? { provider_id: m.provider_id, api_key: m.api_key } : "provider_id and api_key required",
  ),
  chat_provider_disconnect: request("chat_providers", "forget a provider's credential", (m: Raw) =>
    checkNonEmpty(m.provider_id) ? { provider_id: m.provider_id } : "provider_id required",
  ),
  chat_provider_signin: request(
    "chat_signin",
    "start signing in to a provider: the page to open; the credential is kept when the browser comes back. With `code`, the address the browser ended on, for a sign-in still waiting",
    (m: Raw) => (checkNonEmpty(m.provider_id) ? { provider_id: m.provider_id, code: strOr(m.code, null) } : "provider_id required"),
  ),
  usage_get: request(
    "usage",
    "what the agents spent from `since` up to `until` (ISO instants): the ledger's hourly rows and each model's price status",
    (m: Raw) => (isInstant(m.since) && isInstant(m.until) ? { since: m.since, until: m.until } : "since and until required, as ISO instants"),
    PHONE,
  ),

  lists_changed: push("another Mac's chats changed, or it came into or out of reach: ask for the lists again"),
  chat_changed: push("a chat on this Mac was renamed, archived, hidden, relabelled or given a purpose or draft: ask for the lists again", { lists: true }),
  chat_event: push("what happened in a chat a client has open", {
    relay: "chat",
    lists: ["loop", "turn_end", "approval", "question", "error", "device", "reply_proposals"],
  }),
  usage_changed: push("the usage ledger counted more: open usage pages refetch"),
  error: push("a failed request (with its request_id) or a frame the mod could not take"),
} as const;
