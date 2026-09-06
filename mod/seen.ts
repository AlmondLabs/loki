import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Catch Up state the mod keeps on disk, keyed by agent + conversation (every
 * agent's main chat is called "default"):
 *  - seen:   when the user last looked at a conversation (Letta has no read marker we can see)
 *  - snooze: "later" deferrals with their backoff count (see app/src/attention/snooze.ts)
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
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (parsed && typeof parsed.seen === "object" && parsed.seen) {
        this.seen = parsed.seen as Record<string, string>;
        if (parsed.snooze && typeof parsed.snooze === "object") this.snooze = parsed.snooze as Record<string, SnoozeRecord>;
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
      writeFileSync(`${this.path}.tmp`, JSON.stringify({ seen: this.seen, snooze: this.snooze }, null, 2));
      renameSync(`${this.path}.tmp`, this.path);
    } catch {
      // best effort
    }
  }
}
