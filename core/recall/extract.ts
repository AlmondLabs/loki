/**
 * The worker's conversation with the model, as pure text in and text out: the prompt that asks for
 * cards from a stretch of transcript, and the parser for what comes back. What makes a good card
 * lives here as words — one fact, a question that stands alone, an answer that fits on a line — and
 * the rejected pile is quoted back so a deleted card never returns reworded.
 */
export interface Candidate {
  front: string;
  back: string;
  tags: string[];
}
export interface Revision {
  id: string;
  front?: string;
  back?: string;
  /** One line on what changed and why (shown next to "updated"). */
  reason: string;
}
export interface LeadCandidate {
  title: string;
  why: string;
  depth: "primer" | "course";
}
export interface Extraction {
  cards: Candidate[];
  revisions: Revision[];
  leads: LeadCandidate[];
}

export interface PromptInput {
  /** Who was talking, and about what, for the model's orientation. */
  agentName: string | null;
  title: string | null;
  /** The new part of the transcript, "you: …" / "<agent>: …" lines, tool calls dropped. */
  transcript: string;
  /** Existing cards (front + id) so nothing is written twice and revisions can name their target. */
  existing: Array<{ id: string; front: string; back: string }>;
  /** Recently deleted cards: the strongest signal of what is not wanted. */
  rejected: Array<{ front: string; back: string; reps: number }>;
  /** How many new cards may still be written today. */
  room: number;
  /** Cards the person keeps failing; the model should rewrite or split them. */
  failing: Array<{ id: string; front: string; back: string }>;
  /** Learning leads already proposed, started, or dismissed: none of these may be proposed again. */
  leads?: { open: string[]; started: string[]; dismissed: string[]; room: number };
}

/** Leads per conversation per call; more than this is a list, not a judgement. */
export const LEADS_PER_CONVERSATION = 2;

export const MAX_TRANSCRIPT_CHARS = 24_000;

export function buildPrompt(input: PromptInput): string {
  const who = input.agentName ?? "the agent";
  const transcript = input.transcript.length > MAX_TRANSCRIPT_CHARS ? input.transcript.slice(-MAX_TRANSCRIPT_CHARS) : input.transcript;
  const lines: string[] = [];
  lines.push(
    `You keep a set of spaced-repetition cards for one person, drawn from their conversations with an AI agent. They never asked for these cards; they only ever see them in a review deck, and delete the ones they do not want. Your job is to write only what they will be glad to be asked about later.`,
    ``,
    `What makes a card worth writing:`,
    `- one fact, concept, command, or decision the person learned or worked out — not chatter, not the agent's plan, not what the person already knew`,
    `- the front is a question that stands alone without the conversation; the back is the answer in one or two lines`,
    `- prefer what the person asked about, was surprised by, or got wrong; skip project trivia they will not need in a month`,
    `- never write a card that is close to a rejected one, or that an existing card already covers`,
    `- fewer is better: zero is a fine answer`,
    ``,
    `Conversation: "${input.title ?? "untitled"}" between the person ("you") and ${who}.`,
    `You may write at most ${input.room} new card${input.room === 1 ? "" : "s"}.`,
  );
  if (input.rejected.length) {
    lines.push(``, `Cards the person deleted (do not write these or anything like them; a high review count means it was badly written, a zero means it was unwanted):`);
    for (const r of input.rejected.slice(0, 40)) lines.push(`- [${r.reps} reviews] Q: ${oneLine(r.front)} — A: ${oneLine(r.back)}`);
  }
  if (input.existing.length) {
    lines.push(``, `Existing cards (do not duplicate; you may revise one when the conversation corrects or sharpens it):`);
    for (const c of input.existing.slice(0, 200)) lines.push(`- ${c.id}: Q: ${oneLine(c.front)} — A: ${oneLine(c.back)}`);
  }
  if (input.failing.length) {
    lines.push(``, `Cards the person keeps failing — rewrite the wording, or replace one with two smaller cards (a revision plus a new card):`);
    for (const c of input.failing) lines.push(`- ${c.id}: Q: ${oneLine(c.front)} — A: ${oneLine(c.back)}`);
  }
  const leads = input.leads;
  const leadRoom = leads ? Math.min(LEADS_PER_CONVERSATION, Math.max(0, leads.room)) : 0;
  if (leads && leadRoom > 0) {
    lines.push(
      ``,
      `Separately from the cards: name up to ${leadRoom} thing${leadRoom === 1 ? "" : "s"} from this stretch the person could learn properly — a concept they met but did not have to understand. The signals: they asked what something is, the agent explained at length, an acronym went by unquestioned, they took the agent's word for it. A lead is worth naming only if understanding it would change how they work or decide; project trivia and things they plainly already know are not leads. Zero is a fine answer.`,
      `For each lead: "title" in a few words (a concept, not a question), "why" quoting the moment in one line, and "depth": "primer" if one sitting would do, "course" if it takes several.`,
    );
    const named = [...leads.open, ...leads.started];
    if (named.length) lines.push(`Leads already proposed or under way (do not name these or anything close):`, ...named.slice(0, 60).map((t) => `- ${oneLine(t)}`));
    if (leads.dismissed.length) lines.push(`Leads the person dismissed (never again, nor anything like them):`, ...leads.dismissed.slice(0, 60).map((t) => `- ${oneLine(t)}`));
  }
  lines.push(
    ``,
    `Transcript (new since the last time you read it):`,
    `<transcript>`,
    transcript,
    `</transcript>`,
    ``,
    `Answer with JSON only, no prose, in this shape:`,
    leads && leadRoom > 0
      ? `{"cards":[{"front":"…","back":"…","tags":["…"]}],"revisions":[{"id":"…","front":"…","back":"…","reason":"…"}],"leads":[{"title":"…","why":"…","depth":"primer"}]}`
      : `{"cards":[{"front":"…","back":"…","tags":["…"]}],"revisions":[{"id":"…","front":"…","back":"…","reason":"…"}]}`,
    `Tags are one or two lowercase words naming the topic. Omit "front" or "back" in a revision to keep it as is. Empty arrays when there is nothing to do.`,
  );
  return lines.join("\n");
}

/**
 * The first message of a lesson, sent on the person's behalf when they start a lead: what to teach, where
 * it came up, and how — the desk first, questions before answers, one idea at a time, a cold quiz to close.
 */
export function lessonBrief(lead: { title: string; why: string; depth: "primer" | "course"; source: { title: string | null } }): string {
  const sittings = lead.depth === "primer" ? "one sitting" : "three to five sittings";
  const where = lead.source.title ? `It came up in "${lead.source.title}"` : "It came up in one of our conversations";
  return [
    `This is a lesson, not a task. I want to understand: ${lead.title}.`,
    `${where}: ${lead.why}`,
    ``,
    `Teach it the way a good tutor would. Before you say anything, furnish this desk: an outline of the lesson as a list card I can tick, sized for ${sittings}, and an info card saying where this came from. Then start by asking me what I already think it is, and build from my answer. One idea at a time, a question at the end of each step, no lecture. Tick the outline as we go. When it is all ticked, quiz me cold with two or three questions and tell me plainly whether I have it.`,
  ].join("\n");
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 240);

/** The model's reply, forgiving of fences and prose around the JSON. Malformed → nothing. */
export function parseExtraction(text: string, knownIds: Set<string>): Extraction {
  const none: Extraction = { cards: [], revisions: [], leads: [] };
  const json = extractJson(text);
  if (!json) return none;
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return none;
  }
  if (!v || typeof v !== "object") return none;
  const o = v as Record<string, unknown>;
  const cards: Candidate[] = [];
  for (const c of Array.isArray(o.cards) ? o.cards : []) {
    if (!c || typeof c !== "object") continue;
    const r = c as Record<string, unknown>;
    const front = str(r.front);
    const back = str(r.back);
    if (!front || !back) continue;
    const tags = Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase().trim()).filter(Boolean).slice(0, 3) : [];
    cards.push({ front, back, tags });
  }
  const revisions: Revision[] = [];
  for (const c of Array.isArray(o.revisions) ? o.revisions : []) {
    if (!c || typeof c !== "object") continue;
    const r = c as Record<string, unknown>;
    const id = str(r.id);
    if (!id || !knownIds.has(id)) continue;
    const front = str(r.front) || undefined;
    const back = str(r.back) || undefined;
    if (!front && !back) continue;
    revisions.push({ id, front, back, reason: str(r.reason) || "revised" });
  }
  const leads: LeadCandidate[] = [];
  for (const c of Array.isArray(o.leads) ? o.leads : []) {
    if (!c || typeof c !== "object") continue;
    const r = c as Record<string, unknown>;
    const title = str(r.title).replace(/[.?!]+$/, "").slice(0, 80);
    const why = str(r.why).slice(0, 300);
    if (!title || !why) continue;
    leads.push({ title, why, depth: r.depth === "course" ? "course" : "primer" });
    if (leads.length >= LEADS_PER_CONVERSATION) break;
  }
  return { cards, revisions, leads };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start >= 0 && end > start ? body.slice(start, end + 1) : null;
}

/**
 * Near-duplicate check for a candidate against cards and rejections: the same front once question words
 * and punctuation are dropped, or one front contained in the other and making up most of it.
 */
export function similarFront(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  return short.length >= 12 && long.includes(short) && short.length / long.length >= 0.6;
}
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\b(what|which|who|how|why|when|where|is|are|the|a|an|of|to|in|does|do|did)\b/g, " ").replace(/\s+/g, " ").trim();
}
