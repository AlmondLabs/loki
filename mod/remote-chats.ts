import { SHARED_SCOPE, type Scope } from "../core/desk-core.ts";
import type { DeskSummary, InboxRow } from "../core/frame-types.ts";
import { pushMeaning } from "../core/frames.ts";
import type { PeerLink } from "./peer-link.ts";

/**
 * Every paired Mac's own chats, kept here so this Mac's lists show them beside its own (plan 023, U4, R10, R12). A
 * Mac's chats are fetched when its link opens and again, shortly after, whenever it pushes something that may have
 * changed them; when it goes out of reach its chats stay, marked unreachable, and when it is unpaired they go. The
 * lists stay synchronous: they read what was last fetched.
 */

interface MacChats {
  desks: DeskSummary[];
  inbox: InboxRow[];
  reachable: boolean;
}

/** Whether a push from a Mac may have changed its chats: the frame table says (core/frames.ts, addendum C). */
const changesList = (frame: Record<string, unknown>): boolean => {
  const lists = pushMeaning(frame.type)?.lists;
  if (lists === true) return true;
  if (!lists || !Array.isArray(frame.events)) return false;
  return frame.events.some((e) => typeof e === "object" && e !== null && lists.some((kind) => kind === (e as { kind?: unknown }).kind));
};

/**
 * This Mac's own chats as `peer_chats` carries them to another Mac: the outside cards (plan 067, R14) apart from the
 * chats, in `outside`, which only a Mac that knows them reads, so one on an older loki shows none.
 */
export function peerChatsReply(desks: DeskSummary[], inbox: InboxRow[]): { desks: DeskSummary[]; inbox: InboxRow[]; outside: InboxRow[] } {
  return { desks, inbox: inbox.filter((r) => r.kind !== "outside"), outside: inbox.filter((r) => r.kind === "outside") };
}

/** What RemoteChats is built from; the debounce is shortened in tests. */
export interface RemoteChatsOptions {
  link: (macId: string) => PeerLink | null;
  /** A paired Mac's name, as this Mac shows it. */
  name: (macId: string) => string;
  /** The remote chats changed, or a Mac came into or out of reach: the lists should be asked for again. */
  onChange: () => void;
  /** A Mac's chats were fetched: the scopes it holds, its word for the chat directory (addendum B5). */
  onListed?: (macId: string, scopes: Scope[]) => void;
  debounceMs?: number;
  /** The first wait before a failed fetch over a link still up is tried again, doubling to thirty seconds. */
  retryMs?: number;
}

/** The longest wait between fetches of a Mac's chats that keep failing while its link is up: the link's own backoff. */
const MAX_RETRY_MS = 30_000;

/** The paired Macs' chats as this Mac last heard them. */
export class RemoteChats {
  private readonly opts: RemoteChatsOptions;
  private readonly macs = new Map<string, MacChats>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** A failed fetch waiting to be tried again, per Mac, and how long the next wait is. */
  private readonly retries = new Map<string, { timer: ReturnType<typeof setTimeout> | null; waitMs: number }>();

  constructor(opts: RemoteChatsOptions) {
    this.opts = opts;
  }

  /** Keep only the Macs still paired: an unpaired Mac's chats leave every list (R4). */
  sync(macIds: string[]): void {
    const keep = new Set(macIds);
    let dropped = false;
    for (const id of [...this.retries.keys()]) if (!keep.has(id)) this.stopRetry(id);
    for (const id of [...this.macs.keys()])
      if (!keep.has(id)) {
        this.macs.delete(id);
        dropped = true;
      }
    if (dropped) this.opts.onChange();
  }

  /** A Mac's link opened or closed: fetch its chats, or mark what is kept as unreachable. */
  setReachable(macId: string, reachable: boolean): void {
    if (reachable) {
      void this.refresh(macId);
      return;
    }
    this.stopRetry(macId);
    const kept = this.macs.get(macId);
    if (kept?.reachable) {
      kept.reachable = false;
      this.opts.onChange();
    }
  }

  /** A push came from a Mac: when it may have changed its chats, fetch them again shortly. */
  heard(macId: string, frame: Record<string, unknown>): void {
    if (!changesList(frame)) return;
    if (this.timers.has(macId)) return;
    const t = setTimeout(() => {
      this.timers.delete(macId);
      void this.refresh(macId);
    }, this.opts.debounceMs ?? 400);
    t.unref();
    this.timers.set(macId, t);
  }

  /**
   * Fetch a Mac's chats now. When the fetch fails but the link is still up (the other Mac was slow, busy with the
   * syncs that start with every connection), what was listed stays in reach and the fetch is tried again; only a link
   * that went down marks the Mac's chats out of reach.
   */
  async refresh(macId: string): Promise<void> {
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
    this.stopRetry(macId);
    // A desk whose chat is gone there (a layout or canvas left behind) is no chat of that Mac's: listing it would also
    // send that chat's frames there, away from the Mac that holds it.
    // Rows that are not objects (a Mac on another loki version) are dropped: one would throw here, in a refresh nobody
    // awaits, and end the daemon.
    const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v.filter((x: unknown) => typeof x === "object" && x !== null) : []);
    const desks = (rows(reply.desks) as DeskSummary[]).filter((d) => d.scope !== SHARED_SCOPE && !!d.conversation_id && d.status !== "deleted");
    const inbox = [...(rows(reply.inbox) as InboxRow[]), ...(rows(reply.outside) as InboxRow[])];
    this.macs.set(macId, { desks, inbox, reachable: true });
    this.opts.onListed?.(
      macId,
      desks.map((d) => d.scope),
    );
    this.opts.onChange();
  }

  /** The paired Macs' desks, each marked with its Mac and whether it can be reached. */
  desks(): DeskSummary[] {
    return [...this.macs].flatMap(([mac, m]) =>
      m.desks.map((d) => ({ ...d, active: false, home: mac, home_name: this.opts.name(mac), reachable: m.reachable })),
    );
  }

  /** The paired Macs' Inbox rows, marked the same way. */
  inbox(): InboxRow[] {
    return [...this.macs].flatMap(([mac, m]) => m.inbox.map((r) => ({ ...r, home: mac, home_name: this.opts.name(mac), reachable: m.reachable })));
  }

  /**
   * A paired Mac out of reach whose last list holds chats of this agent (plan 023, addendum D5): deleting the agent
   * now would leave them behind there. Null when no such Mac.
   */
  awayWith(agentId: string): string | null {
    for (const [mac, m] of this.macs) if (!m.reachable && m.desks.some((d) => d.agent_id === agentId)) return mac;
    return null;
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const id of [...this.retries.keys()]) this.stopRetry(id);
  }

  /** Fetch a Mac's chats again after a wait that doubles with each failure; one wait at a time per Mac. */
  private retryLater(macId: string): void {
    const retry = this.retries.get(macId) ?? { timer: null, waitMs: this.opts.retryMs ?? 1000 };
    if (retry.timer) return;
    const wait = retry.waitMs;
    retry.waitMs = Math.min(wait * 2, MAX_RETRY_MS);
    retry.timer = setTimeout(() => {
      retry.timer = null;
      void this.refresh(macId);
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
