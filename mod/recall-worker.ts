import { homedir } from "node:os";
import { WebSocket } from "ws";
import { AppServerSocket, type Runtime, type ServerEvent } from "../core/attention/protocol.ts";
import type { Transport } from "../core/attention/transport.ts";
import { applyEvent, emptyLive } from "../core/attention/model.ts";
import { buildPrompt, lessonBrief, parseExtraction, similarFront } from "../core/recall/extract.ts";
import { keepsFailing } from "../core/recall/fsrs.ts";
import { learnTitle, type Card, type Lead } from "../core/recall/model.ts";
import { appServerHeaders } from "./app-server.ts";
import { readLocalTranscriptSince, type InboxRow, type LocalTranscriptMessage } from "./desks.ts";
import { log } from "./log.ts";
import { RecallStore, newCardId } from "./recall.ts";

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
 * The model is asked through the harness, in a hidden conversation per agent named "recall" that is
 * cleared before each question, so the agent's own memory informs the cards while no transcript the
 * person reads is touched. The worker skips its own conversations everywhere (`owns`).
 */
export const QUIET_MS = 10 * 60_000;
/** Less new text than this is not worth a model call; the cursor just moves on. */
export const MIN_NEW_CHARS = 300;
/** Conversations per tick, most recently active first, so a busy day is spread over several ticks. */
export const PER_TICK = 3;
/** Open learning leads the pile holds at most; past this the writer is not asked for more until some are started or dismissed. */
export const MAX_OPEN_LEADS = 12;
const ASK_TIMEOUT_MS = 180_000;

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
  looked: number;
  asked: number;
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

  /** True for the worker's own hidden conversations, which must never become desks or inbox cards. */
  owns(conversationId: string): boolean {
    return Object.values(this.deps.store.worker().recallConversations ?? {}).includes(conversationId);
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
    const report: TickReport = { looked: 0, asked: 0, written: 0, revised: 0, leads: 0, note: "" };
    if (!w.enabled) return { ...report, note: "off" };
    const cursors = { ...w.cursors };
    const leadCursors = { ...(w.leadCursors ?? {}) };
    let cappedAsks = 0;
    const quiet = listInbox()
      .filter((r) => !this.owns(r.id) && r.lastMessageAt && now - new Date(r.lastMessageAt).getTime() >= QUIET_MS)
      .sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
    let asked = 0;
    for (const conv of quiet) {
      if (asked >= PER_TICK) break;
      const key = `${conv.agentId}/${conv.id}`;
      const cards = store.cards();
      const rejected = store.rejected();
      const openLeads = store.leads();
      const lessons = store.lessons();
      const dismissedLeads = store.dismissedLeads();
      const room = Math.max(0, w.dailyCap - store.writtenToday(now)); // writtenToday already counts this run's earlier conversations
      // Cards the person keeps failing, not yet rewritten since they last failed.
      const failing = cards.filter((c) => keepsFailing(c.schedule) && (!c.schedule.lastReview || c.card.updatedAt < c.schedule.lastReview)).slice(0, 5);
      const leadRoom = MAX_OPEN_LEADS - openLeads.length;
      // The day's cards are written: the card cursor stays (tomorrow reads this stretch for cards); leads are
      // still looked for from their own cursor. With the lead pile full as well there is nothing to ask.
      const capped = room === 0 && failing.length === 0;
      if (capped && leadRoom <= 0) {
        report.note = "daily cap reached";
        break;
      }
      // Off the cap, the stretch starts at the card cursor even where leads already read part of it: the
      // model may name a lead twice, and the title dedupe below drops the repeat.
      const from = capped ? Math.max(cursors[key] ?? 0, leadCursors[key] ?? 0) : (cursors[key] ?? 0);
      const { rows, lines } = readSince(conv.id, conv.agentId, from);
      if (lines <= from) continue; // nothing new
      report.looked += 1;
      const transcript = formatTranscript(rows, conv.agentName);
      if (transcript.length < MIN_NEW_CHARS) {
        // chatter: read, not worth asking about
        leadCursors[key] = lines;
        if (!capped) cursors[key] = lines;
        continue;
      }
      const prompt = buildPrompt({
        agentName: conv.agentName,
        title: conv.title,
        transcript,
        existing: cards.map((c) => ({ id: c.card.id, front: c.card.front, back: c.card.back })),
        rejected: rejected.slice(0, 40).map((r) => ({ front: r.card.front, back: r.card.back, reps: r.reps })),
        room,
        failing: failing.map((c) => ({ id: c.card.id, front: c.card.front, back: c.card.back })),
        leads: { open: openLeads.map((l) => l.title), started: lessons.map((l) => l.lead.title), dismissed: dismissedLeads.map((d) => d.lead.title), room: leadRoom },
      });
      asked += 1;
      report.asked += 1;
      if (capped) cappedAsks += 1;
      let reply: string;
      try {
        reply = await this.deps.ask(conv.agentId, prompt, w.model);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log("recall:ask-failed", { conversation: conv.id, message });
        report.note = `could not ask the model: ${message}`;
        continue; // the cursor stays; next tick retries
      }
      const known = new Set(cards.map((c) => c.card.id));
      const ext = parseExtraction(reply, known);
      const at = new Date(now).toISOString();
      const fronts = [...cards.map((c) => c.card.front), ...rejected.map((r) => r.card.front)];
      let written = 0;
      for (const cand of ext.cards) {
        if (written >= room) break;
        if (fronts.some((f) => similarFront(f, cand.front))) continue;
        const card: Card = {
          id: newCardId(now),
          front: cand.front,
          back: cand.back,
          tags: cand.tags,
          source: { agentId: conv.agentId, agentName: conv.agentName, conversationId: conv.id, title: conv.title, at: conv.lastMessageAt },
          createdAt: at,
          updatedAt: at,
          updatedBy: "recall",
          previous: [],
        };
        store.add(card);
        fronts.push(card.front);
        written += 1;
      }
      for (const rev of ext.revisions) {
        const cur = cards.find((c) => c.card.id === rev.id);
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
        if (leadTitles.some((t) => similarFront(t, cand.title))) continue;
        const lead: Lead = { id: newCardId(now), title: cand.title, why: cand.why, depth: cand.depth, source: { agentId: conv.agentId, agentName: conv.agentName, conversationId: conv.id, title: conv.title, at: conv.lastMessageAt }, createdAt: at };
        store.addLead(lead);
        openLeads.push(lead);
        leadTitles.push(lead.title);
        leadsLeft -= 1;
        report.leads += 1;
      }
      leadCursors[key] = lines;
      if (!capped) cursors[key] = lines;
      log("recall:conversation", { conversation: conv.id, written, revised: ext.revisions.length, leads: ext.leads.length, capped });
    }
    const leadsNote = report.leads ? ` · ${report.leads} lead${report.leads === 1 ? "" : "s"}` : "";
    const capNote = cappedAsks ? " · cards at the day's cap" : "";
    const note = report.note || (report.asked ? `${report.written} new · ${report.revised} revised${leadsNote} from ${report.asked} conversation${report.asked === 1 ? "" : "s"}${capNote}` : report.looked ? "nothing worth a card" : "nothing new");
    store.saveWorker({ cursors, leadCursors, lastRunAt: new Date(now).toISOString(), lastRunNote: note });
    return { ...report, note };
  }
}

/** "you: …" / "<agent>: …" lines; tool markers and harness notices are left out. */
export function formatTranscript(rows: LocalTranscriptMessage[], agentName: string | null): string {
  const who = agentName ?? "agent";
  return rows
    .filter((r) => r.role === "user" || r.role === "assistant")
    .map((r) => `${r.role === "user" ? "you" : who}: ${r.text.trim()}`)
    .join("\n");
}

/**
 * Ask an agent through the harness's app-server, in its hidden "recall" conversation: create it once
 * (and hide it), clear it, set the model when one is configured, send the prompt, collect the reply.
 */
export function askViaAppServer(opts: { url: () => string | null; store: RecallStore }): Ask {
  return async (agentId, prompt, model) => {
    const url = opts.url();
    if (!url) throw new Error("no app-server");
    const sock = new AppServerSocket(url, wsTransport);
    await sock.connect();
    try {
      const rt = await recallConversation(sock, opts.store, agentId);
      await sock.executeCommand(rt, "clear").catch(() => undefined); // a fresh context each time; the agent's memory still applies
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
      return await done;
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
export function startLessonViaAppServer(opts: { url: () => string | null; store: RecallStore }): StartLesson {
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
      const started = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000);
        const off = sock.on((ev: ServerEvent) => {
          if (ev.runtime && ev.runtime.conversation_id !== rt.conversation_id) return;
          clearTimeout(timer);
          off();
          resolve();
        });
      });
      if (!(await sock.sendUserMessage(rt, lessonBrief(lead)))) throw new Error("the harness did not accept the brief");
      await started;
      const lesson = opts.store.startLesson(leadId, { agentId: rt.agent_id, conversationId: rt.conversation_id });
      log("recall:lesson-started", { lead: leadId, conversation: rt.conversation_id });
      return { agentId: lesson?.agentId ?? rt.agent_id, conversationId: lesson?.conversationId ?? rt.conversation_id };
    } finally {
      sock.close();
    }
  };
}

/** The agent's hidden recall conversation, created and hidden on first use and remembered in worker.json. */
async function recallConversation(sock: AppServerSocket, store: RecallStore, agentId: string): Promise<Runtime> {
  const known = store.worker().recallConversations?.[agentId];
  if (known) {
    const rt = { agent_id: agentId, conversation_id: known };
    try {
      await sock.runtimeStart(rt);
      return rt;
    } catch {
      // gone (deleted, or a different backend): make another
    }
  }
  const rt = await sock.createConversation(agentId, homedir(), "recall");
  await sock.updateConversation(rt.conversation_id, { hidden: true }).catch((e) => log("recall:hide-failed", { message: String(e) }));
  store.saveWorker({ recallConversations: { ...(store.worker().recallConversations ?? {}), [agentId]: rt.conversation_id } });
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
