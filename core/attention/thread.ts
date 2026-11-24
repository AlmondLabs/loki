import { extractHarnessEvents, messageFiles, stripHarnessMarkup, toolLabel, toolStep, withResult } from "../harness.ts";
import { THOUGHT_MAX, type FileRef, type TranscriptRow } from "./transcript.ts";

/** One thing the harness reported, in the shape every source is parsed into. `at` is when it was written, null when unknown. */
export type Step =
  /**
   * A user message as written: harness markup in it becomes event rows, the rest the bubble. `images` names its
   * pictures as the mod serves them (plan 029, `/chat-images/<name>`), when the source kept them.
   */
  | { kind: "user"; raw: string; at: string | null; images?: string[] }
  /** The agent's words: a whole message from history, or a streamed piece of the reply (`chunk`). */
  | { kind: "assistant"; text: string; at: string | null; chunk?: boolean }
  /**
   * What the agent thought (plan 097, U9): a streamed piece (`chunk`), or the whole of it from a stored message. It
   * rides the reply or call that follows it as that row's `thought`.
   */
  | { kind: "thinking"; text: string; at: string | null; chunk?: boolean }
  /**
   * A tool call; the same id again carries more of its arguments as they stream in. `tool_kind` is an ACP agent's kind
   * for the call (`read`, `edit`, `execute`…), kept on the stored call too.
   */
  | { kind: "call"; name: string; args: unknown; id: string | null; at: string | null; tool_kind?: string }
  /** The approval request for a call: it belongs to the open call of that tool when there is one. */
  | { kind: "approval"; name: string; args: unknown; id: string | null; at: string | null }
  /** What came back from the call with this id. */
  | { kind: "result"; id: string; output: unknown; failed: boolean }
  /** A model call that ended in an error with nothing said (plan 037): the provider's message, from history and live alike. */
  | { kind: "failed"; message: string; at: string | null }
  /**
   * A compaction (plan 078): one that holds the turn up is `running`; its summary written is `done`, with the summary as
   * `detail`; it `failed`, with the error as `detail`; or it `ended` with neither, a summary that went unused.
   */
  | { kind: "compaction"; state: "running" | "done" | "failed" | "ended"; detail: string | null; at: string | null };

export type StoredStep = Step & { chunk?: false };

/** A row as a history page carries it (the mod's history_get, from the daemon's projection): times may be null. */
export type HistoryRow = Omit<TranscriptRow, "at"> & { at?: string | null };

export function ownSendKey(text: string, files: Array<Pick<FileRef, "path">> = []): string {
  return text.trim() || files.map((f) => f.path).join("\n");
}

export function commandIdOf(input: string): string {
  return input.trim().replace(/^\//, "").split(/\s+/)[0]?.toLowerCase() ?? "";
}

const RUNNING = "running…";

export const COMPACTED_TEXT = "chat compacted";
const COMPACTING_TEXT = "compacting the chat";
const COMPACTING = "summarising earlier turns…";
const COMPACTION_FAILED_TEXT = "compaction failed";

const withoutImageMarks = (text: string) => text.replace(/(^|\n)\[image\](?=\n|$)/g, "").trim();

const pairKey = (r: TranscriptRow) => `${r.role}\u0000${r.role === "user" ? withoutImageMarks(r.text) : r.text}`;

const pending = (r: TranscriptRow) => r.queued === true || (r.role === "event" && (r.summary === RUNNING || r.summary === COMPACTING));

const sameRow = (a: TranscriptRow, b: TranscriptRow) =>
  a.role === b.role &&
  a.text === b.text &&
  a.summary === b.summary &&
  a.detail === b.detail &&
  a.row === b.row &&
  a.images === b.images &&
  a.files === b.files &&
  a.tool === b.tool &&
  a.queued === b.queued &&
  a.link === b.link &&
  a.advisor_chat === b.advisor_chat &&
  a.command === b.command &&
  a.at === b.at;

const sameValue = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

const samePageRow = (a: TranscriptRow, b: TranscriptRow) =>
  a.role === b.role &&
  a.text === b.text &&
  a.summary === b.summary &&
  a.detail === b.detail &&
  a.row === b.row &&
  a.at === b.at &&
  a.queued === b.queued &&
  sameValue(a.images, b.images) &&
  sameValue(a.files, b.files) &&
  sameValue(a.tool, b.tool) &&
  sameValue(a.link, b.link) &&
  a.advisor_chat === b.advisor_chat &&
  a.command === b.command;

const rowAt = (at: string | null | undefined): { at?: string } => (at ? { at } : {});

export const MODEL_ERROR_TEXT = "the model could not be reached";
const MODEL_ERROR_CHARS = 300;

const instant = (iso: string | undefined) => (iso ? Date.parse(iso) : Number.NaN);

function fromHistory(m: HistoryRow): TranscriptRow {
  const { at, ...rest } = m;
  const row: TranscriptRow = { ...rest };
  if (!row.files?.length) delete row.files;
  if (at) row.at = at;
  return row;
}

export class ThreadModel {
  private history: TranscriptRow[] | null = null;
  private historyStart: number | null = null;
  private tail: TranscriptRow[] = [];
  private readonly modelErrors = new WeakMap<TranscriptRow, number>();
  private streamingText = "";
  private streamingAt: string | null = null;
  private thinking = "";
  private thinkingAt: string | null = null;
  private readonly seen = new Set<string>();
  private readonly args = new Map<string, string>();
  private readonly echoes: string[] = [];
  private readonly shown = new WeakMap<TranscriptRow, TranscriptRow>();
  private streamingRow: TranscriptRow | null = null;
  private drawn: { revision: number; rows: TranscriptRow[] | undefined } | null = null;
  revision = 0;

  private readonly settled?: (text: string) => void;

  constructor(settled?: (text: string) => void) {
    this.settled = settled;
  }

  get firstPosition(): number | null {
    return this.historyStart;
  }

  get streaming(): boolean {
    return this.streamingText !== "";
  }

  rows(): TranscriptRow[] | undefined {
    if (this.drawn?.revision !== this.revision) this.drawn = { revision: this.revision, rows: this.draw() };
    return this.drawn.rows;
  }

  private draw(): TranscriptRow[] | undefined {
    if (this.history === null && !this.tail.length && !this.streamingText) return undefined;
    const out = [...(this.history ?? []), ...this.tail.map((r) => this.copyOf(r))];
    if (this.streamingText) {
      const at = this.streamingAt ?? undefined;
      let row = this.streamingRow;
      if (row?.text !== this.streamingText || row.at !== at) {
        row = { role: "assistant", text: this.streamingText, ...rowAt(at) };
        this.streamingRow = row;
      }
      out.push(row);
    }
    return out;
  }

  folded(): TranscriptRow[] {
    return this.tail;
  }

  lastReply(): string {
    return [...this.tail].reverse().find((r) => r.role === "assistant")?.text ?? this.streamingText;
  }

  apply(step: Step): { changed: boolean; spoke: string | null } {
    switch (step.kind) {
      case "user":
        return this.user(step.raw, step.at, step.images);
      case "assistant":
        if (step.chunk) {
          if (!step.text) return { changed: false, spoke: null };
          if (!this.streamingText) this.streamingAt = step.at;
          this.streamingText += step.text;
          this.touch();
          return { changed: true, spoke: null };
        }
        return this.written(step.text, step.at);
      case "thinking":
        if (!this.thinking) this.thinkingAt = step.at;
        this.thinking = step.chunk ? this.thinking + step.text : step.text;
        return { changed: false, spoke: null };
      case "call":
        return { changed: this.call(step.name, step.args, step.id, step.at, step.tool_kind), spoke: null };
      case "approval":
        if ((step.id && this.seen.has(step.id)) || this.openCall(step.name)) return { changed: false, spoke: null };
        return { changed: this.call(step.name, step.args, step.id, step.at), spoke: null };
      case "result":
        return { changed: this.result(step.id, step.output, step.failed), spoke: null };
      case "failed":
        return this.modelFailed(step.message, step.at);
      case "compaction":
        return { changed: this.compaction(step.state, step.detail, step.at), spoke: null };
    }
  }

  private compaction(state: "running" | "done" | "failed" | "ended", detail: string | null, at: string | null): boolean {
    let i = this.tail.length - 1;
    while (i >= 0 && !(this.tail[i].role === "event" && this.tail[i].summary === COMPACTING)) i--;
    if (state === "running") {
      if (i >= 0) return false;
      this.push({ role: "event", text: COMPACTING_TEXT, summary: COMPACTING, ...rowAt(at) });
      return true;
    }
    if (state === "ended") {
      if (i < 0) return false;
      this.tail.splice(i, 1);
      this.touch();
      return true;
    }
    const row: TranscriptRow = { role: "event", text: state === "done" ? COMPACTED_TEXT : COMPACTION_FAILED_TEXT, summary: null, detail, ...rowAt(at) };
    if (i < 0) this.push(row);
    else {
      this.tail[i] = row;
      this.touch();
    }
    return true;
  }

  private modelFailed(message: string, at: string | null): { changed: boolean; spoke: string | null } {
    this.streamingText = "";
    this.streamingAt = null;
    const detail = message.length > MODEL_ERROR_CHARS ? `${message.slice(0, MODEL_ERROR_CHARS - 1)}…` : message;
    const last = this.tail.at(-1);
    const tries = last ? this.modelErrors.get(last) : undefined;
    if (last && tries !== undefined && last.detail === detail) {
      const row = { ...last, summary: `${tries + 1} tries` };
      this.tail[this.tail.length - 1] = row;
      this.modelErrors.set(row, tries + 1);
      this.touch();
      return { changed: true, spoke: null };
    }
    const row: TranscriptRow = { role: "event", text: MODEL_ERROR_TEXT, summary: null, detail, ...rowAt(at) };
    this.modelErrors.set(row, 1);
    this.push(row);
    return { changed: true, spoke: null };
  }

  private written(text: string, at: string | null): { changed: boolean; spoke: string | null } {
    const replaced = this.streamingText !== "";
    this.streamingText = "";
    this.streamingAt = null;
    const t = text.trim();
    const last = this.tail.at(-1);
    if (t && last && this.modelErrors.has(last)) this.tail.pop();
    if (t) this.push({ role: "assistant", text: t, ...rowAt(at) });
    else if (replaced) this.touch();
    if (t) this.settled?.(t);
    return { changed: replaced || t !== "", spoke: null };
  }

  resume(text: string, at: string | null): boolean {
    if (!text || this.streamingText === text) return false;
    this.streamingText = text;
    this.streamingAt = at;
    this.touch();
    return true;
  }

  settle(at: string | null = null): boolean {
    const t = this.streamingText.trim();
    const had = this.streamingText !== "";
    if (t) this.tail.push(this.thoughtOnto({ role: "assistant", text: t, ...rowAt(this.streamingAt ?? at) }, this.streamingAt ?? at));
    this.streamingText = "";
    this.streamingAt = null;
    if (had) this.touch();
    if (t) this.settled?.(t);
    return t !== "";
  }

  own(row: TranscriptRow, echo?: string): void {
    this.push(row);
    if (echo !== undefined) this.echoes.push(echo);
  }

  expectEcho(key: string): void {
    this.echoes.push(key);
  }

  queue(row: TranscriptRow): void {
    this.push({ ...row, queued: true });
  }

  unqueue(text: string, at: string): void {
    const row = this.tail.find((r) => r.queued && r.role === "user" && r.text === text);
    if (!row) return;
    delete row.queued;
    row.at = at;
    this.touch();
  }

  dropQueued(text: string): boolean {
    const i = this.tail.findIndex((r) => r.queued && r.role === "user" && r.text === text);
    if (i < 0) return false;
    this.tail.splice(i, 1);
    this.touch();
    return true;
  }

  beginCommand(input: string, at: string): void {
    this.settle(at);
    this.push({ role: "event", text: input, summary: RUNNING, at });
  }

  finishCommand(input: string, success: boolean, output: string, at: string): void {
    const text = output.trim();
    const oneLine = text.split("\n").length === 1 && text.length <= 90;
    const summary = !success ? (oneLine && text ? `failed: ${text}` : "failed") : oneLine ? text || "done" : "done";
    const detail = !oneLine && text ? text : null;
    const row = this.runningRow(input);
    if (!row) return this.push({ role: "event", text: input, summary, detail, at });
    row.summary = summary;
    row.detail = detail;
    this.touch();
  }

  commandRunning(input: string): boolean {
    return this.runningRow(input) !== undefined;
  }

  settleCommands(): boolean {
    let changed = false;
    for (const r of this.tail) {
      if (r.role !== "event" || r.summary !== RUNNING) continue;
      if (commandIdOf(r.text) === "reload") {
        r.summary = "reloaded — the mod restarted and the link is back";
        r.detail = null;
      } else {
        r.summary = "failed";
        r.detail = "the link to loki's daemon dropped while this ran; its answer was lost";
      }
      changed = true;
    }
    if (changed) this.touch();
    return changed;
  }

  load(page: HistoryRow[], start: number): void {
    if (!page.length && this.tail.length) {
      this.history ??= [];
      this.touch();
      return;
    }
    const rows = page.map(fromHistory);
    const byId = new Map<string, number>();
    const byText = new Map<string, number[]>();
    rows.forEach((r, i) => {
      if (r.tool?.id) byId.set(r.tool.id, i);
      else {
        const k = pairKey(r);
        const list = byText.get(k);
        if (list) list.push(i);
        else byText.set(k, [i]);
      }
    });
    const newest = rows.reduce((m, r) => (instant(r.at) > m ? instant(r.at) : m), -Infinity);
    const newer = (r: TranscriptRow) => Number.isFinite(newest) && instant(r.at) > newest;
    const lastPage = (this.history ?? []).reduce((m, r) => (instant(r.at) > m ? instant(r.at) : m), -Infinity);
    const sinceLastPage = (k: string): number | undefined => {
      const list = byText.get(k);
      if (!list) return undefined;
      for (let n = list.length - 1; n >= 0; n--) {
        const i = list[n];
        if (!(instant(rows[i].at) <= lastPage)) return list.splice(n, 1)[0];
      }
      return undefined;
    };
    const lend = (i: number, at: string | undefined) => {
      if (!rows[i].at && at) rows[i] = { ...rows[i], at };
    };
    const kept: TranscriptRow[] = [];
    for (let k = this.tail.length - 1; k >= 0; k--) {
      const r = this.tail[k];
      if (pending(r)) {
        kept.unshift(r);
        continue;
      }
      const id = r.tool?.id;
      const i = id ? byId.get(id) : sinceLastPage(pairKey(r));
      if (i !== undefined) {
        if (id) byId.delete(id);
        lend(i, r.at);
      } else if (newer(r)) kept.unshift(r);
    }
    for (const r of [...(this.history ?? [])].reverse()) {
      const i = r.tool?.id ? byId.get(r.tool.id) : byText.get(pairKey(r))?.pop();
      if (i !== undefined) lend(i, r.at);
    }
    const was = this.history ?? [];
    const wasStart = this.historyStart;
    let front: TranscriptRow[] = [];
    if (wasStart !== null) {
      for (let i = 0; i < rows.length; i++) {
        const old = was[start + i - wasStart] as TranscriptRow | undefined;
        if (old && samePageRow(old, rows[i])) rows[i] = old;
      }
      if (wasStart < start) front = was.slice(0, start - wasStart);
    }
    this.history = front.length ? [...front, ...rows] : rows;
    this.historyStart = front.length ? wasStart : start;
    this.tail = kept;
    this.touch();
  }

  prepend(page: HistoryRow[], start: number): void {
    if (this.history === null || this.historyStart === null) return;
    const take = Math.max(0, Math.min(page.length, this.historyStart - start));
    if (!take) return;
    this.history = [...page.slice(0, take).map(fromHistory), ...this.history];
    this.historyStart -= take;
    this.touch();
  }

  private touch(): void {
    this.revision += 1;
  }

  private push(row: TranscriptRow): void {
    this.tail.push(this.thoughtOnto(row, row.at ?? null));
    this.touch();
  }

  private thoughtOnto(row: TranscriptRow, end: string | null): TranscriptRow {
    if (!this.thinking) return row;
    const thought = this.thinking.trim();
    const began = this.thinkingAt;
    this.thinking = "";
    this.thinkingAt = null;
    if (row.role === "user" || !thought) return row;
    const ms = began && end ? Date.parse(end) - Date.parse(began) : Number.NaN;
    return {
      ...row,
      thought: thought.length > THOUGHT_MAX ? `${thought.slice(0, THOUGHT_MAX - 1)}…` : thought,
      ...(ms > 0 ? { thought_ms: ms } : {}),
    };
  }

  private copyOf(r: TranscriptRow): TranscriptRow {
    const was = this.shown.get(r);
    if (was && sameRow(was, r)) return was;
    const copy = { ...r };
    this.shown.set(r, copy);
    return copy;
  }

  private user(raw: string, at: string | null, images: readonly string[] = []): { changed: boolean; spoke: string | null } {
    const events = extractHarnessEvents(raw);
    for (const ev of events)
      this.push({
        role: "event",
        text: ev.text,
        summary: ev.summary,
        detail: ev.detail,
        ...(ev.link ? { link: ev.link } : {}),
        ...(ev.advisor_chat ? { advisor_chat: ev.advisor_chat } : {}),
        ...(ev.command ? { command: ev.command } : {}),
        ...rowAt(at),
      });
    const typed = stripHarnessMarkup(raw).trim();
    const text = images.length ? withoutImageMarks(typed) : typed;
    const files = messageFiles(raw);
    if (!text && !files.length && !images.length) return { changed: events.length > 0, spoke: null };
    this.settle(at);
    const own = this.echoes.indexOf(ownSendKey(withoutImageMarks(text), files));
    if (own >= 0) this.echoes.splice(own, 1);
    else this.push({ role: "user", text, ...rowAt(at), ...(files.length ? { files } : {}), ...(images.length ? { images: [...images] } : {}) });
    return { changed: true, spoke: text };
  }

  private call(name: string, args: unknown, id: string | null, at: string | null, kind?: string): boolean {
    if (id && this.seen.has(id)) {
      const sofar = typeof args === "string" ? (this.args.get(id) ?? "") + args : args;
      if (typeof sofar === "string") this.args.set(id, sofar);
      return this.updateInput(id, name, sofar, kind);
    }
    if (!id && this.openCall(name)) return false;
    if (id) {
      this.seen.add(id);
      if (typeof args === "string") this.args.set(id, args);
    }
    this.settle(at);
    this.push({ role: "tool", text: toolLabel(name, args), ...rowAt(at), tool: toolStep(name, args, id, kind) });
    return true;
  }

  private openCall(name: string): TranscriptRow | null {
    if (this.streamingText.trim()) return null;
    for (const rows of [this.tail, this.history ?? []]) {
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i];
        if (r.role === "user" || r.role === "assistant") return null;
        if (r.role === "tool" && (r.tool?.name ?? r.text) === name && r.tool?.output === undefined && !r.tool?.failed && r.tool?.row === undefined) return r;
      }
    }
    return null;
  }

  private updateInput(id: string, name: string, args: unknown, kind?: string): boolean {
    const at = this.tail.findIndex((row) => row.tool?.id === id);
    if (at < 0) return false;
    const row = this.tail[at];
    const step = toolStep(name, args, id, kind);
    const text = toolLabel(name, args);
    if (step.input === row.tool?.input && step.description === row.tool?.description && step.acp_kind === row.tool?.acp_kind && text === row.text) return false;
    this.tail[at] = { ...row, text, tool: { ...row.tool, ...step } };
    this.touch();
    return true;
  }

  private result(id: string, output: unknown, failed: boolean): boolean {
    this.args.delete(id);
    const onto = (rows: TranscriptRow[] | null): boolean => {
      if (!rows) return false;
      let i = rows.length - 1;
      while (i >= 0 && rows[i].tool?.id !== id) i--;
      const row = rows[i];
      if (i < 0 || !row.tool) return false;
      rows[i] = { ...row, tool: withResult(row.tool, output, failed) };
      return true;
    };
    if (!onto(this.tail) && !onto(this.history)) return false;
    this.touch();
    return true;
  }

  private runningRow(input: string): TranscriptRow | undefined {
    const id = commandIdOf(input);
    let byId: TranscriptRow | undefined;
    for (let i = this.tail.length - 1; i >= 0; i--) {
      const r = this.tail[i];
      if (r.role !== "event" || r.summary !== RUNNING) continue;
      if (r.text === input) return r;
      if (!byId && commandIdOf(r.text) === id) byId = r;
    }
    return byId;
  }
}

export function foldSteps(steps: Step[]): TranscriptRow[] {
  const t = new ThreadModel();
  for (const s of steps) t.apply(s);
  t.settle();
  return t.folded();
}
