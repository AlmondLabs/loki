import { extractHarnessEvents, messageFiles, stripHarnessMarkup, toolLabel, toolStep, withResult } from "../harness.ts";
import type { FileRef, ToolStep, TranscriptRow } from "./transcript.ts";

/**
 * A chat's thread, built in one place (GLOSSARY.md: ThreadModel). Every source of a conversation, the local log the
 * mod reads, the app-server's history and its live stream, is parsed into steps by its own adapter; this folds the
 * steps into rows, keeps the rows that arrived live (your own message the moment you sent it, a queued one, a slash
 * command's row, the reply as it streams), and reconciles them with a history page when one arrives. The rows it
 * hands out keep their identity until they change: the transcript's rows are memoised on it.
 */

/** One thing Letta reported, in the shape every source is parsed into. `at` is when it was written, null when unknown. */
export type Step =
  /** A user message as written: harness markup in it becomes event rows, the rest the bubble. */
  | { kind: "user"; raw: string; at: string | null }
  /** The agent's words: a whole message from history, or a streamed piece of the reply (`chunk`). */
  | { kind: "assistant"; text: string; at: string | null; chunk?: boolean }
  /** A tool call; the same id again carries more of its arguments as they stream in. */
  | { kind: "call"; name: string; args: unknown; id: string | null; at: string | null }
  /** The approval request for a call: it belongs to the open call of that tool when there is one. */
  | { kind: "approval"; name: string; args: unknown; id: string | null; at: string | null }
  /** What came back from the call with this id. */
  | { kind: "result"; id: string; output: unknown; failed: boolean };

/** A row as a history page carries it (the mod's local log, or the app-server's history folded): times may be null. */
export type HistoryRow = Omit<TranscriptRow, "at"> & { at?: string | null };

/** How a sent message is known again in its echo: its text, or for files alone, their paths. */
export function ownSendKey(text: string, files: Array<Pick<FileRef, "path">> = []): string {
  return text.trim() || files.map((f) => f.path).join("\n");
}

/** The command a row's text names: "/reload", "reload", "/compact all" → "reload", "reload", "compact". */
export function commandIdOf(input: string): string {
  return input.trim().replace(/^\//, "").split(/\s+/)[0]?.toLowerCase() ?? "";
}

const RUNNING = "running…";

/** The image markers a message's text carries for its pictures ("[image]" lines): not part of what was typed. */
const withoutImageMarks = (text: string) => text.replace(/(^|\n)\[image\](?=\n|$)/g, "").trim();

/** How a live row is known in a history page: role and text, a user message's picture lines left out (the page has them). */
const pairKey = (r: TranscriptRow) => `${r.role}\u0000${r.role === "user" ? withoutImageMarks(r.text) : r.text}`;

/** Still on its way: a message waiting for the turn to end, or a slash command waiting for its answer. */
const pending = (r: TranscriptRow) => r.queued === true || (r.role === "event" && r.summary === RUNNING);

const sameRow = (a: TranscriptRow, b: TranscriptRow) =>
  a.role === b.role && a.text === b.text && a.summary === b.summary && a.detail === b.detail && a.images === b.images && a.files === b.files && a.tool === b.tool && a.queued === b.queued && a.at === b.at;

const rowAt = (at: string | null | undefined): { at?: string } => (at ? { at } : {});

const instant = (iso: string | undefined) => (iso ? Date.parse(iso) : Number.NaN);

/** A history page's row as a transcript row: a null time left off. */
function fromHistory(m: HistoryRow): TranscriptRow {
  const { at, ...rest } = m;
  const row: TranscriptRow = { ...rest };
  if (!row.files?.length) delete row.files;
  if (at) row.at = at;
  return row;
}

export class ThreadModel {
  /** The last history page loaded; null until one is. */
  private history: TranscriptRow[] | null = null;
  /** Rows that arrived since that page, in order (the streaming reply is not one until it settles). */
  private tail: TranscriptRow[] = [];
  private streamingText = "";
  private streamingAt: string | null = null;
  /** Calls already shown, by id: the same id again is more of that call's arguments. */
  private readonly seen = new Set<string>();
  /** A call's arguments as they stream in, by id, until they parse. */
  private readonly args = new Map<string, string>();
  /** Keys of messages shown when they were sent (ownSendKey): their echo is not shown twice. */
  private readonly echoes: string[] = [];
  private readonly shown = new WeakMap<TranscriptRow, TranscriptRow>();
  private streamingRow: TranscriptRow | null = null;
  /** Goes up on every change, so a caller can tell whether a step moved anything. */
  revision = 0;

  /** Hears the reply each time one settles into a row: the conversation's last words for the Inbox. */
  private readonly settled?: (text: string) => void;

  constructor(settled?: (text: string) => void) {
    this.settled = settled;
  }

  /** Whether the agent's reply is streaming in right now. */
  get streaming(): boolean {
    return this.streamingText !== "";
  }

  /**
   * The thread as the transcript draws it: the history page, the rows since, then the streaming reply. Undefined
   * until a page was loaded or anything arrived. A row is the same object from one read to the next until it changes.
   */
  rows(): TranscriptRow[] | undefined {
    if (this.history === null && !this.tail.length && !this.streamingText) return undefined;
    const out = [...(this.history ?? []), ...this.tail.map((r) => this.copyOf(r))];
    if (this.streamingText) {
      const at = this.streamingAt ?? undefined;
      const was = this.streamingRow;
      if (!was || was.text !== this.streamingText || was.at !== at) this.streamingRow = { role: "assistant", text: this.streamingText, ...rowAt(at) };
      out.push(this.streamingRow!);
    }
    return out;
  }

  /** The rows a fold made, as they are: no snapshot for a thread nobody draws. */
  folded(): TranscriptRow[] {
    return this.tail;
  }

  /** The agent's whole last reply: the newest settled one, else what has streamed so far. */
  lastReply(): string {
    return [...this.tail].reverse().find((r) => r.role === "assistant")?.text ?? this.streamingText;
  }

  /** Fold one step in. `spoke` is the user message's words when one arrived (null for anything else). */
  apply(step: Step): { changed: boolean; spoke: string | null } {
    switch (step.kind) {
      case "user":
        return this.user(step.raw, step.at);
      case "assistant":
        if (step.chunk) {
          if (!step.text) return { changed: false, spoke: null };
          if (!this.streamingText) this.streamingAt = step.at;
          this.streamingText += step.text;
          this.touch();
          return { changed: true, spoke: null };
        }
        this.settle(step.at);
        if (step.text.trim()) this.push({ role: "assistant", text: step.text.trim(), ...rowAt(step.at) });
        return { changed: true, spoke: null };
      case "call":
        return { changed: this.call(step.name, step.args, step.id, step.at), spoke: null };
      case "approval":
        // The same call again, as its approval request: in history it keeps the call's id; live it has its own, or none.
        if ((step.id && this.seen.has(step.id)) || this.openCall(step.name)) return { changed: false, spoke: null };
        return { changed: this.call(step.name, step.args, step.id, step.at), spoke: null };
      case "result":
        return { changed: this.result(step.id, step.output, step.failed), spoke: null };
    }
  }

  /** Close the streaming reply into a row. True when there was one. */
  settle(at: string | null = null): boolean {
    const t = this.streamingText.trim();
    const had = this.streamingText !== "";
    if (t) this.tail.push({ role: "assistant", text: t, ...rowAt(this.streamingAt ?? at) });
    this.streamingText = "";
    this.streamingAt = null;
    if (had) this.touch();
    if (t) this.settled?.(t);
    return t !== "";
  }

  /**
   * A message you sent, shown at once; `echo` (its ownSendKey, empty for a picture alone) is how its echo from the
   * server is known and skipped.
   */
  own(row: TranscriptRow, echo?: string): void {
    this.push(row);
    if (echo !== undefined) this.echoes.push(echo);
  }

  /** A message going out that was already on screen (a queued one): its echo is skipped. */
  expectEcho(key: string): void {
    this.echoes.push(key);
  }

  /** A message typed mid-turn: shown as queued until it goes out. */
  queue(row: TranscriptRow): void {
    this.push({ ...row, queued: true });
  }

  /** A queued message went out: its row stops being queued and takes the time it left. */
  unqueue(text: string, at: string): void {
    const row = this.tail.find((r) => r.queued && r.role === "user" && r.text === text);
    if (!row) return;
    delete row.queued;
    row.at = at;
    this.touch();
  }

  /** A queued message taken back: its row goes. True when one matched. */
  dropQueued(text: string): boolean {
    const i = this.tail.findIndex((r) => r.queued && r.role === "user" && r.text === text);
    if (i < 0) return false;
    this.tail.splice(i, 1);
    this.touch();
    return true;
  }

  /** A slash command has started: one quiet row with the command line, marked running until its end arrives. */
  beginCommand(input: string, at: string): void {
    this.settle(at);
    this.push({ role: "event", text: input, summary: RUNNING, at });
  }

  /**
   * A slash command finished: the running row (or a fresh one, if the start was never seen) gets the
   * outcome — a one-line output inline, a longer one behind the disclosure, "failed" when it did not work.
   */
  finishCommand(input: string, success: boolean, output: string, at: string): void {
    const text = output.trim();
    const oneLine = text.split("\n").length === 1 && text.length <= 90;
    const summary = !success ? "failed" : oneLine ? text || "done" : "done";
    const detail = !oneLine && text ? text : null;
    const row = this.runningRow(input);
    if (!row) return this.push({ role: "event", text: input, summary, detail, at });
    row.summary = summary;
    row.detail = detail;
    this.touch();
  }

  /** True while a slash command's row is still waiting for its end. */
  commandRunning(input: string): boolean {
    return this.runningRow(input) !== undefined;
  }

  /**
   * The link to the app-server came back after dropping: a command still marked running lost its answer
   * with the old link, and nothing else will ever finish it. For /reload that is the success case — the
   * reload is what took the link down. Returns true when a row changed.
   */
  settleCommands(): boolean {
    let changed = false;
    for (const r of this.tail) {
      if (r.role !== "event" || r.summary !== RUNNING) continue;
      if (commandIdOf(r.text) === "reload") {
        r.summary = "reloaded — the mod restarted and the link is back";
        r.detail = null;
      } else {
        r.summary = "failed";
        r.detail = "the link to the app-server dropped while this ran; its answer was lost";
      }
      changed = true;
    }
    if (changed) this.touch();
    return changed;
  }

  /**
   * A history page arrived. The rows since the last one that it already holds (a call by its id, any other row by
   * role and text, paired from the end) give it their times and go; of the rest, a row stays after the page only
   * while it is still pending or arrived after the page's newest row. Rows the last page had lend their times too,
   * so a page without times keeps the ones the thread knew.
   */
  load(page: HistoryRow[]): void {
    if (!page.length && this.tail.length) {
      // An empty page (a log not written yet, a link that answered nothing) says nothing about the rows since.
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
    // A page with no times at all keeps only what is pending: nothing can be shown to be newer than it.
    const newest = rows.reduce((m, r) => (instant(r.at) > m ? instant(r.at) : m), -Infinity);
    const newer = (r: TranscriptRow) => Number.isFinite(newest) && instant(r.at) > newest;
    // A row since the last page was not in that page: it pairs only with a page row newer than the last page (or
    // untimed), never with an older message that says the same ("yes", "ok").
    const lastPage = (this.history ?? []).reduce((m, r) => (instant(r.at) > m ? instant(r.at) : m), -Infinity);
    const sinceLastPage = (k: string): number | undefined => {
      const list = byText.get(k);
      for (let n = (list?.length ?? 0) - 1; n >= 0; n--) {
        const i = list![n];
        if (!(instant(rows[i].at) <= lastPage)) return list!.splice(n, 1)[0];
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
    this.history = rows;
    this.tail = kept;
    this.touch();
  }

  private touch(): void {
    this.revision += 1;
  }

  private push(row: TranscriptRow): void {
    this.tail.push(row);
    this.touch();
  }

  private copyOf(r: TranscriptRow): TranscriptRow {
    const was = this.shown.get(r);
    if (was && sameRow(was, r)) return was;
    const copy = { ...r };
    this.shown.set(r, copy);
    return copy;
  }

  private user(raw: string, at: string | null): { changed: boolean; spoke: string | null } {
    // Harness machinery in the message (desk activity, a loaded skill, a task result) is its own quiet row.
    const events = extractHarnessEvents(raw);
    for (const ev of events) this.push({ role: "event", text: ev.text, summary: ev.summary, detail: ev.detail, ...rowAt(at) });
    const text = stripHarnessMarkup(raw).trim();
    const files = messageFiles(raw);
    if (!text && !files.length) return { changed: events.length > 0, spoke: null };
    this.settle(at);
    const own = this.echoes.indexOf(ownSendKey(withoutImageMarks(text), files));
    if (own >= 0) this.echoes.splice(own, 1); // shown when it was sent
    else this.push({ role: "user", text, ...rowAt(at), ...(files.length ? { files } : {}) });
    return { changed: true, spoke: text };
  }

  private call(name: string, args: unknown, id: string | null, at: string | null): boolean {
    if (id && this.seen.has(id)) {
      // The input streams in pieces after the call is announced: keep adding it until it parses, then show it.
      const sofar = typeof args === "string" ? (this.args.get(id) ?? "") + args : args;
      if (typeof sofar === "string") this.args.set(id, sofar);
      return this.updateInput(id, name, sofar);
    }
    if (!id && this.openCall(name)) return false; // a call without an id: more of the open one
    if (id) {
      this.seen.add(id);
      if (typeof args === "string") this.args.set(id, args);
    }
    this.settle(at); // assistant text may resume after the tool; this closes the current bubble
    this.push({ role: "tool", text: toolLabel(name, args), ...rowAt(at), tool: toolStep(name, args, id) });
    return true;
  }

  /** The newest call of this tool with no result yet and nothing said after it: an approval request belongs to it. */
  private openCall(name: string): TranscriptRow | null {
    if (this.streamingText.trim()) return null;
    // The rows since the page, then the page's own end: a load may have taken the call before its approval came.
    for (const rows of [this.tail, this.history ?? []]) {
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i];
        if (r.role === "user" || r.role === "assistant") return null;
        if (r.role === "tool" && (r.tool?.name ?? r.text) === name && r.tool?.output === undefined && !r.tool?.failed) return r;
      }
    }
    return null;
  }

  /** A streamed call's input grew: its row gets the label and input it now parses to (a new row object), if either changed. */
  private updateInput(id: string, name: string, args: unknown): boolean {
    const at = this.tail.findIndex((row) => row.tool?.id === id);
    if (at < 0) return false;
    const row = this.tail[at];
    const step = toolStep(name, args, id);
    const text = toolLabel(name, args);
    if (step.input === row.tool?.input && step.description === row.tool?.description && text === row.text) return false;
    this.tail[at] = { ...row, text, tool: { ...row.tool, ...step } };
    this.touch();
    return true;
  }

  /** A call's result: onto its row, among the rows since the page or, when the page took the call, in the page. */
  private result(id: string, output: unknown, failed: boolean): boolean {
    this.args.delete(id);
    // The row is replaced, not changed in place: a row that changed is a new object.
    const onto = (rows: TranscriptRow[] | null): boolean => {
      let i = (rows?.length ?? 0) - 1;
      while (i >= 0 && rows![i].tool?.id !== id) i--;
      if (i < 0) return false;
      rows![i] = { ...rows![i], tool: withResult(rows![i].tool as ToolStep, output, failed) };
      return true;
    };
    if (!onto(this.tail) && !onto(this.history)) return false;
    this.touch();
    return true;
  }

  /**
   * The running row a finish belongs to: the newest with the same text, else the newest naming the same
   * command. The harness writes the command line its own way in its start delta ("reload", say) while the
   * app finishes with what it sent ("/reload"); matched by text alone the row would spin forever.
   */
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

/** Steps from one source, folded into the rows they make: how a history page is built from a log or a message list. */
export function foldSteps(steps: Step[]): TranscriptRow[] {
  const t = new ThreadModel();
  for (const s of steps) t.apply(s);
  t.settle();
  return t.folded();
}
