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
export interface Extraction {
  cards: Candidate[];
  revisions: Revision[];
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
}

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
  lines.push(
    ``,
    `Transcript (new since the last time you read it):`,
    `<transcript>`,
    transcript,
    `</transcript>`,
    ``,
    `Answer with JSON only, no prose, in this shape:`,
    `{"cards":[{"front":"…","back":"…","tags":["…"]}],"revisions":[{"id":"…","front":"…","back":"…","reason":"…"}]}`,
    `Tags are one or two lowercase words naming the topic. Omit "front" or "back" in a revision to keep it as is. Empty arrays when there is nothing to do.`,
  );
  return lines.join("\n");
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 240);

/** The model's reply, forgiving of fences and prose around the JSON. Malformed → nothing. */
export function parseExtraction(text: string, knownIds: Set<string>): Extraction {
  const json = extractJson(text);
  if (!json) return { cards: [], revisions: [] };
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return { cards: [], revisions: [] };
  }
  if (!v || typeof v !== "object") return { cards: [], revisions: [] };
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
  return { cards, revisions };
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
