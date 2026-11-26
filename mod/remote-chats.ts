import { SHARED_SCOPE, type Scope } from "../core/desk-core.ts";
import type { DeskSummary, InboxRow } from "../core/frame-types.ts";
import { pushMeaning } from "../core/frames.ts";
import { messageOf } from "../core/errors.ts";
import { log } from "./log.ts";
import type { PeerLink } from "./peer-link.ts";

interface MacChats {
  desks: DeskSummary[];
  inbox: InboxRow[];
  reachable: boolean;
}

const changesList = (frame: Record<string, unknown>): boolean => {
  const lists = pushMeaning(frame.type)?.lists;
  if (lists === true) return true;
  if (!lists || !Array.isArray(frame.events)) return false;
  return frame.events.some((e) => typeof e === "object" && e !== null && lists.some((kind) => kind === (e as { kind?: unknown }).kind));
};

export function peerChatsReply(desks: DeskSummary[], inbox: InboxRow[]): { desks: DeskSummary[]; inbox: InboxRow[]; outside: InboxRow[] } {
  return { desks, inbox: inbox.filter((r) => r.kind !== "outside"), outside: inbox.filter((r) => r.kind === "outside") };
}

export interface RemoteChatsOptions {
  link: (macId: string) => PeerLink | null;
  name: (macId: string) => string;
  onChange: () => void;
  onListed?: (macId: string, scopes: Scope[]) => void;
  debounceMs?: number;
  retryMs?: number;
}

const MAX_RETRY_MS = 30_000;

export class RemoteChats {
  private readonly opts: RemoteChatsOptions;
  private readonly macs = new Map<string, MacChats>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retries = new Map<string, { timer: ReturnType<typeof setTimeout> | null; waitMs: number }>();
  private readonly refreshing = new Set<string>();
  private readonly dirty = new Set<string>();
  private cachedDesks: DeskSummary[] | null = null;
  private cachedInbox: InboxRow[] | null = null;

  constructor(opts: RemoteChatsOptions) {
    this.opts = opts;
  }

  private invalidate(): void {
    this.cachedDesks = null;
    this.cachedInbox = null;
  }

  sync(macIds: string[]): void {
    const keep = new Set(macIds);
    let dropped = false;
    for (const id of [...this.retries.keys()]) if (!keep.has(id)) this.stopRetry(id);
    for (const id of [...this.macs.keys()])
      if (!keep.has(id)) {
        this.macs.delete(id);
        dropped = true;
      }
    if (dropped) {
      this.invalidate();
      this.opts.onChange();
    }
  }

  setReachable(macId: string, reachable: boolean): void {
    if (reachable) {
      this.startRefresh(macId);
      return;
    }
    this.stopRetry(macId);
    const kept = this.macs.get(macId);
    if (kept?.reachable) {
      kept.reachable = false;
      this.invalidate();
      this.opts.onChange();
    }
  }

  heard(macId: string, frame: Record<string, unknown>): void {
    if (!changesList(frame)) return;
    if (this.timers.has(macId)) return;
    const t = setTimeout(() => {
      this.timers.delete(macId);
      this.startRefresh(macId);
    }, this.opts.debounceMs ?? 400);
    t.unref();
    this.timers.set(macId, t);
  }

  startRefresh(macId: string): void {
    this.refresh(macId).catch((err: unknown) => {
      log.error("peers:chats_failed", { mac: macId, reason: messageOf(err) });
      this.retryLater(macId);
    });
  }

  async refresh(macId: string): Promise<void> {
    if (this.refreshing.has(macId)) {
      this.dirty.add(macId);
      return;
    }
    this.refreshing.add(macId);
    try {
      do {
        this.dirty.delete(macId);
        const link = this.opts.link(macId);
        if (!link) return;
        let reply: Record<string, unknown>;
        try {
          reply = await link.request({ type: "peer_chats_get" });
        } catch {
          if (link.status === "reachable") this.retryLater(macId);
          else this.setReachable(macId, false);
          return;
        }
        const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v.filter((x: unknown) => typeof x === "object" && x !== null) : []);
        const desks = (rows(reply.desks) as DeskSummary[]).filter((d) => d.scope !== SHARED_SCOPE && !!d.conversation_id && d.status !== "deleted");
        const inbox = [...(rows(reply.inbox) as InboxRow[]), ...(rows(reply.outside) as InboxRow[])];
        this.macs.set(macId, { desks, inbox, reachable: true });
        this.invalidate();
        this.opts.onListed?.(
          macId,
          desks.map((d) => d.scope),
        );
        this.opts.onChange();
        this.stopRetry(macId);
      } while (this.dirty.has(macId));
    } finally {
      this.refreshing.delete(macId);
      this.dirty.delete(macId);
    }
  }

  desks(): DeskSummary[] {
    this.cachedDesks ??= [...this.macs].flatMap(([mac, m]) =>
      m.desks.map((d) => ({ ...d, active: false, home: mac, home_name: this.opts.name(mac), reachable: m.reachable })),
    );
    return this.cachedDesks;
  }

  inbox(): InboxRow[] {
    this.cachedInbox ??= [...this.macs].flatMap(([mac, m]) =>
      m.inbox.map((r) => ({ ...r, home: mac, home_name: this.opts.name(mac), reachable: m.reachable })),
    );
    return this.cachedInbox;
  }

  awayWith(agentId: string): string | null {
    for (const [mac, m] of this.macs) if (!m.reachable && m.desks.some((d) => d.agent_id === agentId)) return mac;
    return null;
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const id of [...this.retries.keys()]) this.stopRetry(id);
  }

  private retryLater(macId: string): void {
    const retry = this.retries.get(macId) ?? { timer: null, waitMs: this.opts.retryMs ?? 1000 };
    if (retry.timer) return;
    const wait = retry.waitMs;
    retry.waitMs = Math.min(wait * 2, MAX_RETRY_MS);
    retry.timer = setTimeout(() => {
      retry.timer = null;
      this.startRefresh(macId);
    }, wait);
    retry.timer.unref();
    this.retries.set(macId, retry);
  }

  private stopRetry(macId: string): void {
    const retry = this.retries.get(macId);
    if (retry?.timer) clearTimeout(retry.timer);
    this.retries.delete(macId);
  }
}
