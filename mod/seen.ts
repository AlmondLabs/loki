import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * "Seen" markers for Catch Up: when the user last looked at a conversation.
 * Letta keeps no read marker the mod can see, so loci keeps its own, keyed by
 * agent + conversation (every agent's main chat is called "default").
 */
export class SeenStore {
  private seen: Record<string, string> = {};
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    try {
      this.seen = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
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

  mark(agentId: string | null | undefined, conversationId: string): void {
    this.seen[SeenStore.key(agentId, conversationId)] = new Date().toISOString();
    this.persist();
  }

  unmark(agentId: string | null | undefined, conversationId: string): void {
    delete this.seen[SeenStore.key(agentId, conversationId)];
    this.persist();
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(`${this.path}.tmp`, JSON.stringify(this.seen, null, 2));
      renameSync(`${this.path}.tmp`, this.path);
    } catch {
      // best effort
    }
  }
}
