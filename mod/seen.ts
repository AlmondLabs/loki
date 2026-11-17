import { readFileSync } from "node:fs";
import { addFocus, combineFocus, pruneFocus, type FocusAction, type FocusEntry } from "../core/attention/focus.ts";
import { parseLanes, type Lane } from "../core/attention/lanes.ts";
import { isRest, isReturnTimes, type Rest, type ReturnTimes } from "../core/attention/rest.ts";
import type { Pushes } from "../core/frames.ts";
import { coalesce, type Burst } from "../core/timers.ts";
import { writeJsonAtomic } from "./json-file.ts";

export interface MarksSnapshot {
  seen: Record<string, string>;
  unseen: Record<string, string>;
  viewed: Record<string, string>;
  focus: Record<string, FocusEntry>;
  rests?: Record<string, Rest>;
  return_times?: ReturnTimesMark | null;
  lanes?: LanesMark | null;
}

/** The return times as one setting, with when it was set: between Macs the later one wins. */
export interface ReturnTimesMark {
  times: ReturnTimes;
  at: string;
}

const isReturnTimesMark = (v: unknown): v is ReturnTimesMark =>
  !!v && typeof v === "object" && isReturnTimes((v as Partial<ReturnTimesMark>).times) && typeof (v as Partial<ReturnTimesMark>).at === "string";

/** The lanes as one list, with when it was set: between Macs the later one wins, so a delete is a newer list. */
export interface LanesMark {
  lanes: Lane[];
  at: string;
}

function parseLanesMark(v: unknown): LanesMark | null {
  if (!v || typeof v !== "object") return null;
  const { lanes, at } = v as Partial<Record<keyof LanesMark, unknown>>;
  return Array.isArray(lanes) && typeof at === "string" ? { lanes: parseLanes(lanes), at } : null;
}

const REST_FORGET_MS = 30 * 24 * 60 * 60_000;
const PERSIST_DEBOUNCE_MS = 250;

export class SeenStore {
  private seen: Record<string, string> = {};
  private viewed: Record<string, string> = {};
  private focus: Record<string, FocusEntry> = {};
  private unseen: Record<string, string> = {};
  private remoteFocus: Record<string, Record<string, FocusEntry>> = {};
  private rests: Record<string, Rest> = {};
  private returns: ReturnTimesMark | null = null;
  private laneMark: LanesMark | null = null;
  private readonly path: string;
  private readonly now: () => string;
  private readonly writing: Burst;

  constructor(path: string, opts: { debounceMs?: number; now?: () => string } = {}) {
    this.path = path;
    this.writing = coalesce(() => this.write(), opts.debounceMs ?? PERSIST_DEBOUNCE_MS);
    this.now = opts.now ?? (() => new Date().toISOString());
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> | null;
      if (parsed && typeof parsed.seen === "object" && parsed.seen) {
        this.seen = parsed.seen as Record<string, string>;
        if (parsed.viewed && typeof parsed.viewed === "object") this.viewed = parsed.viewed as Record<string, string>;
        if (parsed.focus && typeof parsed.focus === "object") this.focus = parsed.focus as Record<string, FocusEntry>;
        if (parsed.unseen && typeof parsed.unseen === "object") this.unseen = parsed.unseen as Record<string, string>;
        if (parsed.remote_focus && typeof parsed.remote_focus === "object")
          this.remoteFocus = parsed.remote_focus as Record<string, Record<string, FocusEntry>>;
        if (parsed.rests && typeof parsed.rests === "object")
          this.rests = Object.fromEntries(Object.entries(parsed.rests as Record<string, unknown>).filter((e): e is [string, Rest] => isRest(e[1])));
        if (isReturnTimesMark(parsed.return_times)) this.returns = parsed.return_times;
        this.laneMark = parseLanesMark(parsed.lanes);
      } else {
        this.seen = parsed as Record<string, string>;
      }
    } catch {
      this.seen = {};
    }
  }

  static key(agentId: string | null | undefined, conversationId: string): string {
    return agentId ? `${agentId}/${conversationId}` : conversationId;
  }

  all(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.seen).filter(([key, at]) => !(this.unseen[key] && this.unseen[key] >= at)));
  }

  chat(agentId: string | null | undefined, conversationId: string): Pushes["seen_chat"] {
    const key = SeenStore.key(agentId, conversationId);
    const done = this.seen[key];
    return {
      key,
      seen: done && !(this.unseen[key] && this.unseen[key] >= done) ? done : null,
      viewed: this.viewed[key] ?? null,
      focus: this.focusAll()[key] ?? null,
      rest: this.rests[key] ?? null,
    };
  }

  viewedAll(): Record<string, string> {
    return { ...this.viewed };
  }

  focusAll(): Record<string, FocusEntry> {
    const others = Object.values(this.remoteFocus);
    return others.length ? combineFocus(this.focus, others, Date.parse(this.now())) : { ...this.focus };
  }

  restsAll(): Record<string, Rest> {
    return { ...this.rests };
  }

  rest(agentId: string | null | undefined, conversationId: string, rest: Rest): boolean {
    const key = SeenStore.key(agentId, conversationId);
    if (key in this.rests && this.rests[key].at >= rest.at) return false;
    const now = this.now();
    const forget = new Date(Date.parse(now) - REST_FORGET_MS).toISOString();
    this.rests = Object.fromEntries([...Object.entries(this.rests).filter(([, r]) => r.at >= forget || Date.parse(r.until) > Date.parse(now)), [key, rest]]);
    this.persist();
    return true;
  }

  returnTimes(): ReturnTimes | null {
    return this.returns?.times ?? null;
  }

  setReturnTimes(times: ReturnTimes): boolean {
    if (this.returns && JSON.stringify(this.returns.times) === JSON.stringify(times)) return false;
    this.returns = { times, at: this.now() };
    this.persist();
    return true;
  }

  lanes(): Lane[] {
    return this.laneMark?.lanes ?? [];
  }

  setLanes(lanes: Lane[]): boolean {
    if (this.laneMark && JSON.stringify(this.laneMark.lanes) === JSON.stringify(lanes)) return false;
    this.laneMark = { lanes, at: this.now() };
    this.persist();
    return true;
  }

  snapshot(): MarksSnapshot {
    return {
      seen: { ...this.seen },
      unseen: { ...this.unseen },
      viewed: { ...this.viewed },
      focus: { ...this.focus },
      rests: { ...this.rests },
      return_times: this.returns,
      lanes: this.laneMark,
    };
  }

  applyRemote(macId: string, snap: MarksSnapshot): boolean {
    let moved = false;
    const later = (mine: Record<string, string>, theirs: Record<string, string>) => {
      for (const [key, at] of Object.entries(theirs)) {
        if (typeof at !== "string" || (mine[key] && mine[key] >= at)) continue;
        mine[key] = at;
        moved = true;
      }
    };
    later(this.seen, snap.seen);
    later(this.unseen, snap.unseen);
    later(this.viewed, snap.viewed);
    for (const [key, rest] of Object.entries(snap.rests ?? {})) {
      if (!isRest(rest) || (key in this.rests && this.rests[key].at >= rest.at)) continue;
      this.rests = { ...this.rests, [key]: rest };
      moved = true;
    }
    const theirs = snap.return_times;
    if (isReturnTimesMark(theirs) && !(this.returns && this.returns.at >= theirs.at)) {
      this.returns = theirs;
      moved = true;
    }
    const lanes = parseLanesMark(snap.lanes);
    if (lanes && !(this.laneMark && this.laneMark.at >= lanes.at)) {
      this.laneMark = lanes;
      moved = true;
    }
    if (JSON.stringify(this.remoteFocus[macId] ?? {}) !== JSON.stringify(snap.focus)) {
      this.remoteFocus = { ...this.remoteFocus, [macId]: { ...snap.focus } };
      moved = true;
    }
    if (moved) this.persist();
    return moved;
  }

  forgetMac(macId: string): void {
    if (!(macId in this.remoteFocus)) return;
    const { [macId]: _, ...rest } = this.remoteFocus;
    this.remoteFocus = rest;
    this.persist();
  }

  engage(agentId: string | null | undefined, conversationId: string, action: FocusAction): boolean {
    const key = SeenStore.key(agentId, conversationId);
    const next = addFocus(this.focus[key], action, Date.parse(this.now()));
    if (!next) return false;
    this.focus = { ...pruneFocus(this.focus, Date.parse(this.now())), [key]: next };
    this.persist();
    return true;
  }

  mark(agentId: string | null | undefined, conversationId: string): boolean {
    return this.put(this.seen, SeenStore.key(agentId, conversationId), this.now());
  }

  view(agentId: string | null | undefined, conversationId: string): boolean {
    return this.put(this.viewed, SeenStore.key(agentId, conversationId), this.now());
  }

  unmark(agentId: string | null | undefined, conversationId: string): boolean {
    const key = SeenStore.key(agentId, conversationId);
    if (!(key in this.all())) return false;
    this.unseen = { ...this.unseen, [key]: this.now() };
    this.persist();
    return true;
  }

  flush(): void {
    this.writing.flush();
  }

  private put(map: Record<string, string>, key: string, value: string): boolean {
    if (map[key] === value) return false;
    map[key] = value;
    this.persist();
    return true;
  }

  private persist(): void {
    this.writing.schedule();
  }

  private write(): void {
    try {
      writeJsonAtomic(
        this.path,
        {
          seen: this.seen,
          ...(Object.keys(this.viewed).length ? { viewed: this.viewed } : {}),
          ...(Object.keys(this.focus).length ? { focus: this.focus } : {}),
          ...(Object.keys(this.unseen).length ? { unseen: this.unseen } : {}),
          ...(Object.keys(this.remoteFocus).length ? { remote_focus: this.remoteFocus } : {}),
          ...(Object.keys(this.rests).length ? { rests: this.rests } : {}),
          ...(this.returns ? { return_times: this.returns } : {}),
          ...(this.laneMark ? { lanes: this.laneMark } : {}),
        },
        { pretty: true },
      );
    } catch {}
  }
}
