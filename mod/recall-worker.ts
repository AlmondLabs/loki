import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "./ws.ts";
import { AppServerSocket, type Runtime, type ServerEvent } from "../core/attention/protocol.ts";
import type { Transport } from "../core/attention/transport.ts";
import { applyEvent, emptyLive } from "../core/attention/model.ts";
import { LEADS_PER_CONVERSATION, MAX_TRANSCRIPT_CHARS, buildPrompt, parseExtraction, similarFront, type Slice } from "../core/recall/extract.ts";
import { scopeFor, type WidgetChange } from "../core/desk-core.ts";
import { keepsFailing } from "../core/recall/fsrs.ts";
import { learnTitle, type Card, type Lead } from "../core/recall/model.ts";
import { appServerHeaders } from "./app-server.ts";
import { readLocalTranscriptSince, type InboxRow, type LocalTranscriptMessage } from "./desks.ts";
import { log } from "./log.ts";
import { RecallStore, newCardId } from "./recall.ts";
import { paths } from "./paths.ts";

/**
 * The recall worker: the only writer of cards. On a timer it looks for conversations that have gone
 * quiet with text the worker has not read yet, hands the new stretch to a model together with the
 * existing cards and the rejected pile, and writes whatever comes back — new cards up to the day's
 * cap, revisions to cards the conversation corrected, rewrites of cards the person keeps failing — and
 * learning leads (core/recall/model.ts Lead), which come out of the same call. The card cap is a limit on
 * the deck, not on reading: once the day's cards are written, the card cursor waits for tomorrow while a
 * second cursor keeps looking for leads, so a busy day is not a lead-less one.
 * It never posts anywhere: the person meets its work in the Learn section and nowhere else.
 *
 * The model is asked through the harness, in one long-running hidden conversation per agent named "recall"
 * (`writerConversation`), so the agent's own memory informs the cards while no transcript the person reads
 * is touched. Each ask is self-contained; after the reply the conversation is compacted (`/compact all`),
 * so the next ask starts from a short summary rather than every transcript ever sent — the in-context
 * messages stay small while the transcript on disk keeps everything. (`/clear` is not an option: through
 * the app-server it makes a *new* conversation and leaves the old one addressed, which is how untitled
 * empty desks once piled up.) The conversation runs in a folder of its own, <recall>/writer, with Letta's
 * project settings there turning reflection off: the writer's digests must never become the agent's
 * memory. The folder is the recall folder itself, so the model's read-only tools (Read, Grep — inside the
 * working directory they need no approval) reach the deck: the prompt quotes only the cards that overlap
 * the slices and names the folder for the rest. The worker skips its own conversations everywhere (`owns`).
 */
export const QUIET_MS = 10 * 60_000;
/** Less new text than this is not worth a model call; the cursor just moves on. */
export const MIN_NEW_CHARS = 300;
/**
 * One call per agent per tick, over the stretches of every quiet conversation that fit: the model reads them
 * together (the same fact twice is one card; a later correction is a revision), and the day's room is spent
 * by merit rather than by which conversation went quiet last. Slices are packed in score order until this
 * many characters; what does not fit waits, its cursor unmoved, for the next tick.
 */
export const SWEEP_BUDGET_CHARS = 48_000;
/** Slices per call at most: past this the model's attribution gets loose. */
export const MAX_SLICES = 8;
/** A replay slice — the tail of the conversation a failing card came from — is this long at most. */
export const REPLAY_CHARS = 4_000;
/** Existing cards quoted in the prompt: the ones whose wording overlaps the slices, this many at most; the rest the model can grep. */
export const MAX_QUOTED_CARDS = 80;
/** Open learning leads the pile holds at most; past this the writer is not asked for more until some are started or dismissed. */
export const MAX_OPEN_LEADS = 12;
/** A sweep may take a few tool calls (the model may grep the deck) on top of the answer. */
const ASK_TIMEOUT_MS = 240_000;

export type Ask = (agentId: string, prompt: string, model: string | null) => Promise<string>;

export interface WorkerDeps {
  store: RecallStore;
  /** Every open conversation of the person's agents, newest first (mod/index.ts listInbox). */
  listInbox: () => InboxRow[];
  ask: Ask;
  /** Transcript rows from a log line on; injectable for tests. */
  readSince?: (conversationId: string, agentId: string | null, fromLine: number) => { rows: LocalTranscriptMessage[]; lines: number };
  now?: () => number;
}

export interface TickReport {
  /** Conversations with new text. */
  looked: number;
  /** Model calls: one per agent that had slices to send. */
  asked: number;
  /** Conversations whose new stretch went into a call. */
  slices: number;
  written: number;
  revised: number;
  /** Learning leads proposed this tick (core/recall/model.ts Lead). */
  leads: number;
  note: string;
}

export class RecallWorker {
  private running: Promise<TickReport> | null = null;
  private readonly deps: WorkerDeps;
  constructor(deps: WorkerDeps) {
    this.deps = deps;
  }

  /** True for the worker's own hidden conversations (today's writers and the pre-2026-09-14 ones), which must never become desks or inbox cards. */
  owns(conversationId: string): boolean {
    const w = this.deps.store.worker();
    return Object.values(w.writers ?? {}).includes(conversationId) || Object.values(w.recallConversations ?? {}).includes(conversationId);
  }

  /** One pass; concurrent calls share the running one. */
  tick(): Promise<TickReport> {
    this.running ??= this.run().finally(() => (this.running = null));
    return this.running;
  }

  private async run(): Promise<TickReport> {
    const { store, listInbox } = this.deps;
    const now = this.deps.now?.() ?? Date.now();
    const readSince = this.deps.readSince ?? ((c, a, from) => readLocalTranscriptSince(c, a, from));
    const w = store.worker();
    const report: TickReport = { looked: 0, asked: 0, slices: 0, written: 0, revised: 0, leads: 0, note: "" };
    if (!w.enabled) return { ...report, note: "off" };
    const cursors = { ...w.cursors };
    const leadCursors = { ...(w.leadCursors ?? {}) };
    const cards = store.cards();
    const rejected = store.rejected();
    const openLeads = store.leads();
    const lessons = store.lessons();
    const dismissedLeads = store.dismissedLeads();
    // Cards the person keeps failing, not yet rewritten since they last failed.
    const failing = cards.filter((c) => keepsFailing(c.schedule) && (!c.schedule.lastReview || c.card.updatedAt < c.schedule.lastReview)).slice(0, 5);
    // The day's cards are written: the card cursor stays (tomorrow reads this stretch for cards); leads are
    // still looked for from their own cursor. With the lead pile full as well there is nothing to ask.
    const cappedAtStart = w.dailyCap - store.writtenToday(now) <= 0 && failing.length === 0;
    if (cappedAtStart && MAX_OPEN_LEADS - openLeads.length <= 0) {
      store.saveWorker({ lastRunAt: new Date(now).toISOString(), lastRunNote: "daily cap reached" });
      return { ...report, note: "daily cap reached" };
    }

    // 1. Every quiet conversation with enough new text, as a candidate slice, grouped by agent.
    const quiet = listInbox()
      .filter((r) => !this.owns(r.id) && r.lastMessageAt && now - new Date(r.lastMessageAt).getTime() >= QUIET_MS)
      .sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
    const byAgent = new Map<string, Candidate[]>();
    for (const conv of quiet) {
      const key = `${conv.agentId}/${conv.id}`;
      // Off the cap, the stretch starts at the card cursor even where leads already read part of it: the
      // model may name a lead twice, and the title dedupe below drops the repeat.
      const from = cappedAtStart ? Math.max(cursors[key] ?? 0, leadCursors[key] ?? 0) : (cursors[key] ?? 0);
      const { rows, lines } = readSince(conv.id, conv.agentId, from);
      if (lines <= from) continue; // nothing new
      report.looked += 1;
      const text = formatTranscript(rows, conv.agentName);
      if (text.length < MIN_NEW_CHARS) {
        // chatter: read, not worth asking about
        leadCursors[key] = lines;
        if (!cappedAtStart) cursors[key] = lines;
        continue;
      }
      const list = byAgent.get(conv.agentId) ?? [];
      list.push({ conv, key, lines, text, score: scoreStretch(rows) });
      byAgent.set(conv.agentId, list);
    }

    // 2. One call per agent: the best slices that fit the budget, replays for its failing cards, one prompt.
    let cappedAsks = 0;
    for (const [agentId, candidates] of byAgent) {
      const agentName = candidates[0].conv.agentName;
      const room = Math.max(0, w.dailyCap - store.writtenToday(now)); // shrinks as earlier agents' cards are written
      const leadRoom = MAX_OPEN_LEADS - openLeads.length;
      const capped = room === 0 && failing.length === 0;
      if (capped && leadRoom <= 0) {
        report.note = "daily cap reached";
        break;
      }
      const packed = packSlices(candidates);
      const slices: Slice[] = packed.map((c, i) => ({ id: `s${i + 1}`, title: c.conv.title, mode: "new", text: c.text }));
      let total = slices.reduce((n, s) => n + Math.min(s.text.length, MAX_TRANSCRIPT_CHARS), 0);
      const sent = new Set(packed.map((c) => c.conv.id));
      for (const f of failing) {
        const src = f.card.source;
        const convId = src.conversationId;
        if (!convId || src.agentId !== agentId || sent.has(convId) || total + REPLAY_CHARS > SWEEP_BUDGET_CHARS) continue;
        const text = formatTranscript(readSince(convId, src.agentId, 0).rows, agentName).slice(-REPLAY_CHARS);
        if (text.length < MIN_NEW_CHARS) continue;
        slices.push({ id: `s${slices.length + 1}`, title: src.title, mode: "replay", forCard: f.card.id, text });
        sent.add(convId);
        total += text.length;
      }
      const quoted = overlappingCards(cards.map((c) => ({ id: c.card.id, front: c.card.front, back: c.card.back, tags: c.card.tags })), slices.map((s) => s.text));
      const prompt = buildPrompt({
        agentName,
        slices,
        existing: quoted,
        deck: { path: store.dir, total: cards.length },
        rejected: rejected.slice(0, 40).map((r) => ({ front: r.card.front, back: r.card.back, reps: r.reps })),
        room,
        failing: failing.map((c) => ({ id: c.card.id, front: c.card.front, back: c.card.back })),
        leads: { open: openLeads.map((l) => l.title), started: lessons.map((l) => l.lead.title), dismissed: dismissedLeads.map((d) => d.lead.title), room: leadRoom },
      });
      report.asked += 1;
      if (capped) cappedAsks += 1;
      let reply: string;
      try {
        reply = await this.deps.ask(agentId, prompt, w.model);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log("recall:ask-failed", { agent: agentId, slices: packed.map((c) => c.conv.id), message });
        report.note = `could not ask the model: ${message}`;
        continue; // the cursors stay; next tick retries
      }
      report.slices += packed.length;
      const byId = new Map(cards.map((c) => [c.card.id, c]));
      const ext = parseExtraction(reply, new Set(byId.keys()), { maxLeads: LEADS_PER_CONVERSATION * packed.length });
      const at = new Date(now).toISOString();
      // Where an answer came from: the slice it names, else the first new one. A replay yields no new cards or leads.
      const bySlice = new Map(slices.map((s, i) => [s.id, i < packed.length ? packed[i] : null]));
      const origin = (label: string | undefined): Candidate | null => (label && bySlice.has(label) ? bySlice.get(label)! : packed[0]);
      const sourceOf = (c: Candidate) => ({ agentId: c.conv.agentId, agentName: c.conv.agentName, conversationId: c.conv.id, title: c.conv.title, at: c.conv.lastMessageAt });
      const fronts = [...cards.map((c) => c.card.front), ...rejected.map((r) => r.card.front)];
      let written = 0;
      for (const cand of ext.cards) {
        if (written >= room) break;
        const from = origin(cand.slice);
        if (!from) continue;
        if (fronts.some((f) => similarFront(f, cand.front))) continue;
        const card: Card = { id: newCardId(now), front: cand.front, back: cand.back, tags: cand.tags, source: sourceOf(from), createdAt: at, updatedAt: at, updatedBy: "recall", previous: [] };
        store.add(card);
        fronts.push(card.front);
        written += 1;
      }
      for (const rev of ext.revisions) {
        const cur = byId.get(rev.id);
        if (!cur) continue;
        if ((rev.front ?? cur.card.front) === cur.card.front && (rev.back ?? cur.card.back) === cur.card.back) continue;
        store.edit(rev.id, { front: rev.front, back: rev.back }, "recall", now);
        report.revised += 1;
      }
      if (written) store.noteWritten(written, now);
      report.written += written;
      // Learning leads: a title near one already open, started or dismissed is the same lead again.
      const leadTitles = [...openLeads.map((l) => l.title), ...lessons.map((l) => l.lead.title), ...dismissedLeads.map((d) => d.lead.title)];
      let leadsLeft = leadRoom;
      for (const cand of ext.leads) {
        if (leadsLeft <= 0) break;
        const from = origin(cand.slice);
        if (!from) continue;
        if (leadTitles.some((t) => similarFront(t, cand.title))) continue;
        const lead: Lead = { id: newCardId(now), title: cand.title, why: cand.why, depth: cand.depth, source: sourceOf(from), createdAt: at };
        store.addLead(lead);
        openLeads.push(lead);
        leadTitles.push(lead.title);
        leadsLeft -= 1;
        report.leads += 1;
      }
      for (const c of packed) {
        leadCursors[c.key] = c.lines;
        if (!capped) cursors[c.key] = c.lines;
      }
      log("recall:sweep", { agent: agentId, slices: packed.map((c) => c.conv.id), replays: slices.length - packed.length, quoted: quoted.length, written, revised: ext.revisions.length, leads: ext.leads.length, capped });
    }
    const leadsNote = report.leads ? ` · ${report.leads} lead${report.leads === 1 ? "" : "s"}` : "";
    const capNote = cappedAsks ? " · cards at the day's cap" : "";
    const asksNote = report.asked > 1 ? ` in ${report.asked} asks` : "";
    const note = report.note || (report.asked ? `${report.written} new · ${report.revised} revised${leadsNote} from ${report.slices} conversation${report.slices === 1 ? "" : "s"}${asksNote}${capNote}` : report.looked ? "nothing worth a card" : "nothing new");
    store.saveWorker({ cursors, leadCursors, lastRunAt: new Date(now).toISOString(), lastRunNote: note });
    return { ...report, note };
  }
}

/** A quiet conversation's new stretch, waiting to be packed into its agent's call. */
interface Candidate {
  conv: InboxRow;
  key: string;
  lines: number;
  text: string;
  score: number;
}

/**
 * How much a stretch deserves the room: its length with diminishing returns, the person's share of the words
 * (a stretch they wrote half of beats one the agent monologued), and their questions (each up to six adds
 * fifteen percent). Plain code, no model: Letta's reflection catalogue prunes the same way before its picker.
 */
export function scoreStretch(rows: LocalTranscriptMessage[]): number {
  const said = rows.filter((r) => r.role === "user" || r.role === "assistant");
  const total = said.reduce((n, r) => n + r.text.length, 0);
  if (total === 0) return 0;
  const yours = said.filter((r) => r.role === "user");
  const share = yours.reduce((n, r) => n + r.text.length, 0) / total;
  const questions = yours.reduce((n, r) => n + (r.text.match(/\?/g)?.length ?? 0), 0);
  return Math.sqrt(total) * (0.5 + share) * (1 + Math.min(questions, 6) * 0.15);
}

/** The best candidates that fit: score order, each cut to MAX_TRANSCRIPT_CHARS, until the budget or MAX_SLICES; always at least one. */
export function packSlices<T extends { text: string; score: number }>(candidates: T[], budget = SWEEP_BUDGET_CHARS, max = MAX_SLICES): T[] {
  const picked: T[] = [];
  let total = 0;
  for (const c of [...candidates].sort((a, b) => b.score - a.score)) {
    if (picked.length >= max) break;
    const size = Math.min(c.text.length, MAX_TRANSCRIPT_CHARS);
    if (picked.length && total + size > budget) continue; // a smaller one further down may still fit
    picked.push(c);
    total += size;
  }
  return picked;
}

/**
 * The cards worth quoting to the model: those whose front, back or tags share a word of five letters or more
 * with the slices (tags of three or more), most shared words first, MAX_QUOTED_CARDS at most. The rest are on
 * disk for the model to grep — the prompt tells it where — so the quoted list stops growing with the deck.
 */
export function overlappingCards<T extends { front: string; back: string; tags: string[] }>(cards: T[], texts: string[], cap = MAX_QUOTED_CARDS): T[] {
  const words = new Set(texts.join(" ").toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []);
  const scored = cards
    .map((c) => {
      const own = new Set([...(`${c.front} ${c.back}`.toLowerCase().match(/[a-z][a-z0-9_-]{4,}/g) ?? []), ...c.tags.map((t) => t.toLowerCase()).filter((t) => t.length >= 3)]);
      let hits = 0;
      for (const w of own) if (words.has(w)) hits += 1;
      return { c, hits };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  return scored.slice(0, cap).map((x) => x.c);
}

/** "you: …" / "<agent>: …" lines; tool markers and harness notices are left out. */
export function formatTranscript(rows: LocalTranscriptMessage[], agentName: string | null): string {
  const who = agentName ?? "agent";
  return rows
    .filter((r) => r.role === "user" || r.role === "assistant")
    .map((r) => `${r.role === "user" ? "you" : who}: ${r.text.trim()}`)
    .join("\n");
}

/** Letta reads a folder's own settings from here (settings.local.json under .letta): the writer's turn reflection off. */
export const WRITER_SETTINGS: Readonly<Record<string, unknown>> = { reflectionTrigger: "off" };

/**
 * The writer's working folder (the recall folder), given Letta's project settings, which keep the
 * dreaming pass (reflection) off every conversation that runs there. Letta resolves reflection settings
 * per conversation working directory — global, then the folder's, then the agent's — and the folder's
 * `reflectionTrigger` wins over a global step-count or compaction-event trigger. The file is ours: a
 * missing or different trigger is put back; other keys someone added stay.
 */
export function ensureWriterDir(dir: string): string {
  const settingsDir = join(dir, ".letta");
  mkdirSync(settingsDir, { recursive: true });
  const file = join(settingsDir, "settings.local.json");
  let current: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
    } catch {
      // unreadable: rewritten below
    }
  }
  const wanted = { ...current, ...WRITER_SETTINGS };
  if (JSON.stringify(wanted) !== JSON.stringify(current) || !existsSync(file)) writeFileSync(file, JSON.stringify(wanted, null, 2) + "\n");
  return dir;
}

/**
 * Ask an agent through the harness's app-server, in its long-running hidden "recall" conversation: create it
 * once in the writer's folder (and hide it), set the model when one is configured, send the prompt, collect
 * the reply, then compact the conversation so the next ask starts from a summary.
 */
export function askViaAppServer(opts: { url: () => string | null; store: RecallStore; writerDir?: string }): Ask {
  return async (agentId, prompt, model) => {
    const url = opts.url();
    if (!url) throw new Error("no app-server");
    const sock = new AppServerSocket(url, wsTransport);
    await sock.connect();
    try {
      const rt = await writerConversation(sock, opts.store, agentId, opts.writerDir ?? opts.store.dir);
      if (model) await sock.updateModel(rt, model).catch((e) => log("recall:model", { model, message: String(e) }));
      const live = emptyLive();
      const done = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("the model did not answer in time")), ASK_TIMEOUT_MS);
        const off = sock.on((ev: ServerEvent) => {
          if (ev.runtime && ev.runtime.conversation_id !== rt.conversation_id) return;
          applyEvent(live, ev);
          const status = (ev.loop_status as { status?: string } | undefined)?.status;
          const finished = ev.type === "turn_finished" || (ev.type === "update_loop_status" && status === "WAITING_ON_INPUT" && live.turns > 0);
          if (!finished) return;
          clearTimeout(timer);
          off();
          // The full reply: the settled tail row (lastAssistantText is a digest, cut to its last few hundred characters).
          const text = [...live.tail].reverse().find((r) => r.role === "assistant")?.text ?? live.streamingText;
          if (live.error) reject(new Error(live.error));
          else resolve(text);
        });
      });
      if (!(await sock.sendUserMessage(rt, prompt))) throw new Error("the harness did not accept the prompt");
      const reply = await done;
      // The ask is answered; fold it into the summary so the conversation stays a few hundred words long. A
      // compaction that fails only means the next ask carries this one too — it is tried again then.
      const compacted = await sock.executeCommand(rt, "compact", "all").catch((e: unknown) => ({ success: false, output: e instanceof Error ? e.message : String(e) }));
      if (!compacted.success) log("recall:compact-failed", { conversation: rt.conversation_id, message: compacted.output });
      return reply;
    } finally {
      sock.close();
    }
  };
}

/**
 * Start a lesson from a lead: a new conversation `[Learn] · <title>` for the lead's agent in the home
 * directory, the brief sent as the person's first message, the lead recorded as a lesson. The socket
 * waits for the harness's first word back (or two seconds) so the turn is under way before it closes.
 */
export type StartLesson = (leadId: string) => Promise<{ agentId: string; conversationId: string }>;
/**
 * The first thing on a lesson's desk: an info card with the lead, so the desk is furnished before the agent says a
 * word. The agent's outline joins it once the brief lands (the app sends the brief over its own live socket, the way
 * the board's dispatch does — a message fired from a socket that closes right after never reaches the agent).
 */
export function lessonCard(lead: Lead): { type: "info-card"; title: string; data: { lines: string[] } } {
  const who = lead.source.agentName ?? "the agent";
  const where = lead.source.title ? `it came up in "${lead.source.title}" with ${who}` : `it came up in a conversation with ${who}`;
  return {
    type: "info-card",
    title: lead.title,
    data: { lines: [lead.depth === "primer" ? "a primer — one sitting" : "a course — a few sittings", where, lead.why, `${who} lays the lesson out here; the chat opens with the brief`] },
  };
}

/** opts.expect: told just before the lesson card is written, so the desk's widget log reads it as loki's (mod/widget-log.ts). */
export function startLessonViaAppServer(opts: { url: () => string | null; store: RecallStore; widgetsDir?: string; expect?: (widgetId: string, change: WidgetChange) => void }): StartLesson {
  return async (leadId) => {
    const lead = opts.store.lead(leadId);
    if (!lead) throw new Error("no such lead");
    if (!lead.source.agentId) throw new Error("the lead names no agent");
    const url = opts.url();
    if (!url) throw new Error("no app-server");
    const sock = new AppServerSocket(url, wsTransport);
    await sock.connect();
    try {
      const rt = await sock.createConversation(lead.source.agentId, homedir(), learnTitle(lead.title));
      const scope = scopeFor(rt.conversation_id, rt.agent_id);
      const dir = join(opts.widgetsDir ?? paths.widgets, scope);
      try {
        mkdirSync(dir, { recursive: true });
        opts.expect?.(`${scope}/lesson`, existsSync(join(dir, "lesson.json")) ? "changed" : "added");
        writeFileSync(join(dir, "lesson.json"), JSON.stringify(lessonCard(lead), null, 2) + "\n");
      } catch (err) {
        log("recall:lesson-card-failed", { message: err instanceof Error ? err.message : String(err) }); // the desk starts bare; the lesson still starts
      }
      const lesson = opts.store.startLesson(leadId, { agentId: rt.agent_id, conversationId: rt.conversation_id });
      log("recall:lesson-started", { lead: leadId, conversation: rt.conversation_id });
      return { agentId: lesson?.agentId ?? rt.agent_id, conversationId: lesson?.conversationId ?? rt.conversation_id };
    } finally {
      sock.close();
    }
  };
}

/**
 * The agent's writer conversation: one for the life of the agent, created in the writer's folder and hidden
 * on first use, remembered in worker.json `writers`. The pre-2026-09-14 `recallConversations` entry, made in
 * the home folder and cleared before each ask, is not reused: its folder has no settings of its own.
 */
async function writerConversation(sock: AppServerSocket, store: RecallStore, agentId: string, writerDir: string): Promise<Runtime> {
  const known = store.worker().writers?.[agentId];
  if (known) {
    const rt = { agent_id: agentId, conversation_id: known };
    try {
      await sock.runtimeStart(rt);
      return rt;
    } catch {
      // gone (deleted, or a different backend): make another
    }
  }
  const rt = await sock.createConversation(agentId, ensureWriterDir(writerDir), "recall");
  await sock.updateConversation(rt.conversation_id, { hidden: true }).catch((e) => log("recall:hide-failed", { message: String(e) }));
  store.saveWorker({ writers: { ...(store.worker().writers ?? {}), [agentId]: rt.conversation_id } });
  log("recall:writer-created", { agent: agentId, conversation: rt.conversation_id, cwd: writerDir });
  return rt;
}

/** A `ws` socket as the core's Transport, with the harness's bearer header. */
function wsTransport(url: string): Transport {
  let ws: WebSocket | null = null;
  return {
    open(h) {
      ws = new WebSocket(url, { headers: appServerHeaders() });
      ws.on("open", h.onOpen);
      ws.on("message", (d) => h.onMessage(String(d)));
      ws.on("close", h.onClose);
      ws.on("error", (e) => h.onError(e instanceof Error ? e : new Error(String(e))));
    },
    send(raw) {
      ws?.send(raw);
    },
    close() {
      ws?.close();
    },
  };
}
