import { CheckIcon, MessageSquareIcon, PauseIcon, PencilIcon, PlayIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { CADENCE_LABEL, HORIZON_LABEL, STATUS_LABEL, goalHealth, weeklyHabitProgress, type Goal } from "../../../core/goals.ts";
import { Button, Chip, Field, Meta } from "../components";
import { useNow } from "../components/use-now";
import { ToolbarGroup, ToolbarTitle, type ToolbarMove } from "../item/toolbar";
import type { ItemProperty } from "../item/item-view";
import { ago } from "../shared/ago";
import { Glyph } from "../shared/icons";
import { goalHealthTone } from "./views";

const TONE_COLOR = {
  positive: "var(--loki-positive)",
  negative: "var(--loki-negative)",
  brass: "var(--loki-accent)",
  muted: "var(--loki-muted)",
} as const;

function goalFacts(goal: Goal, health: ReturnType<typeof goalHealth>, owner: string | null): ItemProperty[] {
  return [
    { key: "status", label: HORIZON_LABEL[goal.horizon], editable: false },
    {
      key: "status",
      label: health.label,
      editable: false,
      ...(health.state === "quiet" || health.state === "at_risk" ? { tone: "attention" as const } : {}),
    },
    { key: "status", label: `Cadence ${CADENCE_LABEL[goal.cadence].toLowerCase()}`, editable: false },
    ...(owner ? [{ key: "status" as const, label: owner, editable: false }] : []),
    ...(goal.target_date ? [{ key: "status" as const, label: `Target ${goal.target_date}`, editable: false }] : []),
  ];
}

function goalMoves(
  goal: Goal,
  actions: {
    onWork: () => void;
    onEdit: () => void;
    onToggleStatus: (status: Goal["status"]) => void;
    onAdopt: () => void;
    onDelete: () => void;
  },
): ToolbarMove[] {
  const primaryMove: ToolbarMove =
    goal.status === "suggested"
      ? { label: "Adopt", icon: <Glyph icon={CheckIcon} size={16} />, run: actions.onAdopt, prominent: true }
      : { label: "Work on This", icon: <Glyph icon={MessageSquareIcon} size={16} />, run: actions.onWork, prominent: true };
  const statusMove: ToolbarMove =
    goal.status === "achieved"
      ? { label: "Reopen", icon: <Glyph icon={PlayIcon} size={16} />, run: () => actions.onToggleStatus("active") }
      : goal.status === "paused"
        ? { label: "Resume", icon: <Glyph icon={PlayIcon} size={16} />, run: () => actions.onToggleStatus("active") }
        : { label: "Pause", icon: <Glyph icon={PauseIcon} size={16} />, run: () => actions.onToggleStatus("paused") };

  return [
    primaryMove,
    { label: "Edit", icon: <Glyph icon={PencilIcon} size={16} />, run: actions.onEdit },
    statusMove,
    ...(goal.status !== "achieved" && goal.status !== "suggested"
      ? [{ label: "Mark Achieved", icon: <Glyph icon={CheckIcon} size={16} />, run: () => actions.onToggleStatus("achieved") }]
      : []),
    { label: "Delete", icon: <Glyph icon={Trash2Icon} size={16} />, run: actions.onDelete },
  ];
}

export function GoalDetail({
  goal,
  goals,
  agents,
  timezone,
  onWork,
  onEdit,
  onToggleStatus,
  onAdopt,
  onDelete,
  onLogProgress,
  onToggleHabit,
  onSelectGoal,
  onOpenChat,
}: {
  goal: Goal;
  goals: readonly Goal[];
  agents: ReadonlyArray<{ id: string; name: string }>;
  timezone: string | null;
  onWork: () => void;
  onEdit: () => void;
  onToggleStatus: (status: Goal["status"]) => void;
  onAdopt: () => void;
  onDelete: () => void;
  onLogProgress: (note: string) => Promise<boolean>;
  onToggleHabit: (day: string, done: boolean) => void;
  onSelectGoal: (id: string) => void;
  onOpenChat: (agentId: string, conversationId: string) => void;
}) {
  const now = useNow();
  const health = goalHealth(goal, now);
  const tone = goalHealthTone(goal, now);
  const owner = goal.agent_id ? (agents.find((a) => a.id === goal.agent_id)?.name ?? goal.agent_id) : null;
  const parent = goal.parent_id ? (goals.find((g) => g.id === goal.parent_id) ?? null) : null;
  const children = goals.filter((g) => g.parent_id === goal.id);
  const habitWeek = goal.lead_habit ? weeklyHabitProgress(goal.lead_habit, new Date(now), timezone) : null;
  const chatAgentId = goal.agent_id ?? (agents.length > 0 ? agents[0].id : null);

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="loki-pane-header">
        <div className="loki-pane-header-line" data-drag-region="">
          <ToolbarTitle title={goal.title} facts={goalFacts(goal, health, owner)} titleAs="h1" />
        </div>
        <div className="loki-pane-header-trailing">
          <ToolbarGroup label="Goal actions" moves={goalMoves(goal, { onWork, onEdit, onToggleStatus, onAdopt, onDelete })} />
        </div>
      </header>

      <div className="flex-1 min-h-0" style={{ overflowY: "auto", padding: "20px 20px 32px" }}>
        <div className="grid gap-4 loki-goal-detail-column">
          {goal.status === "suggested" && <GoalSuggestedBanner onDelete={onDelete} onAdopt={onAdopt} />}
          <GoalSummaryCard
            goal={goal}
            healthLabel={health.label}
            toneColor={TONE_COLOR[tone]}
            now={now}
            parent={parent}
            chatAgentId={chatAgentId}
            onOpenChat={onOpenChat}
            onSelectGoal={onSelectGoal}
          />
          {goal.lead_habit && habitWeek && <GoalHabitCard label={goal.lead_habit.label} week={habitWeek} onToggleHabit={onToggleHabit} />}
          {children.length > 0 && <GoalChildrenCard items={children} now={now} onSelectGoal={onSelectGoal} />}
          <GoalProgressCard entries={goal.entries} now={now} onLogProgress={onLogProgress} onOpenChat={onOpenChat} />
        </div>
      </div>
    </div>
  );
}

function GoalSuggestedBanner({ onDelete, onAdopt }: { onDelete: () => void; onAdopt: () => void }) {
  return (
    <div className="loki-goal-card flex flex-wrap items-center justify-between gap-3">
      <div className="grid gap-1 min-w-0 flex-1">
        <div className="loki-label">Suggested from your recent conversations</div>
        <Meta wrap>Adopt this candidate to track it and let loki proactively help, or dismiss it if it is not a priority.</Meta>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onDelete}>
          Dismiss
        </Button>
        <Button size="sm" tone="positive" onClick={onAdopt}>
          Adopt Goal
        </Button>
      </div>
    </div>
  );
}

function GoalSummaryCard({
  goal,
  healthLabel,
  toneColor,
  now,
  parent,
  chatAgentId,
  onOpenChat,
  onSelectGoal,
}: {
  goal: Goal;
  healthLabel: string;
  toneColor: string;
  now: number;
  parent: Goal | null;
  chatAgentId: string | null;
  onOpenChat: (agentId: string, conversationId: string) => void;
  onSelectGoal: (id: string) => void;
}) {
  return (
    <div className="loki-goal-card grid gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Chip static tone={toneColor}>
            {healthLabel}
          </Chip>
          <Meta>{STATUS_LABEL[goal.status]}</Meta>
          {goal.last_touched_at && <Meta>{`Last moved ${ago(goal.last_touched_at, now)}`}</Meta>}
        </div>
        {goal.chat_id && chatAgentId && (
          <Button size="sm" bare tone="brass" onClick={() => onOpenChat(chatAgentId, goal.chat_id ?? "")}>
            Open Chat
          </Button>
        )}
      </div>

      {parent && (
        <div className="flex items-center gap-2">
          <Meta>Supports</Meta>
          <Button size="sm" bare tone="brass" onClick={() => onSelectGoal(parent.id)}>
            {parent.title}
          </Button>
        </div>
      )}

      {goal.why && (
        <div className="grid gap-1">
          <span className="loki-label">Outcome</span>
          <p className="loki-goal-body">{goal.why}</p>
        </div>
      )}

      {goal.next_step && (
        <div className="grid gap-1">
          <span className="loki-label">Next step</span>
          <p className="loki-goal-body">{goal.next_step}</p>
        </div>
      )}

      {(goal.obstacle || goal.fallback_plan) && (
        <div className="grid gap-1">
          <span className="loki-label">Obstacle and fallback (WOOP)</span>
          {goal.obstacle && <p className="loki-goal-body">{`Obstacle: ${goal.obstacle}`}</p>}
          {goal.fallback_plan && <p className="loki-goal-body">{`If-then plan: ${goal.fallback_plan}`}</p>}
        </div>
      )}

      {!goal.why && !goal.next_step && !goal.obstacle && <Meta wrap>Add an outcome, next step, or obstacle so loki can prep concrete moves for you.</Meta>}
    </div>
  );
}

function GoalHabitCard({
  label,
  week,
  onToggleHabit,
}: {
  label: string;
  week: ReturnType<typeof weeklyHabitProgress>;
  onToggleHabit: (day: string, done: boolean) => void;
}) {
  return (
    <div className="loki-goal-card grid gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="grid gap-0.5">
          <span className="loki-label">{label}</span>
          <Meta>{`${week.done} of ${week.target} this week`}</Meta>
        </div>
        <Chip static tone={week.done >= week.target ? "var(--loki-positive)" : undefined}>
          {week.done >= week.target ? "Target met" : `${week.target - week.done} left`}
        </Chip>
      </div>
      <div className="flex items-center gap-2">
        {week.days.map((d) => (
          <button
            key={d.day}
            type="button"
            className="loki-goal-habit-day"
            data-done={d.done || undefined}
            data-today={d.today || undefined}
            aria-pressed={d.done}
            aria-label={`${d.day}: ${d.done ? "done" : "not done"}`}
            onClick={() => onToggleHabit(d.day, !d.done)}
          >
            <span>{d.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function GoalChildrenCard({ items, now, onSelectGoal }: { items: readonly Goal[]; now: number; onSelectGoal: (id: string) => void }) {
  return (
    <div className="loki-goal-card grid gap-2">
      <span className="loki-label">Supporting goals</span>
      <div className="grid gap-1">
        {items.map((child) => (
          <button key={child.id} type="button" className="loki-goal-subrow" onClick={() => onSelectGoal(child.id)}>
            <span className="loki-truncate">{child.title}</span>
            <Meta>{goalHealth(child, now).label}</Meta>
          </button>
        ))}
      </div>
    </div>
  );
}

function GoalProgressCard({
  entries,
  now,
  onLogProgress,
  onOpenChat,
}: {
  entries: Goal["entries"];
  now: number;
  onLogProgress: (note: string) => Promise<boolean>;
  onOpenChat: (agentId: string, conversationId: string) => void;
}) {
  const [note, setNote] = useState("");
  const [savingNote, setSavingNote] = useState(false);

  const submitNote = async () => {
    const clean = note.trim();
    if (!clean || savingNote) return;
    setSavingNote(true);
    try {
      const ok = await onLogProgress(clean);
      if (ok) setNote("");
    } finally {
      setSavingNote(false);
    }
  };

  return (
    <div className="loki-goal-card grid gap-3">
      <span className="loki-label">Progress and evidence</span>
      <div className="flex items-center gap-2">
        <Field
          size="sm"
          className="flex-1"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Log a milestone, step completed, or blocker"
          onKeyDown={(e) => e.key === "Enter" && void submitNote()}
        />
        <Button size="sm" tone="positive" onClick={() => void submitNote()} disabled={savingNote || !note.trim()}>
          {savingNote ? "Logging…" : "Log Progress"}
        </Button>
      </div>

      {entries.length === 0 ? (
        <Meta wrap>No evidence logged yet. Reflection and your chats also record progress here automatically.</Meta>
      ) : (
        <ul className="loki-goal-timeline">
          {[...entries].reverse().map((entry) => (
            <li key={entry.id} className="loki-goal-entry">
              <div className="flex items-baseline justify-between gap-2">
                <span className="loki-goal-entry-note">{entry.note}</span>
                <Meta>{ago(entry.at, now)}</Meta>
              </div>
              <div className="flex items-center gap-2">
                <Meta>{entrySourceLabel(entry.source)}</Meta>
                {entry.chat_id && entry.agent_id && (
                  <Button size="sm" bare tone="brass" onClick={() => onOpenChat(entry.agent_id ?? "", entry.chat_id ?? "")}>
                    View Chat
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function entrySourceLabel(source: Goal["entries"][number]["source"]): string {
  switch (source) {
    case "reflection":
      return "Updated by Reflection";
    case "pulse":
      return "Goal check-in";
    case "agent":
      return "Updated in chat";
    case "user":
      return "Logged by you";
  }
}
