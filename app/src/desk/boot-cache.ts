import type { TranscriptRow } from "../chat/transcript";
import type { DeskSummary } from "../../../core/frame-types.ts";

const DESKS_CACHE_KEY = "loki.cache.desks.v1";
const THREAD_CACHE_PREFIX = "loki.cache.thread.v1:";
const THREAD_CACHE_ROWS = 80;
const THREAD_CACHE_MAX = 12;

function storage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function readCachedDesks(): DeskSummary[] | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(DESKS_CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DeskSummary[]) : null;
  } catch {
    return null;
  }
}

export function writeCachedDesks(desks: DeskSummary[]): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(DESKS_CACHE_KEY, JSON.stringify(desks));
  } catch {}
}

function threadKey(agentId: string, conversationId: string): string {
  return `${THREAD_CACHE_PREFIX}${agentId}\u0000${conversationId}`;
}

export function readCachedThread(agentId: string, conversationId: string): TranscriptRow[] | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(threadKey(agentId, conversationId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TranscriptRow[]) : null;
  } catch {
    return null;
  }
}

export function writeCachedThread(agentId: string, conversationId: string, rows: TranscriptRow[]): void {
  const store = storage();
  if (!store) return;
  const key = threadKey(agentId, conversationId);
  try {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k?.startsWith(THREAD_CACHE_PREFIX) && k !== key) keys.push(k);
    }
    while (keys.length >= THREAD_CACHE_MAX) {
      const drop = keys.shift();
      if (drop) store.removeItem(drop);
    }
    store.setItem(key, JSON.stringify(rows.slice(-THREAD_CACHE_ROWS)));
  } catch {}
}
