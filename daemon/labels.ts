import { readFileSync } from "node:fs";
import { LABEL_COLORS } from "../core/labels.ts";
import { writeJsonAtomic } from "../mod/json-file.ts";

/** A Mac's label colours for another: each colour, and when the person chose it. */
export interface LabelColorsSnapshot {
  colors: Record<string, number>;
  changed: Record<string, string>;
}

const LONG_AGO = "1970-01-01T00:00:00.000Z";

export class LabelColors {
  private readonly colors: Map<string, number>;
  private readonly changed: Map<string, string>;
  private readonly file: string | undefined;
  private readonly now: () => string;

  constructor(file?: string, now: () => string = () => new Date().toISOString()) {
    this.file = file;
    this.now = now;
    this.colors = new Map(Object.entries(this.read()));
    this.changed = new Map(Object.entries(this.readChanged()));
  }

  private readChanged(): Record<string, string> {
    try {
      const parsed: unknown = this.file ? JSON.parse(readFileSync(this.file, "utf8")) : null;
      const changed = parsed && typeof parsed === "object" ? (parsed as { changed?: unknown }).changed : null;
      return changed && typeof changed === "object"
        ? Object.fromEntries(Object.entries(changed).filter((e): e is [string, string] => typeof e[1] === "string"))
        : {};
    } catch {
      return {};
    }
  }

  snapshot(): LabelColorsSnapshot {
    return { colors: Object.fromEntries(this.colors), changed: Object.fromEntries(this.changed) };
  }

  apply(theirs: LabelColorsSnapshot): boolean {
    let moved = false;
    for (const [label, color] of Object.entries(theirs.colors)) {
      if (!Number.isInteger(color) || color < 0 || color >= LABEL_COLORS) continue;
      const at = theirs.changed[label] ?? LONG_AGO;
      const mine = this.colors.has(label) ? (this.changed.get(label) ?? LONG_AGO) : null;
      if (mine !== null && mine >= at) continue;
      if (this.colors.get(label) === color && mine !== null) continue;
      this.colors.set(label, color);
      this.changed.set(label, at);
      moved = true;
    }
    if (moved) this.save();
    return moved;
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
      const changed = this.changed.size ? { changed: Object.fromEntries(this.changed) } : {};
      writeJsonAtomic(this.file, { colors: Object.fromEntries(this.colors), ...changed }, { pretty: true, newline: true });
    } catch {}
  }

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

  set(label: string, color: number): void {
    this.colors.set(label, color);
    this.changed.set(label, this.now());
    this.save();
  }

  rename(from: string, to: string): void {
    const color = this.colors.get(from);
    this.colors.delete(from);
    if (color !== undefined && !this.colors.has(to)) this.colors.set(to, color);
    this.save();
  }

  remove(label: string): void {
    if (this.colors.delete(label)) this.save();
  }
}
