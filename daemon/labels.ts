import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { LABEL_COLORS } from "../core/labels.ts";

/**
 * Each label's colour (plan 022, KD4), kept in `state/labels.json` as an index into the app's palette. A label seen
 * for the first time takes the colour the fewest labels have, the earliest of those, so colours spread out before
 * they repeat. Without a file (tests), colours are kept only while the daemon runs.
 */
export class LabelColors {
  private readonly colors: Map<string, number>;
  private readonly file: string | undefined;

  constructor(file?: string) {
    this.file = file;
    this.colors = new Map(Object.entries(this.read()));
  }

  private read(): Record<string, number> {
    try {
      const parsed: unknown = this.file ? JSON.parse(readFileSync(this.file, "utf8")) : null;
      const colors = parsed && typeof parsed === "object" ? (parsed as { colors?: unknown }).colors : null;
      if (!colors || typeof colors !== "object") return {};
      return Object.fromEntries(Object.entries(colors).filter((e): e is [string, number] => Number.isInteger(e[1]) && e[1] >= 0 && e[1] < LABEL_COLORS));
    } catch {
      return {};
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, `${JSON.stringify({ colors: Object.fromEntries(this.colors) }, null, 2)}\n`);
      renameSync(`${this.file}.tmp`, this.file);
    } catch {
      // Only colours: a label that lost its colour takes one again when next seen.
    }
  }

  /** A label's colour, given one now if it has none. */
  colorOf(label: string): number {
    const known = this.colors.get(label);
    if (known !== undefined) return known;
    const used = Array.from({ length: LABEL_COLORS }, () => 0);
    for (const c of this.colors.values()) used[c]++;
    const color = used.indexOf(Math.min(...used));
    this.colors.set(label, color);
    this.save();
    return color;
  }

  /** Change a label's colour. */
  set(label: string, color: number): void {
    this.colors.set(label, color);
    this.save();
  }

  /** A label renamed: its colour goes with it (or, renamed onto one that exists, that one's stays). */
  rename(from: string, to: string): void {
    const color = this.colors.get(from);
    this.colors.delete(from);
    if (color !== undefined && !this.colors.has(to)) this.colors.set(to, color);
    this.save();
  }

  /** A label deleted. */
  remove(label: string): void {
    if (this.colors.delete(label)) this.save();
  }
}
