import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { addFocus, pruneFocus, type FocusAction, type FocusEntry } from "../core/attention/focus.ts";

/**
 * Catch Up state the mod keeps on disk, keyed by agent + conversation (every
 * agent's main chat is called "default"):
 *  - seen:   when the user last finished with a conversation, "done" (the daemon keeps no read marker of its own)
 *  - viewed: when the user last looked at it (opened it, a new message arrived while it was open); a look
 *            is not done, so the two move apart: the sidebar's bold follows viewed, the Inbox follows seen
 *  - focus:  each chat's engagement weight, fading by half every 12 hours (core/attention/focus.ts): the
 *            inbox ranks by its share; your messages, answers, decisions and reads add to it
 * The browser decides what these mean; the mod only remembers them.
 */
/** How long a burst of marks waits before it is written: one write per burst, and flush() on shutdown. */
const PERSIST_DEBOUNCE_MS = 250;

export class SeenStore {
  private seen: Record<string, string> = {};
  private viewed: Record<string, string> = {};
  private focus: Record<string, FocusEntry> = {};
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
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (parsed && typeof parsed.seen === "object" && parsed.seen) {
        this.seen = parsed.seen as Record<string, string>;
        if (parsed.viewed && typeof parsed.viewed === "object") this.viewed = parsed.viewed as Record<string, string>;
        if (parsed.focus && typeof parsed.focus === "object") this.focus = parsed.focus as Record<string, FocusEntry>;
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

  all(): Record<string, string> {
    return { ...this.seen };
  }

  viewedAll(): Record<string, string> {
    return { ...this.viewed };
  }

  focusAll(): Record<string, FocusEntry> {
    return { ...this.focus };
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

  unmark(agentId: string | null | undefined, conversationId: string): boolean {
    return this.drop(this.seen, SeenStore.key(agentId, conversationId));
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

  private drop(map: Record<string, unknown>, key: string): boolean {
    if (!(key in map)) return false;
    delete map[key];
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
      writeFileSync(`${this.path}.tmp`, JSON.stringify({ seen: this.seen, ...(Object.keys(this.viewed).length ? { viewed: this.viewed } : {}), ...(Object.keys(this.focus).length ? { focus: this.focus } : {}) }, null, 2));
      renameSync(`${this.path}.tmp`, this.path);
    } catch {
      // best effort
    }
  }
}
