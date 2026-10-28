import { onRepoSettled } from "./repo-queue.ts";

/**
 * How long a prompt section read from disk is reused (plan 047). A commit to any memory repo clears it at once, so the
 * memory tools, reflection and Doctor are seen on the next model call; a note or skill edited by hand shows within this.
 */
export const SECTION_TTL_MS = 10_000;

/**
 * Prompt sections read from disk, kept for a short while (plan 047). pi-durable renders every section before each model
 * call, so every tool round of a turn read the agent's memory and every skill again: up to 22 ms of the one event loop
 * for an agent with a large memory, which held up the replies streaming in every other chat.
 */
export class SectionCache {
  private readonly kept = new Map<string, { at: number; text: string | undefined }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** The section under `key`, rendered again once it is older than SECTION_TTL_MS. */
  get(key: string, render: () => string | undefined): string | undefined {
    const kept = this.kept.get(key);
    if (kept && this.now() - kept.at < SECTION_TTL_MS) return kept.text;
    const text = render();
    this.kept.set(key, { at: this.now(), text });
    return text;
  }

  /** Forget every section, after a change loki made. */
  clear(): void {
    this.kept.clear();
  }
}

/** The daemon's sections, cleared whenever a git sequence on a memory repo settles. */
export const sections = new SectionCache();
onRepoSettled(() => sections.clear());
