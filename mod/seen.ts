import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { addFocus, combineFocus, pruneFocus, type FocusAction, type FocusEntry } from "../core/attention/focus.ts";
import { isRest, type Rest } from "../core/attention/rest.ts";
import type { Pushes } from "../core/frames.ts";
import { coalesce, type Burst } from "../core/timers.ts";

/**
 * Catch Up state the mod keeps on disk, keyed by agent + conversation (every
 * agent's main chat is called "default"):
 *  - seen:   when the user last finished with a conversation, "done" (the daemon keeps no read marker of its own)
 *  - viewed: when the user last looked at it (opened it, a new message arrived while it was open); a look
 *            is not done, so the two move apart: the sidebar's bold follows viewed, the Inbox follows seen
 *  - focus:  each chat's engagement weight, fading by half every 12 hours (core/attention/focus.ts): the
 *            inbox ranks by its share; your messages, answers, decisions and reads add to it
 *  - rests:  how long Next has rested each chat's Inbox card, and on which rung (core/attention/rest.ts)
 * The browser decides what these mean; the mod only remembers them.
 *
 * Shared with paired Macs (plan 023, U8, KTD9): a mark is a time, so the later one wins wherever it was made, and
 * "not done" is a time too (`unseen`), so a later "not done" beats an earlier "done". Focus is engagement, which adds
 * up rather than overwrites: each Mac keeps its own entries, this Mac holds the others' last known (`remoteFocus`), and
 * the Inbox reads their sum. A rest is set at a time too, so the later one wins wherever Next was pressed.
 */

/** What one Mac sends another of its marks: its done, not-done and viewed times, its own focus, and its rests. */
export interface MarksSnapshot {
  seen: Record<string, string>;
  unseen: Record<string, string>;
  viewed: Record<string, string>;
  focus: Record<string, FocusEntry>;
  /** Missing from a Mac on a loki from before rests (plan 026). */
  rests?: Record<string, Rest>;
}
/** Rests set longer ago than this are dropped when the next is set: past the longest rest, and a month on the rung is stale. */
const REST_FORGET_MS = 30 * 24 * 60 * 60_000;
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
  /** Each conversation's Inbox rest, set by Next on any Mac. */
  private rests: Record<string, Rest> = {};
  private readonly path: string;
  private readonly now: () => string;
  /** One write per burst of marks. */
  private readonly writing: Burst;

  /** `now` stamps the marks (tests pin it); `debounceMs` coalesces the writes. */
  constructor(path: string, opts: { debounceMs?: number; now?: () => string } = {}) {
    this.path = path;
    this.writing = coalesce(() => this.write(), opts.debounceMs ?? PERSIST_DEBOUNCE_MS);
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
        if (parsed.rests && typeof parsed.rests === "object")
          this.rests = Object.fromEntries(Object.entries(parsed.rests as Record<string, unknown>).filter((e): e is [string, Rest] => isRest(e[1])));
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

  /** One chat's marks as they now stand, null where it has none: what a change to that chat alone sends (plan 055). */
  chat(agentId: string | null | undefined, conversationId: string): Pushes["seen_chat"] {
    const key = SeenStore.key(agentId, conversationId);
    const done = this.seen[key];
    return {
      key,
      seen: done && !(this.unseen[key] && this.unseen[key] >= done) ? done : null,
      viewed: this.viewed[key] ?? null,
      focus: this.focusAll()[key] ?? null,
      rest: this.rests[key] ?? null,
    };
  }

  viewedAll(): Record<string, string> {
    return { ...this.viewed };
  }

  /** Every Mac's focus, added up (core/attention/focus.ts combineFocus); this Mac's alone while none is paired. */
  focusAll(): Record<string, FocusEntry> {
    const others = Object.values(this.remoteFocus);
    return others.length ? combineFocus(this.focus, others, Date.parse(this.now())) : { ...this.focus };
  }

  /** Every chat's Inbox rest. */
  restsAll(): Record<string, Rest> {
    return { ...this.rests };
  }

  /** A chat's Inbox card rested by Next (or its rest undone): false when an as late one is kept, so nothing moves. */
  rest(agentId: string | null | undefined, conversationId: string, rest: Rest): boolean {
    const key = SeenStore.key(agentId, conversationId);
    if (key in this.rests && this.rests[key].at >= rest.at) return false;
    const forget = new Date(Date.parse(this.now()) - REST_FORGET_MS).toISOString();
    this.rests = Object.fromEntries([...Object.entries(this.rests).filter(([, r]) => r.at >= forget), [key, rest]]);
    this.persist();
    return true;
  }

  /** This Mac's marks for a paired Mac: done and not-done times, looks, its own focus, and the rests. */
  snapshot(): MarksSnapshot {
    return { seen: { ...this.seen }, unseen: { ...this.unseen }, viewed: { ...this.viewed }, focus: { ...this.focus }, rests: { ...this.rests } };
  }

  /** Take a paired Mac's marks: every later time, its focus as its own, every later rest. True when anything here moved. */
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
    for (const [key, rest] of Object.entries(snap.rests ?? {})) {
      if (!isRest(rest) || (key in this.rests && this.rests[key].at >= rest.at)) continue;
      this.rests = { ...this.rests, [key]: rest };
      moved = true;
    }
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
    if (!next) return false;
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
    this.writing.flush();
  }

  private put(map: Record<string, string>, key: string, value: string): boolean {
    if (map[key] === value) return false;
    map[key] = value;
    this.persist();
    return true;
  }

  /** Coalesced: a stream of looks is one write. Everything reads the store, not the file, so only a crash inside the window loses the last mark. */
  private persist(): void {
    this.writing.schedule();
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
            ...(Object.keys(this.rests).length ? { rests: this.rests } : {}),
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
