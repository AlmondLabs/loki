import { useState, type ReactNode } from "react";
import { GOAL_HORIZONS, HORIZON_LABEL, goalHealth, weeklyHabitProgress, type Goal, type GoalHorizon } from "../../../core/goals.ts";
import { resolveDiscoverAgentId } from "../goals/views";
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
  const [discovering, setDiscovering] = useState(false);

  const selected = allGoals.find((g) => g.id === selectedId) ?? null;
  const back = <BackButton onClick={selected ? () => setSelectedId(null) : onBack} label={selected ? "Goals" : backLabel} />;
  const defaultAgentId = resolveDiscoverAgentId(agents, null, snap?.settings.partner_agent_id);

  const handleDiscover = async (agentId: string | null) => {
    const started = await goals.startDiscover(agentId);
    if (started) onOpenChat(started.agent_id, started.conversation_id, started.brief);
  };

  const requestDiscover = () => {
    if (agents.length > 1) setDiscovering(true);
    else void handleDiscover(defaultAgentId);
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
        <PhoneGoalsBody
          loading={!snap}
          empty={allGoals.length === 0}
          suggested={suggested}
          active={active}
          agentsCount={agents.length}
          now={now}
          onSelect={setSelectedId}
          onDiscover={requestDiscover}
          onAdd={() => setAdding(true)}
        />
      </Scroll>

      {adding && <PhoneNewGoalSheet onCreate={(payload) => goals.create(payload)} onClose={() => setAdding(false)} />}
      {discovering && agents.length > 1 && (
        <PhoneDiscoverGoalSheet
          agents={agents}
          initialAgentId={defaultAgentId}
          onStart={async (id) => {
            await handleDiscover(id);
            setDiscovering(false);
          }}
          onClose={() => setDiscovering(false)}
        />
      )}
    </div>
  );
}

function PhoneGoalsBody({
  loading,
  empty,
  suggested,
  active,
  agentsCount,
  now,
  onSelect,
  onDiscover,
  onAdd,
}: {
  loading: boolean;
  empty: boolean;
  suggested: readonly Goal[];
  active: readonly Goal[];
  agentsCount: number;
  now: number;
  onSelect: (id: string) => void;
  onDiscover: () => void;
  onAdd: () => void;
}) {
  if (loading) return <SkeletonRows label="Loading goals…" rows={4} />;
  if (empty) {
    return (
      <div className="loki-phone-empty">
        <p className="loki-phone-headline">No goals yet</p>
        <p>Set your short, medium, and long term goals with an agent or add one here.</p>
        <div className="grid gap-2" style={{ marginTop: 12 }}>
          <Button size="touch" tone="positive" block onClick={onDiscover} disabled={agentsCount === 0}>
            Discover Goals
          </Button>
          <Button size="touch" tone="paper" block onClick={onAdd}>
            Add a Goal
          </Button>
        </div>
      </div>
    );
  }
  return (
    <>
      {suggested.length > 0 && (
        <RowGroup title="Suggested">
          {suggested.map((g) => (
            <li key={g.id} className="loki-phone-row-item">
              <button type="button" className="loki-phone-row" onClick={() => onSelect(g.id)}>
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
                  <button type="button" className="loki-phone-row" onClick={() => onSelect(g.id)}>
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
      {agentsCount > 0 && (
        <div style={{ padding: "8px 16px 24px" }}>
          <Button size="touch" tone="paper" block onClick={onDiscover}>
            Discover Goals
          </Button>
        </div>
      )}
    </>
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
  const health = goalHealth(goal, now);
  const week = goal.lead_habit ? weeklyHabitProgress(goal.lead_habit, new Date(now), timezone) : null;

  return (
    <div className="loki-phone-page">
      <TopBar left={back} title={goal.title} sub={`${HORIZON_LABEL[goal.horizon]} · ${health.label}`} banner={banner} />
      <Scroll>
        <div className="grid gap-4" style={{ padding: "12px 16px 24px" }}>
          <Button size="touch" tone="positive" block onClick={goal.status === "suggested" ? onAdopt : onWork}>
            {goal.status === "suggested" ? "Adopt Goal" : "Work on This"}
          </Button>
          <PhoneGoalNotes goal={goal} />
          {goal.lead_habit && week && <PhoneGoalHabit label={goal.lead_habit.label} week={week} onToggleHabit={onToggleHabit} />}
          <PhoneGoalProgress onLogProgress={onLogProgress} />
          <PhoneGoalEntries entries={goal.entries} now={now} />
          <PhoneGoalFooter status={goal.status} onAchieve={onAchieve} onDelete={onDelete} />
        </div>
      </Scroll>
    </div>
  );
}

function PhoneGoalNotes({ goal }: { goal: Goal }) {
  if (!goal.why && !goal.next_step && !goal.obstacle) return null;
  return (
    <div className="grid gap-2">
      {goal.why && <p className="loki-phone-body">{goal.why}</p>}
      {goal.next_step && <p className="loki-phone-meta">{`Next: ${goal.next_step}`}</p>}
      {goal.obstacle && <p className="loki-phone-meta">{`Obstacle: ${goal.obstacle}${goal.fallback_plan ? ` -> ${goal.fallback_plan}` : ""}`}</p>}
    </div>
  );
}

function PhoneGoalHabit({
  label,
  week,
  onToggleHabit,
}: {
  label: string;
  week: ReturnType<typeof weeklyHabitProgress>;
  onToggleHabit: (day: string, done: boolean) => void;
}) {
  return (
    <div className="grid gap-2">
      <div className="loki-phone-meta">{`${label} (${week.done}/${week.target} this week)`}</div>
      <div className="flex flex-wrap gap-2">
        {week.days.map((d) => (
          <Chip key={d.day} touch active={d.done} onClick={() => onToggleHabit(d.day, !d.done)}>
            {d.label}
          </Chip>
        ))}
      </div>
    </div>
  );
}

function PhoneGoalProgress({ onLogProgress }: { onLogProgress: (note: string) => Promise<boolean> }) {
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const clean = note.trim();
    if (!clean || saving) return;
    setSaving(true);
    try {
      if (await onLogProgress(clean)) setNote("");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-2">
      <Field
        size="touch"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Log progress note"
        onKeyDown={(e) => e.key === "Enter" && void submit()}
      />
      <Button size="touch" tone="paper" block onClick={() => void submit()} disabled={saving || !note.trim()}>
        {saving ? "Logging…" : "Log Progress"}
      </Button>
    </div>
  );
}

function PhoneGoalEntries({ entries, now }: { entries: Goal["entries"]; now: number }) {
  if (entries.length === 0) return null;
  return (
    <div className="grid gap-2">
      {[...entries].reverse().map((e) => (
        <div key={e.id} className="grid gap-1">
          <div className="loki-phone-body">{e.note}</div>
          <div className="loki-phone-meta">{ago(e.at, now)}</div>
        </div>
      ))}
    </div>
  );
}

function PhoneGoalFooter({ status, onAchieve, onDelete }: { status: Goal["status"]; onAchieve: () => void; onDelete: () => void }) {
  return (
    <div className="flex gap-2">
      {status !== "achieved" && status !== "suggested" && (
        <Button size="touch" tone="paper" className="flex-1" onClick={onAchieve}>
          Mark Achieved
        </Button>
      )}
      <Button size="touch" tone="negative" className="flex-1" onClick={onDelete}>
        {status === "suggested" ? "Dismiss" : "Delete"}
      </Button>
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
    try {
      const ok = await onCreate({
        title: title.trim(),
        horizon,
        why: why.trim() || null,
        next_step: nextStep.trim() || null,
      });
      if (ok) onClose();
    } finally {
      setBusy(false);
    }
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

function PhoneDiscoverGoalSheet({
  agents,
  initialAgentId,
  onStart,
  onClose,
}: {
  agents: ReadonlyArray<{ id: string; name: string }>;
  initialAgentId: string | null;
  onStart: (agentId: string) => Promise<void>;
  onClose: () => void;
}) {
  const fallbackAgent = agents.length > 0 ? agents[0].id : "";
  const [picked, setPicked] = useState(initialAgentId ?? fallbackAgent);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy || !picked) return;
    setBusy(true);
    try {
      await onStart(picked);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet label="Discover goals" onClose={onClose} placement="bottom" className="loki-phone-sheet">
      <div className="loki-phone-sheet-copy">
        <div className="loki-phone-title">Discover goals</div>
        <p className="loki-phone-meta">Choose which agent to map your goals with.</p>
      </div>
      <div className="loki-phone-chips">
        {agents.map((a) => (
          <Chip key={a.id} touch active={picked === a.id} onClick={() => setPicked(a.id)}>
            {a.name}
          </Chip>
        ))}
      </div>
      <div className="loki-phone-sheet-actions">
        <Button size="touch" tone="paper" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button size="touch" tone="positive" onClick={() => void submit()} disabled={busy || !picked}>
          {busy ? "Starting…" : "Start Discovery"}
        </Button>
      </div>
    </Sheet>
  );
}
