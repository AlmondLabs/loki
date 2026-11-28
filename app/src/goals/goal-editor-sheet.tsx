import { useState, type ReactNode } from "react";
import {
  CADENCE_LABEL,
  GOAL_CADENCES,
  GOAL_HORIZONS,
  HORIZON_LABEL,
  defaultCadenceFor,
  type Goal,
  type GoalCadence,
  type GoalHorizon,
} from "../../../core/goals.ts";
import type { InputOf } from "../../../core/frames.ts";
import { Button, Field, Meta, Sheet, TextArea } from "../components";
import { PopUp } from "../settings/layout";

export function GoalEditorSheet({
  goal,
  initialHorizon = "short",
  goals,
  agents,
  onSave,
  onClose,
}: {
  goal: Goal | null;
  initialHorizon?: GoalHorizon;
  goals: readonly Goal[];
  agents: ReadonlyArray<{ id: string; name: string }>;
  onSave: (payload: InputOf<"goals_create"> | InputOf<"goals_update">) => Promise<boolean>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(goal?.title ?? "");
  const [horizon, setHorizon] = useState<GoalHorizon>(goal?.horizon ?? initialHorizon);
  const [why, setWhy] = useState(goal?.why ?? "");
  const [nextStep, setNextStep] = useState(goal?.next_step ?? "");
  const [obstacle, setObstacle] = useState(goal?.obstacle ?? "");
  const [fallbackPlan, setFallbackPlan] = useState(goal?.fallback_plan ?? "");
  const [targetDate, setTargetDate] = useState(goal?.target_date ?? "");
  const [cadence, setCadence] = useState<GoalCadence>(goal?.cadence ?? defaultCadenceFor(goal?.horizon ?? initialHorizon));
  const [agentId, setAgentId] = useState(goal?.agent_id ?? "");
  const [parentId, setParentId] = useState(goal?.parent_id ?? "");
  const [habitLabel, setHabitLabel] = useState(goal?.lead_habit?.label ?? "");
  const [habitPerWeek, setHabitPerWeek] = useState(String(goal?.lead_habit?.per_week ?? 3));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parentChoices = goals.filter((g) => g.id !== goal?.id && (g.status === "active" || g.status === "paused"));
  const parentLabels: Record<string, string> = { "": "None" };
  for (const p of parentChoices) parentLabels[p.id] = `${HORIZON_LABEL[p.horizon]} · ${p.title}`;

  const agentLabels: Record<string, string> = { "": "Any agent" };
  for (const a of agents) agentLabels[a.id] = a.name;

  const pickHorizon = (next: GoalHorizon) => {
    setHorizon(next);
    if (!goal) setCadence(defaultCadenceFor(next));
  };

  const submit = async () => {
    if (busy || !title.trim()) return;
    if (targetDate.trim() && !/^\d{4}-\d{2}-\d{2}$/.test(targetDate.trim())) {
      setError("Target date must be YYYY-MM-DD.");
      return;
    }
    setBusy(true);
    setError(null);
    const parsedPerWeek = Math.max(1, Math.min(7, Math.round(Number(habitPerWeek) || 3)));
    const leadHabit = habitLabel.trim() ? { label: habitLabel.trim(), per_week: parsedPerWeek } : null;
    const base = {
      title: title.trim(),
      horizon,
      why: why.trim() || null,
      next_step: nextStep.trim() || null,
      obstacle: obstacle.trim() || null,
      fallback_plan: fallbackPlan.trim() || null,
      target_date: targetDate.trim() || null,
      cadence,
      agent_id: agentId || null,
      parent_id: parentId || null,
      lead_habit: leadHabit,
    };
    const ok = await onSave(goal ? { id: goal.id, ...base } : base);
    setBusy(false);
    if (ok) onClose();
    else setError("Could not save goal.");
  };

  return (
    <Sheet label={goal ? "Edit goal" : "New goal"} onClose={onClose} width={540} top="8vh" scroll>
      <div
        className="grid gap-4"
        style={{ padding: 20 }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLElement).tagName !== "TEXTAREA" && void submit()}
      >
        <div style={{ fontSize: "var(--text-base)", fontWeight: 700, color: "var(--loki-fg)" }}>{goal ? "Edit goal" : "New goal"}</div>

        <div className="grid gap-3">
          <FormField label="Goal">
            <Field
              size="sm"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Ship v1 to first 10 users"
              autoComplete="off"
              data-1p-ignore
              data-form-type="other"
            />
          </FormField>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1">
              <span className="loki-label">Horizon</span>
              <PopUp label="Horizon" options={GOAL_HORIZONS} value={horizon} onPick={pickHorizon} labels={HORIZON_LABEL} />
            </div>
            <div className="grid gap-1">
              <span className="loki-label">Check-in cadence</span>
              <PopUp label="Check-in cadence" options={GOAL_CADENCES} value={cadence} onPick={setCadence} labels={CADENCE_LABEL} />
            </div>
          </div>

          <FormField label="Outcome (what done looks like)">
            <TextArea size="sm" rows={2} value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Why this matters and how you will know it is done" />
          </FormField>

          <FormField label="Next concrete step">
            <Field
              size="sm"
              value={nextStep}
              onChange={(e) => setNextStep(e.target.value)}
              placeholder="The smallest first step to take next"
              autoComplete="off"
            />
          </FormField>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Likely obstacle (WOOP)">
              <Field size="sm" value={obstacle} onChange={(e) => setObstacle(e.target.value)} placeholder="Urgent messages steal mornings" autoComplete="off" />
            </FormField>
            <FormField label="If-then fallback plan">
              <Field
                size="sm"
                value={fallbackPlan}
                onChange={(e) => setFallbackPlan(e.target.value)}
                placeholder="If interrupted, block 45 min at 2 PM"
                autoComplete="off"
              />
            </FormField>
          </div>

          <div className="grid grid-cols-[1fr_96px] gap-3">
            <FormField label="Weekly lead habit (optional)">
              <Field
                size="sm"
                value={habitLabel}
                onChange={(e) => setHabitLabel(e.target.value)}
                placeholder="Deep-work block on core build"
                autoComplete="off"
              />
            </FormField>
            <FormField label="Times / week">
              <Field size="sm" type="number" min={1} max={7} value={habitPerWeek} onChange={(e) => setHabitPerWeek(e.target.value)} />
            </FormField>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <FormField label="Target date">
              <Field size="sm" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} placeholder="YYYY-MM-DD" autoComplete="off" />
            </FormField>
            <div className="grid gap-1">
              <span className="loki-label">Owner agent</span>
              <PopUp label="Owner agent" options={["", ...agents.map((a) => a.id)]} value={agentId} onPick={setAgentId} labels={agentLabels} />
            </div>
            <div className="grid gap-1">
              <span className="loki-label">Supports goal</span>
              <PopUp label="Supports goal" options={["", ...parentChoices.map((p) => p.id)]} value={parentId} onPick={setParentId} labels={parentLabels} />
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2" style={{ paddingTop: 4 }}>
          {error && (
            <Meta role="alert" negative wrap>
              {error}
            </Meta>
          )}
          <span className="flex-1" />
          <Button size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" tone="positive" onClick={() => void submit()} disabled={busy || !title.trim()}>
            {busy ? "Saving…" : goal ? "Save Goal" : "Add Goal"}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

function FormField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1">
      <span className="loki-label">{label}</span>
      {children}
    </label>
  );
}
