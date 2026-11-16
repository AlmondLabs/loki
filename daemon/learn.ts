import { LEADS_PER_CONVERSATION, buildPrompt, parseExtraction, similarFront, type Slice } from "../core/recall/extract.ts";
import { keepsFailing } from "../core/recall/fsrs.ts";
import { writerChatId, type Card, type Lead } from "../core/recall/model.ts";
import { formatTranscript, overlappingCards, MAX_OPEN_LEADS, REPLAY_CHARS } from "../mod/recall-worker.ts";
import { isoDay, newCardId, type RecallStore } from "../mod/recall.ts";
import type { ChatProjection } from "./chats.ts";
import type { PassJob } from "./passes.ts";
import { MIN_NEW_CHARS } from "./passes.ts";
import type { PassState } from "./passes-state.ts";

const FAILING_PER_RUN = 5;

export const INSTRUCTIONS = `You are writing study cards for the person you work with, from a stretch of one of your conversations with them. Answer with the JSON the request asks for and nothing else; you have no tools here.`;

interface Deps {
  store: RecallStore;
  state: PassState;
  chats: ChatProjection;
}

export function learnJob(deps: Deps): PassJob {
  const { store, state, chats } = deps;
  const room = (now: Date) => Math.max(0, state.settings().learn.daily_cap - state.writtenOn(isoDay(now.getTime())));
  return {
    name: "learn",
    chatId: writerChatId,
    title: "recall",
    instructions: INSTRUCTIONS,
    tools: () => [],
    open: (_settings, now) => room(now) > 0,
    prompt: (input) => {
      const cards = store.cards();
      const failing = cards
        .filter(
          (c) =>
            c.card.source.agent_id === input.agentId && keepsFailing(c.schedule) && (!c.schedule.last_review || c.card.updated_at < c.schedule.last_review),
        )
        .slice(0, FAILING_PER_RUN);
      const slices: Slice[] = input.parts.map((part, i) => ({ id: `s${i + 1}`, title: part.title, mode: "new", text: part.material }));
      const inBatch = new Set(input.parts.map((part) => part.chatId));
      for (const f of failing) {
        const src = f.card.source;
        if (!src.conversation_id || inBatch.has(src.conversation_id)) continue;
        const text = formatTranscript(chats.since(src.conversation_id, src.agent_id, 0).rows, input.agentName).slice(-REPLAY_CHARS);
        if (text.length < MIN_NEW_CHARS) continue;
        slices.push({ id: `s${slices.length + 1}`, title: src.title, mode: "replay", forCard: f.card.id, text });
      }
      const openLeads = store.leads();
      return buildPrompt({
        agentName: input.agentName,
        slices,
        existing: overlappingCards(
          cards.map((c) => ({ id: c.card.id, front: c.card.front, back: c.card.back, tags: c.card.tags })),
          slices.map((s) => s.text),
        ),
        rejected: store
          .rejected()
          .slice(0, 40)
          .map((r) => ({ front: r.card.front, back: r.card.back, reps: r.reps })),
        room: room(input.now),
        failing: failing.map((c) => ({ id: c.card.id, front: c.card.front, back: c.card.back })),
        leads: {
          open: openLeads.map((l) => l.title),
          started: store.lessons().map((l) => l.lead.title),
          dismissed: store.dismissedLeads().map((d) => d.lead.title),
          room: MAX_OPEN_LEADS - openLeads.length,
        },
      });
    },
    apply: (input, answer) => {
      const now = input.now.getTime();
      const at = input.now.toISOString();
      const cards = store.cards();
      const byId = new Map(cards.map((c) => [c.card.id, c]));
      const ext = parseExtraction(answer.text, new Set(byId.keys()), { maxLeads: LEADS_PER_CONVERSATION * Math.max(1, input.parts.length) });
      const sourceOf = (slice: string | undefined) => {
        const part = input.parts[Number(/^s(\d+)$/.exec(slice ?? "")?.[1] ?? 1) - 1] ?? input.parts[0];
        const info = chats.info(part.chatId, input.agentId);
        return {
          agent_id: input.agentId,
          agent_name: input.agentName,
          conversation_id: part.chatId,
          title: info?.title ?? null,
          at: info?.lastMessageAt ?? null,
        };
      };
      const fresh = new Set(input.parts.map((_, i) => `s${i + 1}`));
      const fromHere = (slice: string | undefined) => !slice || fresh.has(slice);
      const fronts = [...cards.map((c) => c.card.front), ...store.rejected().map((r) => r.card.front)];
      const space = room(input.now);
      let written = 0;
      let capped = false;
      for (const cand of ext.cards) {
        if (!fromHere(cand.slice) || fronts.some((f) => similarFront(f, cand.front))) continue;
        if (written >= space) {
          capped = true;
          break;
        }
        const card: Card = {
          id: newCardId(now),
          front: cand.front,
          back: cand.back,
          tags: cand.tags,
          source: sourceOf(cand.slice),
          created_at: at,
          updated_at: at,
          updated_by: "recall",
          previous: [],
        };
        store.add(card);
        fronts.push(card.front);
        written += 1;
      }
      let revised = 0;
      for (const rev of ext.revisions) {
        const cur = byId.get(rev.id);
        if (!cur) continue;
        if ((rev.front ?? cur.card.front) === cur.card.front && (rev.back ?? cur.card.back) === cur.card.back) continue;
        store.edit(rev.id, { front: rev.front, back: rev.back }, "recall", now);
        revised += 1;
      }
      const openLeads = store.leads();
      const leadTitles = [...openLeads.map((l) => l.title), ...store.lessons().map((l) => l.lead.title), ...store.dismissedLeads().map((d) => d.lead.title)];
      let leads = 0;
      for (const cand of ext.leads) {
        if (openLeads.length + leads >= MAX_OPEN_LEADS) break;
        if (!fromHere(cand.slice) || leadTitles.some((t) => similarFront(t, cand.title))) continue;
        const lead: Lead = { id: newCardId(now), title: cand.title, why: cand.why, depth: cand.depth, source: sourceOf(cand.slice), created_at: at };
        store.addLead(lead);
        leadTitles.push(lead.title);
        leads += 1;
      }
      if (written) state.noteWritten(isoDay(now), written);
      const parts = [written && `${written} new`, revised && `${revised} revised`, leads && `${leads} lead${leads === 1 ? "" : "s"}`].filter(Boolean);
      const from = input.parts.length === 1 ? `"${sourceOf("s1").title ?? "a chat"}"` : `${input.parts.length} chats`;
      state.noteLearnRun(at, parts.length ? `${parts.join(" · ")} from ${from}${capped ? " · cards at the day's cap" : ""}` : "nothing worth a card");
      return { items: { cards: written, revisions: revised, leads }, capped };
    },
  };
}
