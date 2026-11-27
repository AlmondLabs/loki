import { accountsFrames } from "./accounts.ts";
import { agentsFrames } from "./agents.ts";
import { chatFrames } from "./chat.ts";
import { chatsFrames } from "./chats.ts";
import { foldersFrames } from "./folders.ts";
import { lanFrames } from "./lan.ts";
import { peersFrames } from "./peers.ts";
import { learnFrames } from "./learn.ts";
import { seenFrames } from "./seen.ts";
import type { PeerMeaning, PushName, PushPeerMeaning, Pushes, Replies, ReplyName } from "./types.ts";

export {
  DRAFT_HELD,
  STATE_FOLDERS,
  stateFolders,
  type ChatState,
  type MacAccountView,
  type Parse,
  type PeerMeaning,
  type PushName,
  type PushPeerMeaning,
  type Pushes,
  type Replies,
  type ReplyAction,
  type ReplyDecideOptions,
  type ReplyName,
  type StateFolder,
  type SuggestionAction,
} from "./types.ts";

export { isAgentId, isLanVia, parseSuggestionTarget, replyMentionOf } from "./primitives.ts";

export const FRAMES = {
  ...chatsFrames,
  ...seenFrames,
  ...foldersFrames,
  ...learnFrames,
  ...agentsFrames,
  ...lanFrames,
  ...peersFrames,
  ...chatFrames,
  ...accountsFrames,
} as const;

type Table = typeof FRAMES;
export type FrameName = keyof Table;
export type RequestName = { [K in FrameName]: Table[K] extends { kind: "request" } ? K : never }[FrameName];
export type SendName = { [K in FrameName]: Table[K] extends { kind: "send" } ? K : never }[FrameName];
export type PayloadOf<N extends RequestName | SendName> = Exclude<ReturnType<Table[N]["parse"]>, string>;
export type InputOf<N extends RequestName | SendName> = Optional<PayloadOf<N>>;
type Optional<T> = { [K in keyof T as undefined extends T[K] ? K : null extends T[K] ? K : never]?: T[K] } & {
  [K in keyof T as undefined extends T[K] ? never : null extends T[K] ? never : K]: T[K];
};
export type ReplyOf<N extends RequestName> = Table[N] extends { reply: infer R extends ReplyName } ? Replies[R] : never;
export type PushFrame = { [K in PushName]: { type: K } & Pushes[K] }[PushName];

export const frameEntry = (type: unknown): Table[FrameName] | undefined =>
  typeof type === "string" && Object.hasOwn(FRAMES, type) ? FRAMES[type as FrameName] : undefined;

export const PHONE_FRAMES: ReadonlySet<FrameName> = new Set(
  (Object.keys(FRAMES) as FrameName[]).filter((n) => FRAMES[n].kind !== "push" && (FRAMES[n] as { phone: boolean }).phone),
);

export const PEER_FRAMES: ReadonlySet<FrameName> = new Set((Object.keys(FRAMES) as FrameName[]).filter((n) => peerMeaning(n) !== null));

export function peerMeaning(name: unknown): PeerMeaning | null {
  const entry = frameEntry(name);
  return !entry || entry.kind === "push" ? null : entry.peer;
}

export function pushMeaning(name: unknown): PushPeerMeaning | null {
  const entry = frameEntry(name);
  return entry?.kind === "push" ? (entry.peer ?? null) : null;
}
