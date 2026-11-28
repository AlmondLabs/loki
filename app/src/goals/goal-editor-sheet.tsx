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

function buildOptionLabels(
  goals: readonly Goal[],
  agents: ReadonlyArray<{ id: string; name: string }>,
  currentId: string | undefined,
): { parentChoices: Goal[]; parentLabels: Record<string, string>; agentLabels: Record<string, string> } {
  const parentChoices = goals.filter((g) => g.id !== currentId && (g.status === "active" || g.status === "paused"));
  const parentLabels: Record<string, string> = { "": "None" };
  for (const p of parentChoices) parentLabels[p.id] = `${HORIZON_LABEL[p.horizon]} · ${p.title}`;
  const agentLabels: Record<string, string> = { "": "Any agent" };
  for (const a of agents) agentLabels[a.id] = a.name;
  return { parentChoices, parentLabels, agentLabels };
}

function buildGoalPayload(fields: {
  title: string;
  horizon: GoalHorizon;
  why: string;
  nextStep: string;
  obstacle: string;
  fallbackPlan: string;
  targetDate: string;
  cadence: GoalCadence;
  agentId: string;
  parentId: string;
  habitLabel: string;
  habitPerWeek: string;
}): InputOf<"goals_create"> {
  const parsedPerWeek = Math.max(1, Math.min(7, Math.round(Number(fields.habitPerWeek) || 3)));
  const leadHabit = fields.habitLabel.trim() ? { label: fields.habitLabel.trim(), per_week: parsedPerWeek } : null;
  return {
    title: fields.title.trim(),
    horizon: fields.horizon,
    why: fields.why.trim() || null,
    next_step: fields.nextStep.trim() || null,
    obstacle: fields.obstacle.trim() || null,
    fallback_plan: fields.fallbackPlan.trim() || null,
    target_date: fields.targetDate.trim() || null,
    cadence: fields.cadence,
    agent_id: fields.agentId || null,
    parent_id: fields.parentId || null,
    lead_habit: leadHabit,
  };
}

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
  const startHorizon = goal?.horizon ?? initialHorizon;
  const [title, setTitle] = useState(goal?.title ?? "");
  const [horizon, setHorizon] = useState<GoalHorizon>(startHorizon);
  const [why, setWhy] = useState(goal?.why ?? "");
  const [nextStep, setNextStep] = useState(goal?.next_step ?? "");
  const [obstacle, setObstacle] = useState(goal?.obstacle ?? "");
  const [fallbackPlan, setFallbackPlan] = useState(goal?.fallback_plan ?? "");
  const [targetDate, setTargetDate] = useState(goal?.target_date ?? "");
  const [cadence, setCadence] = useState<GoalCadence>(goal?.cadence ?? defaultCadenceFor(startHorizon));
  const [agentId, setAgentId] = useState(goal?.agent_id ?? "");
  const [parentId, setParentId] = useState(goal?.parent_id ?? "");
  const [habitLabel, setHabitLabel] = useState(goal?.lead_habit?.label ?? "");
  const [habitPerWeek, setHabitPerWeek] = useState(String(goal?.lead_habit?.per_week ?? 3));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { parentChoices, parentLabels, agentLabels } = buildOptionLabels(goals, agents, goal?.id);
  const sheetTitle = goal ? "Edit goal" : "New goal";

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
    const base = buildGoalPayload({
      title,
      horizon,
      why,
      nextStep,
      obstacle,
      fallbackPlan,
      targetDate,
      cadence,
      agentId,
      parentId,
      habitLabel,
      habitPerWeek,
    });
    try {
      const ok = await onSave(goal ? { id: goal.id, ...base } : base);
      if (ok) onClose();
      else setError("Could not save goal.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet label={sheetTitle} onClose={onClose} width={540} top="8vh" scroll>
      <div
        className="grid gap-4"
        style={{ padding: 20 }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLElement).tagName !== "TEXTAREA" && void submit()}
      >
        <div style={{ fontSize: "var(--text-base)", fontWeight: 700, color: "var(--loki-fg)" }}>{sheetTitle}</div>

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

          <GoalPlanFields
            why={why}
            nextStep={nextStep}
            obstacle={obstacle}
            fallbackPlan={fallbackPlan}
            onWhy={setWhy}
            onNextStep={setNextStep}
            onObstacle={setObstacle}
            onFallbackPlan={setFallbackPlan}
          />

          <GoalAlignmentFields
            habitLabel={habitLabel}
            habitPerWeek={habitPerWeek}
            targetDate={targetDate}
            agentId={agentId}
            parentId={parentId}
            agents={agents}
            parentChoices={parentChoices}
            agentLabels={agentLabels}
            parentLabels={parentLabels}
            onHabitLabel={setHabitLabel}
            onHabitPerWeek={setHabitPerWeek}
            onTargetDate={setTargetDate}
            onAgentId={setAgentId}
            onParentId={setParentId}
          />
        </div>

        <GoalEditorFooter error={error} busy={busy} canSubmit={Boolean(title.trim())} isEdit={Boolean(goal)} onClose={onClose} onSubmit={() => void submit()} />
      </div>
    </Sheet>
  );
}

function GoalPlanFields({
  why,
  nextStep,
  obstacle,
  fallbackPlan,
  onWhy,
  onNextStep,
  onObstacle,
  onFallbackPlan,
}: {
  why: string;
  nextStep: string;
  obstacle: string;
  fallbackPlan: string;
  onWhy: (v: string) => void;
  onNextStep: (v: string) => void;
  onObstacle: (v: string) => void;
  onFallbackPlan: (v: string) => void;
}) {
  return (
    <>
      <FormField label="Outcome (what done looks like)">
        <TextArea size="sm" rows={2} value={why} onChange={(e) => onWhy(e.target.value)} placeholder="Why this matters and how you will know it is done" />
      </FormField>

      <FormField label="Next concrete step">
        <Field size="sm" value={nextStep} onChange={(e) => onNextStep(e.target.value)} placeholder="The smallest first step to take next" autoComplete="off" />
      </FormField>

      <div className="grid grid-cols-2 gap-3">
        <FormField label="Likely obstacle (WOOP)">
          <Field size="sm" value={obstacle} onChange={(e) => onObstacle(e.target.value)} placeholder="Urgent messages steal mornings" autoComplete="off" />
        </FormField>
        <FormField label="If-then fallback plan">
          <Field
            size="sm"
            value={fallbackPlan}
            onChange={(e) => onFallbackPlan(e.target.value)}
            placeholder="If interrupted, block 45 min at 2 PM"
            autoComplete="off"
          />
        </FormField>
      </div>
    </>
  );
}

function GoalAlignmentFields({
  habitLabel,
  habitPerWeek,
  targetDate,
  agentId,
  parentId,
  agents,
  parentChoices,
  agentLabels,
  parentLabels,
  onHabitLabel,
  onHabitPerWeek,
  onTargetDate,
  onAgentId,
  onParentId,
}: {
  habitLabel: string;
  habitPerWeek: string;
  targetDate: string;
  agentId: string;
  parentId: string;
  agents: ReadonlyArray<{ id: string; name: string }>;
  parentChoices: readonly Goal[];
  agentLabels: Record<string, string>;
  parentLabels: Record<string, string>;
  onHabitLabel: (v: string) => void;
  onHabitPerWeek: (v: string) => void;
  onTargetDate: (v: string) => void;
  onAgentId: (v: string) => void;
  onParentId: (v: string) => void;
}) {
  return (
    <>
      <div className="grid grid-cols-[1fr_96px] gap-3">
        <FormField label="Weekly lead habit (optional)">
          <Field size="sm" value={habitLabel} onChange={(e) => onHabitLabel(e.target.value)} placeholder="Deep-work block on core build" autoComplete="off" />
        </FormField>
        <FormField label="Times / week">
          <Field size="sm" type="number" min={1} max={7} value={habitPerWeek} onChange={(e) => onHabitPerWeek(e.target.value)} />
        </FormField>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <FormField label="Target date">
          <Field size="sm" value={targetDate} onChange={(e) => onTargetDate(e.target.value)} placeholder="YYYY-MM-DD" autoComplete="off" />
        </FormField>
        <div className="grid gap-1">
          <span className="loki-label">Owner agent</span>
          <PopUp label="Owner agent" options={["", ...agents.map((a) => a.id)]} value={agentId} onPick={onAgentId} labels={agentLabels} />
        </div>
        <div className="grid gap-1">
          <span className="loki-label">Supports goal</span>
          <PopUp label="Supports goal" options={["", ...parentChoices.map((p) => p.id)]} value={parentId} onPick={onParentId} labels={parentLabels} />
        </div>
      </div>
    </>
  );
}

function GoalEditorFooter({
  error,
  busy,
  canSubmit,
  isEdit,
  onClose,
  onSubmit,
}: {
  error: string | null;
  busy: boolean;
  canSubmit: boolean;
  isEdit: boolean;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
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
      <Button size="sm" tone="positive" onClick={onSubmit} disabled={busy || !canSubmit}>
        {busy ? "Saving…" : isEdit ? "Save Goal" : "Add Goal"}
      </Button>
    </div>
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
