import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Scope, WidgetActor, WidgetChange, WidgetLogEntry, WidgetManifestEntry } from "../core/desk-core.ts";
import type { WidgetsDiff } from "./widgets-fs.ts";
import { writeJsonAtomic } from "./json-file.ts";

export const WIDGET_LOG_LIMIT = 200;

export const WIDGET_LOG_COLLAPSE_MS = 60_000;

export const WIDGET_LOG_EXPECT_MS = 5_000;

const isEntry = (v: unknown): v is WidgetLogEntry => {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.id === "string" && typeof e.at === "number" && typeof e.widget_id === "string" && typeof e.change === "string";
};

export class WidgetLog {
  private logs = new Map<Scope, WidgetLogEntry[]>();
  private expected = new Map<string, { by: WidgetActor; at: number }>();
  private readonly dir: string | null;

  constructor(dir: string | null) {
    this.dir = dir;
  }

  read(scope: Scope): WidgetLogEntry[] {
    return [...this.load(scope)];
  }

  expect(widgetId: string, change: WidgetChange, by: WidgetActor, now = Date.now()): void {
    this.expected.set(`${widgetId} ${change}`, { by, at: now });
  }

  private actor(widgetId: string, change: WidgetChange, now: number): WidgetActor {
    const key = `${widgetId} ${change}`;
    const hit = this.expected.get(key);
    for (const [k, v] of this.expected) if (now - v.at > WIDGET_LOG_EXPECT_MS) this.expected.delete(k);
    if (!hit || now - hit.at > WIDGET_LOG_EXPECT_MS) return "agent";
    this.expected.delete(key);
    return hit.by;
  }

  record(diff: WidgetsDiff, now = Date.now()): WidgetLogEntry[] {
    if (diff.initial) return [];
    const out: WidgetLogEntry[] = [];
    const touched = new Set<Scope>();
    const add = (e: WidgetManifestEntry, change: WidgetChange) => {
      out.push(this.append(e, change, now));
      touched.add(e.scope);
    };
    for (const e of diff.added) add(e, "added");
    for (const e of diff.changed) add(e, "changed");
    for (const e of diff.removedEntries) add(e, "removed");
    for (const scope of touched) this.persist(scope);
    return out;
  }

  private append(e: WidgetManifestEntry, change: WidgetChange, at: number): WidgetLogEntry {
    const log = this.load(e.scope);
    const by = this.actor(e.id, change, at);
    const fields = { at, scope: e.scope, widget_id: e.id, name: e.name, title: e.title, kind: e.kind, by };
    if (change === "changed") {
      let i = log.length - 1;
      while (i >= 0 && log[i].widget_id !== e.id) i--;
      const prev = i >= 0 ? log[i] : null;
      if (prev && prev.change !== "removed" && (prev.by ?? "agent") === by && at - prev.at < WIDGET_LOG_COLLAPSE_MS) {
        const row: WidgetLogEntry = { ...prev, ...fields };
        log.splice(i, 1);
        log.push(row);
        return row;
      }
    }
    const row: WidgetLogEntry = { id: randomBytes(6).toString("hex"), ...fields, change };
    log.push(row);
    if (log.length > WIDGET_LOG_LIMIT) log.splice(0, log.length - WIDGET_LOG_LIMIT);
    return row;
  }

  private file(dir: string, scope: Scope): string {
    return join(dir, `${encodeURIComponent(scope)}.json`);
  }

  private load(scope: Scope): WidgetLogEntry[] {
    let log = this.logs.get(scope);
    if (log) return log;
    log = [];
    if (this.dir) {
      try {
        const parsed = JSON.parse(readFileSync(this.file(this.dir, scope), "utf8")) as unknown;
        if (Array.isArray(parsed)) log = parsed.filter(isEntry).slice(-WIDGET_LOG_LIMIT);
      } catch {}
    }
    this.logs.set(scope, log);
    return log;
  }

  private persist(scope: Scope): void {
    if (!this.dir) return;
    try {
      writeJsonAtomic(this.file(this.dir, scope), this.load(scope));
    } catch {}
  }
}

export function broadcastWidgetChanges(log: WidgetLog, diff: WidgetsDiff, broadcast: (msg: object, scope?: Scope) => void, now = Date.now()): void {
  for (const entry of log.record(diff, now)) broadcast({ type: "widget_change", entry });
}
