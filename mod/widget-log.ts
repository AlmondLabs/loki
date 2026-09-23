import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Scope, WidgetChange, WidgetLogEntry, WidgetManifestEntry } from "../core/desk-core.ts";
import type { WidgetsDiff } from "./widgets-fs.ts";

/**
 * Each desk's widget change log: what the agent added, changed or removed, and when, so a desk's
 * thread can show it among the messages after a reload. Fed by the watcher's scan diffs; stored as
 * <state>/widget-log/<scope>.json beside the desk snapshots; append-only apart from the two rules below.
 */

/**
 * Rows kept per desk, oldest dropped first. A busy desk sees a few dozen widget writes a day; 200 covers
 * weeks of a thread's scrollback while the file stays a few tens of KB.
 */
export const WIDGET_LOG_LIMIT = 200;

/**
 * Repeat edits to one widget this close together fold into its previous row. An agent often writes a
 * widget, then fixes it seconds later; that is one change to the reader. Measured from the row's
 * latest edit, so a burst of edits reads as one row.
 */
export const WIDGET_LOG_COLLAPSE_MS = 60_000;

const isEntry = (v: unknown): v is WidgetLogEntry => {
  const e = v as WidgetLogEntry;
  return typeof e === "object" && e !== null && typeof e.id === "string" && typeof e.at === "number" && typeof e.widgetId === "string" && typeof e.change === "string";
};

export class WidgetLog {
  private logs = new Map<Scope, WidgetLogEntry[]>();
  private readonly dir: string | null;

  /** dir null: memory only (tests). */
  constructor(dir: string | null) {
    this.dir = dir;
  }

  /** The desk's log, oldest first; empty for a desk that never had a change. */
  read(scope: Scope): WidgetLogEntry[] {
    return [...this.load(scope)];
  }

  /** Record one scan diff. Returns the rows appended or updated, to broadcast. */
  record(diff: WidgetsDiff, now = Date.now()): WidgetLogEntry[] {
    if (diff.initial) return []; // what was on disk when the mod started: not news
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
    const fields = { at, scope: e.scope, widgetId: e.id, name: e.name, title: e.title, kind: e.kind };
    if (change === "changed") {
      let i = log.length - 1;
      while (i >= 0 && log[i].widgetId !== e.id) i--;
      const prev = i >= 0 ? log[i] : null;
      if (prev && prev.change !== "removed" && at - prev.at < WIDGET_LOG_COLLAPSE_MS) {
        // Same row (id and change kept: an add then a quick fix still reads "added"), moved to its new time.
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

  private file(scope: Scope): string {
    return join(this.dir!, `${encodeURIComponent(scope)}.json`);
  }

  private load(scope: Scope): WidgetLogEntry[] {
    let log = this.logs.get(scope);
    if (log) return log;
    log = [];
    if (this.dir) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(this.file(scope), "utf8"));
        if (Array.isArray(parsed)) log = parsed.filter(isEntry).slice(-WIDGET_LOG_LIMIT);
      } catch {
        // none yet, or corrupt: start empty
      }
    }
    this.logs.set(scope, log);
    return log;
  }

  private persist(scope: Scope): void {
    if (!this.dir) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      const path = this.file(scope);
      writeFileSync(`${path}.tmp`, JSON.stringify(this.load(scope)));
      renameSync(`${path}.tmp`, path);
    } catch {
      // never break the desk over the log; the next change retries
    }
  }
}

/**
 * Record a scan diff and send each new or updated row as `widget_change { entry }` to every app socket,
 * not only the desk's own: the sidebar and the phone follow every desk.
 */
export function broadcastWidgetChanges(log: WidgetLog, diff: WidgetsDiff, broadcast: (msg: object, scope?: Scope) => void, now = Date.now()): void {
  for (const entry of log.record(diff, now)) broadcast({ type: "widget_change", entry });
}
