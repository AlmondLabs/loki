import { linkAnswerWords, linkAskOf, parseLinkAnswer } from "../chat-links.ts";
import type { ChatClient } from "./chat-client.ts";
import { isFileAttachment, withAttachments, type Attachment, type ImageAttachment } from "./content.ts";
import type { ConversationInfo } from "./model.ts";
import { keyOf } from "./model.ts";
import { SUBAGENT_CHAT_SEP, parentChatOfSubagent } from "../subagents.ts";
import { ownSendKey } from "./thread.ts";
import type { ChatSnapshot } from "./chat-store-types.ts";

export const HISTORY_PAGE = 100;
export const FOLDER_MOVE_MS = 8000;
export const LIST_RETRY_MS = 1000;
export const NOT_CONNECTED = "not connected to loki's daemon";
export const NOT_OUTSIDE = "this card is not from an account";

export function emptySnapshot(): ChatSnapshot {
  return {
    status: "off",
    server: null,
    agents: [],
    agentsLoaded: false,
    listed: false,
    conversations: [],
    digests: new Map(),
    live: new Map(),
    older: {},
    failed: {},
    providers: null,
    labels: null,
  };
}

const withoutKey = <T>(o: Partial<Record<string, T>>, key: string): Partial<Record<string, T>> =>
  Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

export const flagged = (o: Partial<Record<string, true>>, key: string, on: boolean): Partial<Record<string, true>> =>
  !!o[key] === on ? o : on ? { ...o, [key]: true as const } : withoutKey(o, key);

export function outgoing(text: string, attachments: Attachment[]): { text: string; images: ImageAttachment[]; key: string } {
  const files = attachments.filter(isFileAttachment);
  const images = attachments.filter((a): a is ImageAttachment => !isFileAttachment(a));
  return { text: withAttachments(text, files), images, key: ownSendKey(text, files) };
}

export function sentRow(
  text: string,
  attachments: Attachment[],
  at: string,
): { role: "user"; text: string; images?: string[]; files?: Array<{ path: string; name: string; size: number; mime: string }>; at: string } {
  const files = attachments.filter(isFileAttachment).map(({ path, name, size, mime }) => ({ path, name, size, mime }));
  const images = attachments.filter((a): a is ImageAttachment => !isFileAttachment(a)).map((i) => i.url);
  return { role: "user" as const, text, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}), at };
}

export function formatAnswerSummary(input: unknown, answers: Record<string, string | string[]>): string {
  const link = linkAskOf(input);
  return link
    ? linkAnswerWords(link, parseLinkAnswer(answers))
    : Object.values(answers)
        .map((a) => (Array.isArray(a) ? a.join(", ") : a))
        .join(" · ");
}

export function keyKnown(known: ReadonlySet<string>, key: string): boolean {
  if (known.has(key)) return true;
  const slash = key.indexOf("/");
  if (slash < 0) return false;
  const parent = parentChatOfSubagent(key.slice(slash + 1));
  return parent !== null && known.has(keyOf(key.slice(0, slash), parent));
}

export function pruneUnknownKeys(known: ReadonlySet<string>, maps: ReadonlyArray<Map<string, unknown>>): void {
  for (const map of maps) {
    for (const k of map.keys()) if (!keyKnown(known, k)) map.delete(k);
  }
}

export function pruneConversationKeys(
  conversationId: string,
  agentId: string | undefined,
  maps: ReadonlyArray<Map<string, unknown>>,
  dirtyKeys: Set<string>,
): void {
  const exact = agentId ? keyOf(agentId, conversationId) : null;
  const suffix = `/${conversationId}`;
  const matches = (k: string) => {
    if (exact) return k === exact || k.startsWith(`${exact}${SUBAGENT_CHAT_SEP}`);
    return k.endsWith(suffix) || k.includes(`/${conversationId}${SUBAGENT_CHAT_SEP}`);
  };
  for (const map of maps) {
    for (const k of [...map.keys()]) if (matches(k)) map.delete(k);
  }
  for (const k of [...dirtyKeys]) if (matches(k)) dirtyKeys.delete(k);
}

export async function subscribeTopConversations(client: ChatClient, convs: readonly ConversationInfo[], limit: number, stopped: () => boolean): Promise<void> {
  const targets = convs
    .filter((x) => !x.outside)
    .slice(0, limit)
    .map((c) => ({ agent_id: c.agent_id, conversation_id: c.id }))
    .filter((rt) => !client.isSubscribed(rt));
  if (!targets.length) return;
  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length && !stopped()) {
      const rt = targets[cursor++];
      await client.runtimeStart(rt).catch(() => {});
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, targets.length) }, worker));
}
