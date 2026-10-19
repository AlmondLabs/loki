import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { addFocus, combineFocus, pruneFocus, type FocusAction, type FocusEntry } from "../core/attention/focus.ts";

/**
 * Catch Up state the mod keeps on disk, keyed by agent + conversation (every
 * agent's main chat is called "default"):
 *  - seen:   when the user last finished with a conversation, "done" (the daemon keeps no read marker of its own)
 *  - viewed: when the user last looked at it (opened it, a new message arrived while it was open); a look
 *            is not done, so the two move apart: the sidebar's bold follows viewed, the Inbox follows seen
 *  - focus:  each chat's engagement weight, fading by half every 12 hours (core/attention/focus.ts): the
 *            inbox ranks by its share; your messages, answers, decisions and reads add to it
 * The browser decides what these mean; the mod only remembers them.
 *
 * Shared with paired Macs (plan 023, U8, KTD9): a mark is a time, so the later one wins wherever it was made, and
 * "not done" is a time too (`unseen`), so a later "not done" beats an earlier "done". Focus is engagement, which adds
 * up rather than overwrites: each Mac keeps its own entries, this Mac holds the others' last known (`remoteFocus`), and
 * the Inbox reads their sum. A Next anywhere is remembered (`skips`) and halves the other Macs' earlier weight too.
 */

/** What one Mac sends another of its marks: its done, not-done and viewed times, its own focus, and its Nexts. */
export interface MarksSnapshot {
  seen: Record<string, string>;
  unseen: Record<string, string>;
  viewed: Record<string, string>;
  focus: Record<string, FocusEntry>;
  skips: Record<string, string>;
}
/** How long a burst of marks waits before it is written: one write per burst, and flush() on shutdown. */
const PERSIST_DEBOUNCE_MS = 250;

/**
 * The Catch Up marks, loaded from their file at start (a v1 flat map reads as the seen marks) and
 * written atomically after each burst of changes.
 */
export class SeenStore {
  private seen: Record<string, string> = {};
  private viewed: Record<string, string> = {};
  private focus: Record<string, FocusEntry> = {};
  /** When each conversation was last marked not done: a later "not done" beats an earlier "done" (plan 023). */
  private unseen: Record<string, string> = {};
  /** Each paired Mac's own focus entries, as it last sent them. */
  private remoteFocus: Record<string, Record<string, FocusEntry>> = {};
  /** When Next was last pressed on each conversation, on any Mac. */
  private skips: Record<string, string> = {};
  private readonly path: string;
  private readonly debounceMs: number;
  private readonly now: () => string;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** `now` stamps the marks (tests pin it); `debounceMs` coalesces the writes. */
  constructor(path: string, opts: { debounceMs?: number; now?: () => string } = {}) {
    this.path = path;
    this.debounceMs = opts.debounceMs ?? PERSIST_DEBOUNCE_MS;
    this.now = opts.now ?? (() => new Date().toISOString());
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> | null;
      if (parsed && typeof parsed.seen === "object" && parsed.seen) {
        this.seen = parsed.seen as Record<string, string>;
        if (parsed.viewed && typeof parsed.viewed === "object") this.viewed = parsed.viewed as Record<string, string>;
        if (parsed.focus && typeof parsed.focus === "object") this.focus = parsed.focus as Record<string, FocusEntry>;
        if (parsed.unseen && typeof parsed.unseen === "object") this.unseen = parsed.unseen as Record<string, string>;
        if (parsed.remote_focus && typeof parsed.remote_focus === "object")
          this.remoteFocus = parsed.remote_focus as Record<string, Record<string, FocusEntry>>;
        if (parsed.skips && typeof parsed.skips === "object") this.skips = parsed.skips as Record<string, string>;
      } else {
        this.seen = parsed as Record<string, string>; // v1 file: a flat map of markers
      }
    } catch {
      this.seen = {};
    }
  }

  static key(agentId: string | null | undefined, conversationId: string): string {
    return agentId ? `${agentId}/${conversationId}` : conversationId;
  }

  /** The done marks that stand: those no later "not done" undid. */
  all(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.seen).filter(([key, at]) => !(this.unseen[key] && this.unseen[key] >= at)));
  }

  viewedAll(): Record<string, string> {
    return { ...this.viewed };
  }

  /** Every Mac's focus, added up (core/attention/focus.ts combineFocus); this Mac's alone while none is paired. */
  focusAll(): Record<string, FocusEntry> {
    const others = Object.values(this.remoteFocus);
    return others.length ? combineFocus(this.focus, others, this.skips, Date.parse(this.now())) : { ...this.focus };
  }

  /** This Mac's marks for a paired Mac: done and not-done times, looks, its own focus, and its Nexts. */
  snapshot(): MarksSnapshot {
    return { seen: { ...this.seen }, unseen: { ...this.unseen }, viewed: { ...this.viewed }, focus: { ...this.focus }, skips: { ...this.skips } };
  }

  /** Take a paired Mac's marks: every later time, its focus as its own, its Nexts. True when anything here moved. */
  applyRemote(macId: string, snap: MarksSnapshot): boolean {
    let moved = false;
    const later = (mine: Record<string, string>, theirs: Record<string, string>) => {
      for (const [key, at] of Object.entries(theirs)) {
        if (typeof at !== "string" || (mine[key] && mine[key] >= at)) continue;
        mine[key] = at;
        moved = true;
      }
    };
    later(this.seen, snap.seen);
    later(this.unseen, snap.unseen);
    later(this.viewed, snap.viewed);
    later(this.skips, snap.skips);
    if (JSON.stringify(this.remoteFocus[macId] ?? {}) !== JSON.stringify(snap.focus)) {
      this.remoteFocus = { ...this.remoteFocus, [macId]: { ...snap.focus } };
      moved = true;
    }
    if (moved) this.persist();
    return moved;
  }

  /** A paired Mac forgotten: its focus no longer counts. */
  forgetMac(macId: string): void {
    if (!(macId in this.remoteFocus)) return;
    const { [macId]: _, ...rest } = this.remoteFocus;
    this.remoteFocus = rest;
    this.persist();
  }

  /** One engagement with a chat; false when it adds nothing (a repeat open inside the gap), so nothing is broadcast. */
  engage(agentId: string | null | undefined, conversationId: string, action: FocusAction): boolean {
    const key = SeenStore.key(agentId, conversationId);
    const next = addFocus(this.focus[key], action, Date.parse(this.now()));
    // A Next halves the other Macs' weight for this chat too (focusAll), from now.
    if (action === "skip") this.skips = { ...this.skips, [key]: this.now() };
    if (!next) {
      if (action === "skip") this.persist();
      return action === "skip";
    }
    this.focus = { ...pruneFocus(this.focus, Date.parse(this.now())), [key]: next };
    this.persist();
    return true;
  }

  /**
   * The marks below return whether the stored value moved; one that did not writes nothing, and the bridge
   * broadcasts nothing for it.
   */
  mark(agentId: string | null | undefined, conversationId: string): boolean {
    return this.put(this.seen, SeenStore.key(agentId, conversationId), this.now());
  }

  /** A look: opening the conversation, or a message arriving while it is open. Never touches seen. */
  view(agentId: string | null | undefined, conversationId: string): boolean {
    return this.put(this.viewed, SeenStore.key(agentId, conversationId), this.now());
  }

  /** Not done: kept as a time, so it wins over an earlier done from another Mac and loses to a later one. */
  unmark(agentId: string | null | undefined, conversationId: string): boolean {
    const key = SeenStore.key(agentId, conversationId);
    if (!(key in this.all())) return false;
    this.unseen = { ...this.unseen, [key]: this.now() };
    this.persist();
    return true;
  }

  /** Write now what is waiting on the debounce (the mod's shutdown; a test before it reads the file). */
  flush(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.write();
  }

  private put(map: Record<string, string>, key: string, value: string): boolean {
    if (map[key] === value) return false;
    map[key] = value;
    this.persist();
    return true;
  }

  /** Coalesced: a stream of looks is one write. Everything reads the store, not the file, so only a crash inside the window loses the last mark. */
  private persist(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write();
    }, this.debounceMs);
  }

  private write(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(
        `${this.path}.tmp`,
        JSON.stringify(
          {
            seen: this.seen,
            ...(Object.keys(this.viewed).length ? { viewed: this.viewed } : {}),
            ...(Object.keys(this.focus).length ? { focus: this.focus } : {}),
            ...(Object.keys(this.unseen).length ? { unseen: this.unseen } : {}),
            ...(Object.keys(this.remoteFocus).length ? { remote_focus: this.remoteFocus } : {}),
            ...(Object.keys(this.skips).length ? { skips: this.skips } : {}),
          },
          null,
          2,
        ),
      );
      renameSync(`${this.path}.tmp`, this.path);
    } catch {
      // best effort
    }
  }
}
