import { SHARED_SCOPE, type Scope } from "../core/desk-core.ts";
import type { DeskSummary, InboxRow } from "../core/frame-types.ts";
import type { PeerLink } from "./peer-link.ts";

/**
 * Every paired Mac's own chats, kept here so this Mac's lists show them beside its own (plan 023, U4, R10, R12). A
 * Mac's chats are fetched when its link opens and again, shortly after, whenever it pushes something that may have
 * changed them; when it goes out of reach its chats stay, marked unreachable, and when it is unpaired they go. The
 * lists stay synchronous: they read what was last fetched.
 */

/** Where a chat lives, for routing a frame to it (U5). */
export interface RemoteHome {
  mac: string;
  reachable: boolean;
}

interface MacChats {
  desks: DeskSummary[];
  inbox: InboxRow[];
  reachable: boolean;
}

/** Pushes from a Mac after which its chats may have changed. */
const CHANGING = new Set(["desks", "chat_event", "agents_changed", "seen"]);

/** What RemoteChats is built from; the debounce is shortened in tests. */
export interface RemoteChatsOptions {
  link: (macId: string) => PeerLink | null;
  /** A paired Mac's name, as this Mac shows it. */
  name: (macId: string) => string;
  /** The remote chats changed, or a Mac came into or out of reach: the lists should be asked for again. */
  onChange: () => void;
  debounceMs?: number;
}

/** The paired Macs' chats as this Mac last heard them. */
export class RemoteChats {
  private readonly opts: RemoteChatsOptions;
  private readonly macs = new Map<string, MacChats>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: RemoteChatsOptions) {
    this.opts = opts;
  }

  /** Keep only the Macs still paired: an unpaired Mac's chats leave every list (R4). */
  sync(macIds: string[]): void {
    const keep = new Set(macIds);
    let dropped = false;
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
    const kept = this.macs.get(macId);
    if (kept?.reachable) {
      kept.reachable = false;
      this.opts.onChange();
    }
  }

  /** A push came from a Mac: when it may have changed its chats, fetch them again shortly. */
  heard(macId: string, frame: Record<string, unknown>): void {
    if (typeof frame.type !== "string" || !CHANGING.has(frame.type)) return;
    if (this.timers.has(macId)) return;
    const t = setTimeout(() => {
      this.timers.delete(macId);
      void this.refresh(macId);
    }, this.opts.debounceMs ?? 400);
    t.unref();
    this.timers.set(macId, t);
  }

  /** Fetch a Mac's chats now; out of reach, nothing changes. */
  async refresh(macId: string): Promise<void> {
    const link = this.opts.link(macId);
    if (!link) return;
    let reply: Record<string, unknown>;
    try {
      reply = await link.request({ type: "peer_chats_get" });
    } catch {
      this.setReachable(macId, false);
      return;
    }
    // A desk whose chat is gone there (a layout or canvas left behind) is no chat of that Mac's: listing it would also
    // send that chat's frames there, away from the Mac that holds it.
    const desks = Array.isArray(reply.desks)
      ? (reply.desks as DeskSummary[]).filter((d) => d.scope !== SHARED_SCOPE && !!d.conversation_id && d.status !== "deleted")
      : [];
    const inbox = Array.isArray(reply.inbox) ? (reply.inbox as InboxRow[]) : [];
    this.macs.set(macId, { desks, inbox, reachable: true });
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

  /** The Mac a chat lives on, when it is another Mac's; null for this Mac's own chats and chats no Mac listed. */
  homeOf(conversationId: string, agentId?: string | null): RemoteHome | null {
    for (const [mac, m] of this.macs) {
      const hit = m.desks.some((d) => d.conversation_id === conversationId && (!agentId || d.agent_id === agentId));
      if (hit) return { mac, reachable: m.reachable };
    }
    return null;
  }

  /** The Mac a desk's scope lives on, when it is another Mac's. */
  homeOfScope(scope: Scope): RemoteHome | null {
    for (const [mac, m] of this.macs) if (m.desks.some((d) => d.scope === scope)) return { mac, reachable: m.reachable };
    return null;
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
