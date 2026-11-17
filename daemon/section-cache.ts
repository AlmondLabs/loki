import { onRepoSettled } from "./repo-queue.ts";

export const SECTION_TTL_MS = 10_000;

export class SectionCache {
  private readonly kept = new Map<string, { at: number; text: string | undefined }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  get(key: string, render: () => string | undefined): string | undefined {
    const kept = this.kept.get(key);
    if (kept && this.now() - kept.at < SECTION_TTL_MS) return kept.text;
    const text = render();
    this.kept.set(key, { at: this.now(), text });
    return text;
  }

  clear(): void {
    this.kept.clear();
  }
}

export const sections = new SectionCache();
onRepoSettled(() => sections.clear());
