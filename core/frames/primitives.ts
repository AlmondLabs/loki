import { Type, type Static, type TObject, type TSchema } from "typebox";
import { Compile } from "typebox/compile";
import type { Gesture } from "../canvas-core.ts";
import type { LanVia, OutsideChange, OutsideMessageChange, ReplyMention, SuggestionTarget } from "../frame-types.ts";
import { isPermissionMode, type PermissionMode } from "../chat-links.ts";
import type { NoPayload, Parse, Raw } from "./types.ts";
export type { NoPayload, Parse, Raw } from "./types.ts";

export const str = (v: unknown): v is string => typeof v === "string";
export const strOr = <T>(v: unknown, or: T): string | T => (typeof v === "string" ? v : or);
export const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter(str) : []);
export const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
export const allStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(str);
export const nothing = (): NoPayload => ({});

export const NonEmptyStr = Type.String({ minLength: 1 });
export const AgentIdSchema = Type.String({ pattern: "^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$" });
export const LanViaSchema = Type.Union([Type.Literal("tailscale"), Type.Literal("lan")]);
export const ShaSchema = Type.String({ pattern: "^[0-9a-fA-F]{7,40}$" });
export const EngineIdSchema = Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$" });
export const LearnIdSchema = Type.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" });
export const OutboxIdSchema = Type.String({ pattern: "^[\\w-]{8,64}$" });
export const ThreadTsSchema = Type.String({ pattern: "^\\d{1,12}\\.\\d{1,8}$" });
export const EmojiNameSchema = Type.String({ pattern: "^[\\w+'-]{1,100}(::skin-tone-[2-6])?$" });

const checkAgentId = Compile(AgentIdSchema);
export function isAgentId(id: unknown): id is string {
  return checkAgentId.Check(id);
}

const checkLanVia = Compile(LanViaSchema);
export const isLanVia = (v: unknown): v is LanVia => checkLanVia.Check(v);

const PointSchema = Type.Object({ x: Type.Number(), y: Type.Number() });
const SizeSchema = Type.Object({ w: Type.Number(), h: Type.Number() });
export const GestureSchema = Type.Union([
  Type.Object({ id: NonEmptyStr, kind: Type.Literal("move"), position: PointSchema }),
  Type.Object({ id: NonEmptyStr, kind: Type.Literal("resize"), size: SizeSchema }),
  Type.Object({ id: NonEmptyStr, kind: Type.Literal("focus") }),
  Type.Object({ id: NonEmptyStr, kind: Type.Literal("close") }),
  Type.Object({ id: NonEmptyStr, kind: Type.Literal("open") }),
  Type.Object({ id: NonEmptyStr, kind: Type.Literal("set"), path: NonEmptyStr }),
]);
const checkGesture = Compile(GestureSchema);

/** Whether a value is a well-formed gesture from the canvas, the only state change a tab may ask for; anything else is refused before it reaches a desk. */
export function isGesture(v: unknown): v is Gesture {
  return checkGesture.Check(v);
}

export const SuggestionTargetExistingSchema = Type.Object({ agent_id: AgentIdSchema, conversation_id: NonEmptyStr });
export const SuggestionTargetNewSchema = Type.Object({ agent_id: AgentIdSchema, folder: NonEmptyStr });
const checkExistingTarget = Compile(SuggestionTargetExistingSchema);
const checkNewTarget = Compile(SuggestionTargetNewSchema);

export function parseSuggestionTarget(v: unknown): SuggestionTarget | null {
  if (!v || typeof v !== "object") return null;
  const t = v as Raw;
  if (checkExistingTarget.Check(t)) return { agent_id: t.agent_id, conversation_id: t.conversation_id };
  if (checkNewTarget.Check(t)) return { agent_id: t.agent_id, folder: t.folder };
  return null;
}

export const ReplyMentionSchema = Type.Object({
  display: NonEmptyStr,
  id: Type.Union([NonEmptyStr, Type.Null()]),
  address: Type.Union([NonEmptyStr, Type.Null()]),
  not_member: Type.Optional(Type.Literal(true)),
});

export const replyMentionOf = (v: unknown): ReplyMention | null => {
  const m = typeof v === "object" && v !== null ? (v as Raw) : {};
  if (!str(m.display) || !m.display.trim()) return null;
  const id = str(m.id) && m.id ? m.id : null;
  const address = str(m.address) && m.address ? m.address : null;
  if (!id && !address) return null;
  return { display: m.display, id, address, ...(m.not_member === true ? { not_member: true } : {}) };
};

export const MarkSchema = Type.Object({
  agent_id: Type.Union([Type.String(), Type.Null()]),
  conversation_id: NonEmptyStr,
});
export const ChatRefSchema = Type.Object({
  agent_id: AgentIdSchema,
  conversation_id: NonEmptyStr,
});
export const AgentSchema = Type.Object({
  agent_id: AgentIdSchema,
});
export const ThreadRefSchema = Type.Object({
  account_id: NonEmptyStr,
  thread_id: NonEmptyStr,
  home: Type.Union([Type.String(), Type.Null()]),
});

export const mark = (m: Raw): Static<typeof MarkSchema> | string =>
  str(m.conversation_id) && m.conversation_id ? { agent_id: strOr(m.agent_id, null), conversation_id: m.conversation_id } : "conversation_id required";

export const agent = (m: Raw): Static<typeof AgentSchema> | string => (isAgentId(m.agent_id) ? { agent_id: m.agent_id } : "agent_id required");

export const chatRef = (m: Raw): Static<typeof ChatRefSchema> | string =>
  isAgentId(m.agent_id) && str(m.conversation_id) && m.conversation_id
    ? { agent_id: m.agent_id, conversation_id: m.conversation_id }
    : "agent_id and conversation_id required";

export const threadRef = (m: Raw): Static<typeof ThreadRefSchema> | string =>
  str(m.account_id) && m.account_id && str(m.thread_id) && m.thread_id
    ? { account_id: m.account_id, thread_id: m.thread_id, home: strOr(m.home, null) }
    : "account_id and thread_id required";

export const linkEnd = (v: unknown): { agent_id: string; conversation_id: string; title: string | null } | null => {
  const e = typeof v === "object" && v !== null ? (v as Raw) : {};
  return isAgentId(e.agent_id) && str(e.conversation_id) && e.conversation_id
    ? { agent_id: e.agent_id, conversation_id: e.conversation_id, title: strOr(e.title, null) }
    : null;
};

/** A permission mode as a chat message's cap names it; anything else is no cap known, which the receiver treats as strict. */
export const lokiMode = (v: unknown): PermissionMode | null => (isPermissionMode(v) ? v : null);

export const OutsideChangeSchema = Type.Object({
  move: Type.Union([Type.Literal("archive"), Type.Literal("read"), Type.Literal("unread"), Type.Literal("label")]),
  messages: Type.Array(
    Type.Object({
      message_id: NonEmptyStr,
      labels_added: Type.Array(Type.String()),
      labels_removed: Type.Array(Type.String()),
    }),
  ),
  ended: Type.Boolean(),
  was_unread: Type.Boolean(),
});
const checkOutsideChange = Compile(OutsideChangeSchema);

export function parseOutsideChange(v: unknown): OutsideChange | null {
  if (!checkOutsideChange.Check(v)) return null;
  const messages: OutsideMessageChange[] = v.messages.map((m) => ({
    message_id: m.message_id,
    labels_added: [...m.labels_added],
    labels_removed: [...m.labels_removed],
  }));
  return { move: v.move, messages, ended: v.ended, was_unread: v.was_unread };
}

export function compiledParser<S extends TObject>(schema: S, error: string): Parse<Static<S>> {
  const validator = Compile(schema);
  const keys = Object.keys(schema.properties);
  return (m: Raw) => {
    if (!validator.Check(m)) return error;
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      if (Object.hasOwn(m, k) && m[k] !== undefined) out[k] = m[k];
    }
    return out as Static<S>;
  };
}

export function compiledCheck<S extends TSchema>(schema: S): (v: unknown) => v is Static<S> {
  const validator = Compile(schema);
  return (v: unknown): v is Static<S> => validator.Check(v);
}

export const InstantSchema = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T" });
const checkInstantFormat = Compile(InstantSchema);
export const isInstant = (v: unknown): v is string => checkInstantFormat.Check(v) && !Number.isNaN(Date.parse(v));

export const AddressLikeSchema = Type.String({ maxLength: 320, pattern: "^[^\r\n]*@[^\r\n]*$" });
const checkAddressLike = Compile(AddressLikeSchema);
export const addressLike = (v: unknown): v is string => checkAddressLike.Check(v);
