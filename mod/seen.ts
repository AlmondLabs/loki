import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_LADDER, clampLadder, type SnoozeLadder } from "../core/attention/ladder.ts";

/**
 * Catch Up state the mod keeps on disk, keyed by agent + conversation (every
 * agent's main chat is called "default"):
 *  - seen:   when the user last looked at a conversation (Letta has no read marker we can see)
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

export class SeenStore {
  private seen: Record<string, string> = {};
  private snooze: Record<string, SnoozeRecord> = {};
  private ladderSetting: SnoozeLadder | null = null;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (parsed && typeof parsed.seen === "object" && parsed.seen) {
        this.seen = parsed.seen as Record<string, string>;
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

  snoozes(): Record<string, SnoozeRecord> {
    return { ...this.snooze };
  }

  /** The "later" ladder in force: the person's setting, else the defaults. */
  ladder(): SnoozeLadder {
    return this.ladderSetting ?? DEFAULT_LADDER;
  }

  /** Change one or both knobs; each is clamped to its range. */
  setLadder(input: Partial<Record<keyof SnoozeLadder, unknown>>): SnoozeLadder {
    this.ladderSetting = clampLadder(input, this.ladder());
    this.persist();
    return this.ladderSetting;
  }

  mark(agentId: string | null | undefined, conversationId: string): void {
    this.seen[SeenStore.key(agentId, conversationId)] = new Date().toISOString();
    this.persist();
  }

  unmark(agentId: string | null | undefined, conversationId: string): void {
    delete this.seen[SeenStore.key(agentId, conversationId)];
    this.persist();
  }

  setSnooze(agentId: string | null | undefined, conversationId: string, rec: SnoozeRecord): void {
    this.snooze[SeenStore.key(agentId, conversationId)] = rec;
    this.persist();
  }

  clearSnooze(agentId: string | null | undefined, conversationId: string): void {
    delete this.snooze[SeenStore.key(agentId, conversationId)];
    this.persist();
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(`${this.path}.tmp`, JSON.stringify({ seen: this.seen, snooze: this.snooze, ...(this.ladderSetting ? { ladder: this.ladderSetting } : {}) }, null, 2));
      renameSync(`${this.path}.tmp`, this.path);
    } catch {
      // best effort
    }
  }
}
