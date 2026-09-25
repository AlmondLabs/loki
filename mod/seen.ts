import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_LADDER, clampLadder, type SnoozeLadder } from "../core/attention/ladder.ts";

/**
 * Catch Up state the mod keeps on disk, keyed by agent + conversation (every
 * agent's main chat is called "default"):
 *  - seen:   when the user last finished with a conversation, "done" (Letta has no read marker we can see)
 *  - viewed: when the user last looked at it (opened it, a new message arrived while it was open); a look
 *            is not done, so the two move apart: the sidebar's bold follows viewed, the Inbox follows seen
 *  - snooze: "later" deferrals with their backoff count (see core/attention/snooze.ts)
 *  - ladder: how long "later" hides a card — the first deferral in minutes and the growth per further one
 *            (core/attention/ladder.ts); absent means the defaults
 * The browser decides what these mean; the mod only remembers them.
 */
export interface SnoozeRecord {
  skips: number;
  until: string;
  stamp: string;
  at: string;
}

/** How long a burst of marks waits before it is written: one write per burst, and flush() on shutdown. */
const PERSIST_DEBOUNCE_MS = 250;

export class SeenStore {
  private seen: Record<string, string> = {};
  private viewed: Record<string, string> = {};
  private snooze: Record<string, SnoozeRecord> = {};
  private ladderSetting: SnoozeLadder | null = null;
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
        if (parsed.snooze && typeof parsed.snooze === "object") this.snooze = parsed.snooze as Record<string, SnoozeRecord>;
        if (parsed.ladder && typeof parsed.ladder === "object") this.ladderSetting = clampLadder(parsed.ladder as Partial<Record<keyof SnoozeLadder, unknown>>);
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

  snoozes(): Record<string, SnoozeRecord> {
    return { ...this.snooze };
  }

  /** The "later" ladder in force: the person's setting, else the defaults. */
  ladder(): SnoozeLadder {
    return this.ladderSetting ?? DEFAULT_LADDER;
  }

  /** Change one or both knobs; each is clamped to its range. Written only when the setting moves. */
  setLadder(input: Partial<Record<keyof SnoozeLadder, unknown>>): SnoozeLadder {
    const next = clampLadder(input, this.ladder());
    if (next.firstMinutes !== this.ladderSetting?.firstMinutes || next.growth !== this.ladderSetting?.growth) {
      this.ladderSetting = next;
      this.persist();
    }
    return this.ladder();
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

  setSnooze(agentId: string | null | undefined, conversationId: string, rec: SnoozeRecord): boolean {
    const key = SeenStore.key(agentId, conversationId);
    const was = this.snooze[key];
    if (was && was.skips === rec.skips && was.until === rec.until && was.stamp === rec.stamp && was.at === rec.at) return false;
    this.snooze[key] = rec;
    this.persist();
    return true;
  }

  clearSnooze(agentId: string | null | undefined, conversationId: string): boolean {
    return this.drop(this.snooze, SeenStore.key(agentId, conversationId));
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
      writeFileSync(`${this.path}.tmp`, JSON.stringify({ seen: this.seen, snooze: this.snooze, ...(Object.keys(this.viewed).length ? { viewed: this.viewed } : {}), ...(this.ladderSetting ? { ladder: this.ladderSetting } : {}) }, null, 2));
      renameSync(`${this.path}.tmp`, this.path);
    } catch {
      // best effort
    }
  }
}
