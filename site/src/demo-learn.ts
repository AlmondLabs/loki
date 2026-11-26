import { review, newSchedule, type Grade } from "../../core/learn/fsrs.ts";
import { learnTitle, type Card, type CardSource, type Lead, type LearnSnapshot } from "../../core/learn/model.ts";
import { lessonBrief } from "../../core/learn/extract.ts";

const DAY = 86_400_000;

const from = (agent: string, conversation: string, title: string, at: string): CardSource => ({
  agent_id: agent,
  agent_name: agent,
  conversation_id: conversation,
  title,
  at,
});

export function startingLearn(now: number): LearnSnapshot {
  const at = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString();
  const card = (id: string, front: string, back: string, source: CardSource, daysAgo: number): Card => ({
    id,
    front,
    back,
    tags: [],
    source,
    created_at: at(daysAgo),
    updated_at: at(daysAgo),
    updated_by: "recall",
    previous: [],
  });
  const reviewed = (daysAgo: number) => ({ ...review(newSchedule(now - daysAgo * DAY), 3, now - daysAgo * DAY), due: at(0.01) });
  const tests = from("wren", "checkout-test", "Fix the flaky checkout test", at(0.1));
  const sleep = from("ira", "sleep-paper", "Read: sleep and memory", at(1));
  const lisbon = from("ira", "lisbon", "A long weekend in Lisbon", at(3));
  const leads: Lead[] = [
    {
      id: "clock-injection",
      title: "Injecting the clock in tests",
      why: "The checkout fix pinned the clock in one fixture; the same move makes any time-dependent test repeatable.",
      depth: "primer",
      source: tests,
      created_at: at(0.1),
    },
    {
      id: "sleep-stages",
      title: "How sleep stages are measured",
      why: "The paper's claims rest on telling deep sleep from the rest, which the summary took for granted.",
      depth: "course",
      source: sleep,
      created_at: at(1),
    },
  ];
  return {
    cards: [
      {
        card: card(
          "midnight-test",
          "Why does a test that builds its dates from new Date() fail around midnight UTC?",
          "The run starts on one day and asserts on the next: the clock moved under it. Pinning the clock in the fixture makes every run read the same day.",
          tests,
          0.1,
        ),
        schedule: newSchedule(now - 0.1 * DAY),
      },
      {
        card: card(
          "replay-timing",
          "When in the night does most of the replay of new memories happen?",
          "In the first three hours, during deep sleep. Cut those short and the move into long-term storage stops.",
          sleep,
          1,
        ),
        schedule: newSchedule(now - DAY),
      },
      {
        card: card(
          "tram-28",
          "Which Lisbon tram climbs through Graça and down past the cathedral in Alfama?",
          "The 28, from Martim Moniz up through Graça, past the cathedral and on to Estrela.",
          lisbon,
          3,
        ),
        schedule: reviewed(3),
      },
      {
        card: card(
          "spacing",
          "Why does a review just before you would forget do more than one straight after learning?",
          "Recalling something that has started to fade strengthens it more, so each right answer can push the next one further out.",
          sleep,
          6,
        ),
        schedule: reviewed(6),
      },
    ],
    rejected: [],
    worker: { enabled: true, daily_cap: 8, last_run_at: at(0.05), last_run_note: "wrote 2 cards and 2 leads from 3 quiet chats", written_today: 2 },
    leads,
    dismissed_leads: [],
    lessons: [],
  };
}

type Move = (snap: LearnSnapshot, now: number) => LearnSnapshot;

export const gradeCard =
  (id: string, g: Grade): Move =>
  (snap, now) => ({ ...snap, cards: snap.cards.map((c) => (c.card.id === id ? { ...c, schedule: review(c.schedule, g, now) } : c)) });

export const removeCard =
  (id: string): Move =>
  (snap, now) => {
    const gone = snap.cards.find((c) => c.card.id === id);
    if (!gone) return snap;
    return {
      ...snap,
      cards: snap.cards.filter((c) => c !== gone),
      rejected: [{ card: gone.card, at: new Date(now).toISOString(), reps: gone.schedule.reps }, ...snap.rejected],
    };
  };

export const restoreCard =
  (id: string): Move =>
  (snap, now) => {
    const back = snap.rejected.find((r) => r.card.id === id);
    if (!back) return snap;
    return { ...snap, rejected: snap.rejected.filter((r) => r !== back), cards: [...snap.cards, { card: back.card, schedule: newSchedule(now) }] };
  };

export const editCard =
  (id: string, text: { front?: string; back?: string }): Move =>
  (snap, now) => ({
    ...snap,
    cards: snap.cards.map((c) =>
      c.card.id === id
        ? {
            ...c,
            card: {
              ...c.card,
              front: text.front ?? c.card.front,
              back: text.back ?? c.card.back,
              updated_by: "you",
              updated_at: new Date(now).toISOString(),
              previous: [...c.card.previous, { front: c.card.front, back: c.card.back, at: c.card.updated_at, by: c.card.updated_by }],
            },
          }
        : c,
    ),
  });

export const dismissLead =
  (id: string): Move =>
  (snap, now) => {
    const lead = snap.leads.find((l) => l.id === id);
    if (!lead) return snap;
    return { ...snap, leads: snap.leads.filter((l) => l !== lead), dismissed_leads: [{ lead, at: new Date(now).toISOString() }, ...snap.dismissed_leads] };
  };
export const restoreLead =
  (id: string): Move =>
  (snap) => {
    const back = snap.dismissed_leads.find((d) => d.lead.id === id);
    if (!back) return snap;
    return { ...snap, dismissed_leads: snap.dismissed_leads.filter((d) => d !== back), leads: [...snap.leads, back.lead] };
  };

export function lessonOf(lead: Lead): { agentId: string; conversationId: string; brief: string; title: string } {
  return { agentId: lead.source.agent_id ?? "ira", conversationId: `learn-${lead.id}`, brief: lessonBrief(lead), title: learnTitle(lead.title) };
}
