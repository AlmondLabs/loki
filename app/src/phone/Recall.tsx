import { useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useNow } from "../components/useNow";
import { ANSWERS, describeGap, isNew, previews, type Grade } from "../../../core/recall/fsrs.ts";
import { learnTitle, updatedSinceReview, type CardSource, type CardWithSchedule, type Lead } from "../../../core/recall/model.ts";
import { lessonBrief } from "../../../core/recall/extract.ts";
import type { Recall as RecallModel } from "../shell/useRecall";
import type { useDeckPass } from "../recall/useDeckPass";
import { ago } from "../board/model";
import { avatarUrl } from "../desk/env";
import { Button } from "../components";
import { useLeave, type LeaveFrames } from "../kit/leave";
import { lastInput, prefersReducedMotion } from "../kit/motion";
import { spring } from "../kit/spring";
import { Avatar, MenuRow, RowGroup, SkeletonCard, SkeletonRows } from "./rows";
import { navigate, type LearnPage } from "./router";
import { BackButton, Scroll, TopBar } from "./ui";

/** One sitting with the deck (recall/useDeckPass). Phone.tsx holds it above the routes, so leaving Learn and coming back keeps the card and the pass. */
export type DeckPass = ReturnType<typeof useDeckPass>;

/**
 * Learn on the phone, as the desktop's Learn column lists it: Learn opens on its lists — Review (the deck),
 * Leads (things worth learning properly, each a lesson away), Lessons under way, and Deleted — and each
 * opens as its own page (#/learn/<page>), so the deck and the leads never share a screen. The pass is held
 * by Phone.tsx, so leaving Review and coming back resumes it; Back returns to where each was opened from.
 */
export function Learn({ view, recall, pass, banner, backLabel = "home", onBack, onBegin, onOpen }: { view: LearnPage | undefined; recall: RecallModel; pass: DeckPass; banner: ReactNode; backLabel?: string; onBack: () => void; /** A lesson begins: its conversation opens and the brief goes out as the person's first message. */ onBegin: (agentId: string, conversationId: string, brief: string, title: string) => void; /** A conversation opens (where a lead came up, a lesson under way). */ onOpen: (agentId: string, conversationId: string) => void }) {
  const back = <BackButton onClick={onBack} label={backLabel} />;
  if (view === "review") return <Review recall={recall} pass={pass} banner={banner} back={back} />;
  if (view === "leads") return <Leads recall={recall} banner={banner} back={back} onBegin={onBegin} onOpen={onOpen} />;
  if (view === "lessons") return <Lessons recall={recall} banner={banner} back={back} onBegin={onBegin} onOpen={onOpen} />;
  if (view === "deleted") return <Deleted recall={recall} banner={banner} back={back} />;
  return <LearnHome recall={recall} banner={banner} back={back} />;
}

const openLearn = (view: LearnPage) => navigate({ kind: "learn", view });

/** Learn's lists, each with what it holds. Before the Mac answers, their shapes; with the writer off and nothing written, why. */
function LearnHome({ recall, banner, back }: { recall: RecallModel; banner: ReactNode; back: ReactNode }) {
  const snap = recall.snap;
  const deleted = snap ? snap.rejected.length + snap.dismissedLeads.length : 0;
  return (
    <div className="loki-phone-page">
      <TopBar left={back} title="Learn" />
      {banner}
      <Scroll flush memory="learn">
        {!snap ? (
          <SkeletonRows label="Loading Learn…" rows={4} />
        ) : (
          <>
            {snap.cards.length === 0 && snap.leads.length === 0 && !snap.worker.enabled && <Off dailyCap={snap.worker.dailyCap} />}
            <RowGroup>
              <MenuRow icon="refresh" label="Review" aside={recall.due ? `${recall.due} due` : snap.cards.length ? "Nothing due" : null} page launch="learn-review" onClick={() => openLearn("review")} />
              <MenuRow icon="learn" label="Leads" aside={snap.leads.length || null} page launch="learn-leads" onClick={() => openLearn("leads")} />
              <MenuRow icon="desk" label="Lessons under way" aside={snap.lessons.length || null} page launch="learn-lessons" onClick={() => openLearn("lessons")} />
              <MenuRow icon="archive" label="Deleted" aside={deleted || null} page launch="learn-deleted" onClick={() => openLearn("deleted")} />
            </RowGroup>
          </>
        )}
      </Scroll>
    </div>
  );
}

/**
 * Review: the deck, thumb-sized, in the phone's grammar. The card names its source the way a message names
 * its author — the agent's face and name, the conversation, when — then the front, one button for the
 * answer, then Again or Got it side by side, each with its next gap; Delete and Undo delete underneath.
 *
 * The card moves as a card: Show the answer turns it over, a grade throws it off the way the Inbox throws
 * its cards (Got it to the right, Again to the left), a delete lets it fall away, and the next rises into
 * its place. Nothing moves for a key: a pass run from the keyboard is instant.
 */
function Review({ recall, pass, banner, back }: { recall: RecallModel; pass: DeckPass; banner: ReactNode; back: ReactNode }) {
  const cards = recall.snap?.cards ?? [];
  const { current } = pass;
  return (
    <div className="loki-phone-page">
      <TopBar left={back} title="Review" sub={`${recall.due} due · ${cards.length} card${cards.length === 1 ? "" : "s"}${current && pass.total ? ` · ${pass.passed.size + 1} of ${pass.total}` : ""}`} progress={pass.total ? pass.passed.size / pass.total : null} />
      {banner}
      <Scroll>
        <div className="loki-phone-learn">
          {!recall.snap ? (
            <SkeletonCard label="Loading the cards…" />
          ) : !current && cards.length === 0 && !recall.snap.worker.enabled ? (
            <Off dailyCap={recall.snap.worker.dailyCap} />
          ) : !current ? (
            <Rest cards={cards.length} passed={pass.passed.size} nextDue={pass.nextDue} />
          ) : (
            <PhoneCard
              key={current.card.id}
              c={current}
              position={pass.passed.size + 1}
              total={pass.total}
              revealed={pass.revealed}
              onReveal={pass.reveal}
              onAnswer={(g) => {
                void recall.grade(current.card.id, g);
                pass.advance();
              }}
              onDelete={() => {
                void recall.remove(current.card.id);
                pass.advance();
              }}
              onUndo={() => void recall.undo()}
            />
          )}
        </div>
      </Scroll>
    </div>
  );
}

const DEPTH: Record<Lead["depth"], string> = { primer: "A primer · one sitting", course: "A course · several sittings" };

/** Where a lead came up, as a message header: the agent's face and name, the conversation and when. */
function LeadSource({ source, at, aside }: { source: CardSource; at: string; aside?: ReactNode }) {
  return (
    <div className="loki-phone-learn-source">
      <Avatar name={source.agentName ?? "agent"} src={source.agentId ? avatarUrl(source.agentId) : null} size={36} />
      <div className="loki-phone-row-copy">
        <span className="loki-phone-learn-who">
          <span className="loki-phone-ellipsis">{source.agentName ?? "A conversation"}</span>
          {aside}
        </span>
        <span className="loki-phone-row-preview">
          {source.title ?? "a conversation"} · {ago(at)}
        </span>
      </div>
    </div>
  );
}

/**
 * The leads, newest first: what went by in a conversation without being understood, quoted where it came
 * up. Start the lesson makes a [Learn] conversation with the agent who was there and opens it with the
 * brief as your first message; Not this sets it aside (the writer reads that, and Deleted brings it back).
 */
function Leads({ recall, banner, back, onBegin, onOpen }: { recall: RecallModel; banner: ReactNode; back: ReactNode; onBegin: (agentId: string, conversationId: string, brief: string, title: string) => void; onOpen: (agentId: string, conversationId: string) => void }) {
  const snap = recall.snap;
  const leads = snap?.leads ?? [];
  const start = async (id: string) => {
    const lesson = await recall.startLead(id);
    if (lesson) onBegin(lesson.agentId, lesson.conversationId, lesson.brief, lesson.title);
  };
  return (
    <div className="loki-phone-page">
      <TopBar left={back} title="Leads" sub={snap ? `${leads.length} lead${leads.length === 1 ? "" : "s"}` : undefined} />
      {banner}
      <Scroll>
        <div className="loki-phone-learn">
          {!snap ? (
            <SkeletonCard label="Loading the leads…" />
          ) : leads.length === 0 ? (
            <div className="loki-phone-empty">
              <p className="loki-phone-headline">No leads yet</p>
              <p>
                {snap.worker.enabled
                  ? "When a conversation goes quiet, the writer names what went by in it without being understood: a concept, an acronym, something you took the agent's word for. Each is a lesson away."
                  : "Leads come from the writer on the Mac, and it is off. Turn it on from the Mac: Learn, or Settings › learn."}
              </p>
            </div>
          ) : (
            leads.map((l) => {
              const busy = recall.starting === l.id;
              return (
                <section key={l.id} aria-label={`lead: ${l.title}`} className="loki-phone-learn-card">
                  <LeadSource source={l.source} at={l.createdAt} />
                  <div className="loki-phone-learn-front">{l.title}</div>
                  <p className="loki-phone-lead-why">{l.why}</p>
                  <p className="loki-phone-meta">{DEPTH[l.depth]}</p>
                  <Button size="touch" tone="positive" block className="loki-phone-lead-start" disabled={recall.starting !== null} onClick={() => void start(l.id)}>
                    {busy ? "Starting the lesson…" : "Start the lesson"}
                  </Button>
                  <div className="loki-phone-learn-foot">
                    <Button size="touch" onClick={() => void recall.dismissLead(l.id)}>
                      Not this
                    </Button>
                    {l.source.agentId && l.source.conversationId && (
                      <Button size="touch" tone="paper" onClick={() => onOpen(l.source.agentId!, l.source.conversationId!)}>
                        Where it came up
                      </Button>
                    )}
                  </div>
                </section>
              );
            })
          )}
        </div>
      </Scroll>
    </div>
  );
}

/** Lessons begun from a lead, each its [Learn] conversation; one whose brief never arrived offers to send it. */
function Lessons({ recall, banner, back, onBegin, onOpen }: { recall: RecallModel; banner: ReactNode; back: ReactNode; onBegin: (agentId: string, conversationId: string, brief: string, title: string) => void; onOpen: (agentId: string, conversationId: string) => void }) {
  const snap = recall.snap;
  const lessons = snap?.lessons ?? [];
  return (
    <div className="loki-phone-page">
      <TopBar left={back} title="Lessons under way" />
      {banner}
      <Scroll flush>
        {!snap ? (
          <SkeletonRows label="Loading the lessons…" rows={3} />
        ) : lessons.length === 0 ? (
          <div className="loki-phone-empty">
            <p className="loki-phone-headline">No lessons yet</p>
            <p>A lead you start becomes a lesson: a conversation with the agent who was there, kept out of the Inbox.</p>
          </div>
        ) : (
          <ul className="loki-phone-list" aria-label="lessons under way">
            {lessons.map((s) => (
              <li key={s.conversationId} className="loki-phone-row-item">
                <button type="button" className="loki-phone-row" onClick={() => onOpen(s.agentId, s.conversationId)}>
                  <Avatar name={s.lead.source.agentName ?? "agent"} src={avatarUrl(s.agentId)} />
                  <span className="loki-phone-row-copy">
                    <span className="loki-phone-row-title">
                      <span className="loki-phone-ellipsis">{s.lead.title}</span>
                    </span>
                    <span className="loki-phone-row-preview">
                      {s.lead.source.agentName ?? "agent"} · {s.empty ? "brief not sent" : `started ${ago(s.startedAt)}`}
                    </span>
                  </span>
                </button>
                {s.empty && (
                  <button type="button" className="loki-phone-row-action" onClick={() => onBegin(s.agentId, s.conversationId, lessonBrief(s.lead), learnTitle(s.lead.title))}>
                    Send the brief
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Scroll>
    </div>
  );
}

/** What was deleted: cards (the writer reads them as "not wanted") and leads set aside, each with Restore. */
function Deleted({ recall, banner, back }: { recall: RecallModel; banner: ReactNode; back: ReactNode }) {
  const snap = recall.snap;
  const cards = snap?.rejected ?? [];
  const leads = snap?.dismissedLeads ?? [];
  return (
    <div className="loki-phone-page">
      <TopBar left={back} title="Deleted" />
      {banner}
      <Scroll flush>
        {!snap ? (
          <SkeletonRows label="Loading what was deleted…" rows={3} />
        ) : cards.length + leads.length === 0 ? (
          <div className="loki-phone-empty">
            <p className="loki-phone-headline">Nothing deleted</p>
            <p>A card you delete, or a lead you set aside, waits here in case you want it back.</p>
          </div>
        ) : (
          <>
            {cards.length > 0 && (
              <RowGroup title="Cards">
                {cards.map((r) => (
                  <DeletedRow key={r.card.id} title={r.card.front} line={`deleted ${ago(r.at)}`} onRestore={() => void recall.restore(r.card.id)} />
                ))}
              </RowGroup>
            )}
            {leads.length > 0 && (
              <RowGroup title="Leads">
                {leads.map((d) => (
                  <DeletedRow key={d.lead.id} title={d.lead.title} line={`set aside ${ago(d.at)}`} onRestore={() => void recall.restoreLead(d.lead.id)} />
                ))}
              </RowGroup>
            )}
          </>
        )}
      </Scroll>
    </div>
  );
}

function DeletedRow({ title, line, onRestore }: { title: string; line: string; onRestore: () => void }) {
  return (
    <li className="loki-phone-row-item" data-dim>
      <div className="loki-phone-row">
        <span className="loki-phone-row-copy">
          <span className="loki-phone-row-title">
            <span className="loki-phone-ellipsis">{title}</span>
          </span>
          <span className="loki-phone-row-preview">{line}</span>
        </span>
      </div>
      <button type="button" className="loki-phone-row-action" onClick={onRestore} aria-label={`Restore ${title}`}>
        Restore
      </button>
    </li>
  );
}

/** The writer is off and nothing is written: what Learn is, what it costs, and where it is switched on (the Mac). */
function Off({ dailyCap }: { dailyCap: number }) {
  return (
    <div className="loki-phone-empty">
      <p className="loki-phone-headline">Learn is off</p>
      <p>Once it is on, a writer on the Mac turns conversations that have gone quiet into flashcards, and they wait here on a schedule. Each run spends a little of your provider budget, up to {dailyCap} cards a day.</p>
      <p className="loki-phone-meta">Turn it on from the Mac: Learn, or Settings › learn.</p>
    </div>
  );
}

/** No card to show: none written yet, none due, or the sitting is done. */
function Rest({ cards, passed, nextDue }: { cards: number; passed: number; nextDue: number | undefined }) {
  const now = useNow();
  if (cards === 0)
    return (
      <div className="loki-phone-empty">
        <p className="loki-phone-headline">Nothing to learn yet</p>
        <p>Cards are written in the background from conversations that have gone quiet.</p>
      </div>
    );
  return (
    <div className="loki-phone-empty">
      <p className="loki-phone-headline">{passed ? "Done for now" : "Nothing due"}</p>
      {nextDue ? <p>The next one is due in {describeGap(nextDue - now)}.</p> : null}
    </div>
  );
}

/** Where the card came from, as a message header: the agent's face and name, the conversation and when, and what is new about it. */
function Source({ c }: { c: CardWithSchedule }) {
  const { source } = c.card;
  const fresh = isNew(c.schedule) ? "New" : updatedSinceReview(c) ? `Updated ${ago(c.card.updatedAt)}` : null;
  return (
    <div className="loki-phone-learn-source">
      <Avatar name={source.agentName ?? "agent"} src={source.agentId ? avatarUrl(source.agentId) : null} size={36} />
      <div className="loki-phone-row-copy">
        <span className="loki-phone-learn-who">
          <span className="loki-phone-ellipsis">{source.agentName ?? "A conversation"}</span>
          {fresh && <span className="loki-phone-learn-tag">{fresh}</span>}
        </span>
        <span className="loki-phone-row-preview">
          {source.title ?? "a conversation"}
          {source.at ? ` · ${ago(source.at)}` : ""}
          {c.card.tags.length ? ` · ${c.card.tags.join(", ")}` : ""}
        </span>
      </div>
    </div>
  );
}

/** How a graded card leaves: thrown right for a pass, left for a miss, the Inbox's directions and tilt. */
const THROW = (dir: 1 | -1): Keyframe[] => [{ transform: "none", opacity: 1 }, { transform: `translateX(${dir * 115}%) rotate(${dir * 8}deg)`, opacity: 0.6 }];
/** A deleted card sinks and fades where it was. */
const DROP: Keyframe[] = [{ transform: "none", opacity: 1 }, { transform: "translateY(24px) scale(0.94)", opacity: 0 }];
/** The half of a turn the card makes with its front up; the other half brings the answer round. */
const TURN_MS = 140;
const moves = () => lastInput() !== "key" && !prefersReducedMotion();

function PhoneCard({ c, position, total, revealed, onReveal, onAnswer, onDelete, onUndo }: { c: CardWithSchedule; position: number; total: number; revealed: boolean; onReveal: () => void; onAnswer: (g: Grade) => void; onDelete: () => void; onUndo: () => void }) {
  const gaps = previews(c.schedule);
  const ref = useRef<HTMLElement>(null);
  // How this card will leave, set by what sends it (a grade, a delete); read by useLeave as it unmounts.
  const exit = useRef<LeaveFrames>(null);
  useLeave(ref, () => exit.current, 280);
  // The card after one that left rises into its place; the first of a pass, or one reached by a key, is just there.
  const [rises] = useState(() => position > 1 && moves());
  const leave = (frames: LeaveFrames, then: () => void) => {
    exit.current = moves() ? frames : null;
    then();
  };
  // Turn the card over: the front turns away edge-on, the answer is put in, and the card comes round showing it.
  const reveal = () => {
    const el = ref.current;
    if (!el || typeof el.animate !== "function" || !moves()) return onReveal();
    const away = el.animate([{ transform: "perspective(1200px) rotateY(0deg)" }, { transform: "perspective(1200px) rotateY(90deg)" }], { duration: TURN_MS, easing: "ease-in", fill: "forwards" });
    const round = () => {
      flushSync(onReveal);
      away.cancel();
      const s = spring("snappy");
      el.animate([{ transform: "perspective(1200px) rotateY(-90deg)" }, { transform: "perspective(1200px) rotateY(0deg)" }], { duration: s.ms, easing: s.easing });
    };
    away.finished.then(round, round);
  };
  return (
    <section ref={ref} aria-label={`card ${position} of ${total}`} className="loki-phone-learn-card" data-rise={rises || undefined}>
      <Source c={c} />
      <div className="loki-phone-learn-front">{c.card.front}</div>
      {revealed ? (
        <div className="loki-phone-learn-back">{c.card.back}</div>
      ) : (
        <Button size="touch" tone="paper" block onClick={reveal}>
          Show the answer
        </Button>
      )}
      {revealed && (
        <div className="loki-phone-learn-grades">
          {ANSWERS.map(({ grade, label }) => (
            <button key={grade} type="button" className={grade >= 3 ? "loki-phone-decide-btn loki-phone-decide-btn--affirm" : "loki-phone-decide-btn"} aria-label={`${label}, next in ${gaps[grade]}`} onClick={() => leave(THROW(grade >= 3 ? 1 : -1), () => onAnswer(grade))}>
              <span className="loki-phone-learn-grade">{label[0].toUpperCase() + label.slice(1)}</span>
              <span className="loki-phone-learn-gap">{gaps[grade]}</span>
            </button>
          ))}
        </div>
      )}
      <div className="loki-phone-learn-foot">
        <Button size="touch" tone="negative" onClick={() => leave(DROP, onDelete)}>
          Delete card
        </Button>
        <Button size="touch" onClick={onUndo}>
          Undo delete
        </Button>
      </div>
    </section>
  );
}
