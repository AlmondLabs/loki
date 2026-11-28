import { useState, type ReactNode } from "react";
import { GOAL_HORIZONS, HORIZON_LABEL, goalHealth, weeklyHabitProgress, type Goal, type GoalHorizon } from "../../../core/goals.ts";
import { Button, Chip, Field, Sheet, TextArea } from "../components";
import { useNow } from "../components/use-now";
import type { GoalsModel } from "../shell/use-goals";
import { ago } from "../shared/ago";
import { Icon } from "./icons";
import { RowGroup, SkeletonRows } from "./rows";
import { BackButton, Scroll, TopBar } from "./ui";

export function PhoneGoals({
  goals,
  agents,
  banner,
  backLabel = "more",
  onBack,
  onOpenChat,
}: {
  goals: GoalsModel;
  agents: ReadonlyArray<{ id: string; name: string }>;
  banner: ReactNode;
  backLabel?: string;
  onBack: () => void;
  onOpenChat: (agentId: string, conversationId: string, brief?: string | null) => void;
}) {
  const now = useNow();
  const snap = goals.snap;
  const allGoals = snap?.goals ?? [];
  const active = allGoals.filter((g) => g.status === "active");
  const suggested = allGoals.filter((g) => g.status === "suggested");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const selected = allGoals.find((g) => g.id === selectedId) ?? null;
  const back = <BackButton onClick={selected ? () => setSelectedId(null) : onBack} label={selected ? "Goals" : backLabel} />;
  const firstAgentId = agents.length > 0 ? agents[0].id : null;

  const handleDiscover = async () => {
    const started = await goals.startDiscover(snap?.settings.partner_agent_id ?? firstAgentId);
    if (started) onOpenChat(started.agent_id, started.conversation_id, started.brief);
  };

  const handleWork = async (goalId: string) => {
    const started = await goals.startWork(goalId);
    if (started) onOpenChat(started.agent_id, started.conversation_id, started.brief);
  };

  if (selected) {
    return (
      <PhoneGoalDetail
        goal={selected}
        goals={allGoals}
        timezone={snap?.settings.timezone ?? null}
        now={now}
        banner={banner}
        back={back}
        onWork={() => void handleWork(selected.id)}
        onAdopt={() => void goals.update({ id: selected.id, status: "active" })}
        onAchieve={() => void goals.update({ id: selected.id, status: "achieved" })}
        onDelete={() => {
          setSelectedId(null);
          void goals.remove(selected.id);
        }}
        onLogProgress={(note) => goals.addProgress(selected.id, note)}
        onToggleHabit={(day, done) => void goals.toggleHabit(selected.id, day, done)}
      />
    );
  }

  return (
    <div className="loki-phone-page">
      <TopBar
        left={back}
        title="Goals"
        sub={snap ? `${active.length} active${suggested.length ? ` · ${suggested.length} suggested` : ""}` : undefined}
        right={
          <button type="button" className="loki-phone-icon-btn" aria-label="New goal" onClick={() => setAdding(true)}>
            <Icon name="plus" size={22} />
          </button>
        }
        banner={banner}
      />
      <Scroll flush memory="goals">
        {!snap ? (
          <SkeletonRows label="Loading goals…" rows={4} />
        ) : allGoals.length === 0 ? (
          <div className="loki-phone-empty">
            <p className="loki-phone-headline">No goals yet</p>
            <p>Set your short, medium, and long term goals with an agent or add one here.</p>
            <div className="grid gap-2" style={{ marginTop: 12 }}>
              <Button size="touch" tone="positive" block onClick={() => void handleDiscover()}>
                Discover Goals
              </Button>
              <Button size="touch" tone="paper" block onClick={() => setAdding(true)}>
                Add a Goal
              </Button>
            </div>
          </div>
        ) : (
          <>
            {suggested.length > 0 && (
              <RowGroup title="Suggested">
                {suggested.map((g) => (
                  <li key={g.id} className="loki-phone-row-item">
                    <button type="button" className="loki-phone-row" onClick={() => setSelectedId(g.id)}>
                      <span className="loki-phone-row-copy">
                        <span className="loki-phone-row-title">
                          <span className="loki-phone-ellipsis">{g.title}</span>
                        </span>
                        <span className="loki-phone-row-preview">{HORIZON_LABEL[g.horizon]} · Tap to adopt or dismiss</span>
                      </span>
                    </button>
                  </li>
                ))}
              </RowGroup>
            )}

            {GOAL_HORIZONS.map((horizon) => {
              const items = active.filter((g) => g.horizon === horizon);
              if (!items.length) return null;
              return (
                <RowGroup key={horizon} title={HORIZON_LABEL[horizon]}>
                  {items.map((g) => {
                    const health = goalHealth(g, now);
                    return (
                      <li key={g.id} className="loki-phone-row-item">
                        <button type="button" className="loki-phone-row" onClick={() => setSelectedId(g.id)}>
                          <span className="loki-phone-row-copy">
                            <span className="loki-phone-row-title">
                              <span className="loki-phone-ellipsis">{g.title}</span>
                              <span className="loki-phone-row-time">{health.label}</span>
                            </span>
                            <span className="loki-phone-row-preview">{g.next_step ?? g.progress ?? g.why ?? "No next step yet"}</span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </RowGroup>
              );
            })}
          </>
        )}
      </Scroll>

      {adding && <PhoneNewGoalSheet onCreate={(payload) => goals.create(payload)} onClose={() => setAdding(false)} />}
    </div>
  );
}

function PhoneGoalDetail({
  goal,
  goals: _goals,
  timezone,
  now,
  banner,
  back,
  onWork,
  onAdopt,
  onAchieve,
  onDelete,
  onLogProgress,
  onToggleHabit,
}: {
  goal: Goal;
  goals: readonly Goal[];
  timezone: string | null;
  now: number;
  banner: ReactNode;
  back: ReactNode;
  onWork: () => void;
  onAdopt: () => void;
  onAchieve: () => void;
  onDelete: () => void;
  onLogProgress: (note: string) => Promise<boolean>;
  onToggleHabit: (day: string, done: boolean) => void;
}) {
  const [note, setNote] = useState("");
  const health = goalHealth(goal, now);
  const week = goal.lead_habit ? weeklyHabitProgress(goal.lead_habit, new Date(now), timezone) : null;

  const submit = async () => {
    const clean = note.trim();
    if (!clean) return;
    if (await onLogProgress(clean)) setNote("");
  };

  return (
    <div className="loki-phone-page">
      <TopBar left={back} title={goal.title} sub={`${HORIZON_LABEL[goal.horizon]} · ${health.label}`} banner={banner} />
      <Scroll>
        <div className="grid gap-4" style={{ padding: "12px 16px 24px" }}>
          <div className="grid gap-2">
            {goal.status === "suggested" ? (
              <Button size="touch" tone="positive" block onClick={onAdopt}>
                Adopt Goal
              </Button>
            ) : (
              <Button size="touch" tone="positive" block onClick={onWork}>
                Work on This
              </Button>
            )}
          </div>

          {(goal.why || goal.next_step || goal.obstacle) && (
            <div className="grid gap-2">
              {goal.why && <p className="loki-phone-body">{goal.why}</p>}
              {goal.next_step && <p className="loki-phone-meta">{`Next: ${goal.next_step}`}</p>}
              {goal.obstacle && <p className="loki-phone-meta">{`Obstacle: ${goal.obstacle}${goal.fallback_plan ? ` -> ${goal.fallback_plan}` : ""}`}</p>}
            </div>
          )}

          {goal.lead_habit && week && (
            <div className="grid gap-2">
              <div className="loki-phone-meta">{`${goal.lead_habit.label} (${week.done}/${week.target} this week)`}</div>
              <div className="flex flex-wrap gap-2">
                {week.days.map((d) => (
                  <Chip key={d.day} touch active={d.done} onClick={() => onToggleHabit(d.day, !d.done)}>
                    {d.label}
                  </Chip>
                ))}
              </div>
            </div>
          )}

          <div className="grid gap-2">
            <Field
              size="touch"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Log progress note"
              onKeyDown={(e) => e.key === "Enter" && void submit()}
            />
            <Button size="touch" tone="paper" block onClick={() => void submit()} disabled={!note.trim()}>
              Log Progress
            </Button>
          </div>

          {goal.entries.length > 0 && (
            <div className="grid gap-2">
              {[...goal.entries].reverse().map((e) => (
                <div key={e.id} className="grid gap-1">
                  <div className="loki-phone-body">{e.note}</div>
                  <div className="loki-phone-meta">{ago(e.at, now)}</div>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            {goal.status !== "achieved" && goal.status !== "suggested" && (
              <Button size="touch" tone="paper" className="flex-1" onClick={onAchieve}>
                Mark Achieved
              </Button>
            )}
            <Button size="touch" tone="negative" className="flex-1" onClick={onDelete}>
              {goal.status === "suggested" ? "Dismiss" : "Delete"}
            </Button>
          </div>
        </div>
      </Scroll>
    </div>
  );
}

function PhoneNewGoalSheet({
  onCreate,
  onClose,
}: {
  onCreate: (payload: { title: string; horizon: GoalHorizon; why?: string | null; next_step?: string | null }) => Promise<boolean>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [horizon, setHorizon] = useState<GoalHorizon>("short");
  const [why, setWhy] = useState("");
  const [nextStep, setNextStep] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy || !title.trim()) return;
    setBusy(true);
    const ok = await onCreate({
      title: title.trim(),
      horizon,
      why: why.trim() || null,
      next_step: nextStep.trim() || null,
    });
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Sheet label="New goal" onClose={onClose} placement="bottom" className="loki-phone-sheet">
      <div className="loki-phone-sheet-copy">
        <div className="loki-phone-title">New goal</div>
      </div>
      <Field size="touch" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Goal title" />
      <div className="loki-phone-chips">
        {GOAL_HORIZONS.map((h) => (
          <Chip key={h} touch active={horizon === h} onClick={() => setHorizon(h)}>
            {HORIZON_LABEL[h]}
          </Chip>
        ))}
      </div>
      <TextArea size="touch" rows={2} value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Outcome (optional)" />
      <Field size="touch" value={nextStep} onChange={(e) => setNextStep(e.target.value)} placeholder="Next concrete step (optional)" />
      <div className="loki-phone-sheet-actions">
        <Button size="touch" tone="paper" onClick={onClose}>
          Cancel
        </Button>
        <Button size="touch" tone="positive" onClick={() => void submit()} disabled={busy || !title.trim()}>
          {busy ? "Saving…" : "Add Goal"}
        </Button>
      </div>
    </Sheet>
  );
}
