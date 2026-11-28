import { useRef, useState } from "react";
import { SHORT_TERM_WIP_LIMIT, goalHealth, type Goal } from "../../../core/goals.ts";
import { Button, EmptyPane, Meta, PaneHeader } from "../components";
import { useNow } from "../components/use-now";
import { ContentList, NothingSelected, type ContentRow } from "../shell/content-list";
import { PlaceColumns } from "../shell/place-columns";
import type { GoalsModel } from "../shell/use-goals";
import { GoalDetail } from "./goal-detail";
import { GoalEditorSheet } from "./goal-editor-sheet";
import "./goals.css";
import { GOALS_VIEW_LABEL, defaultHorizonForView, filterGoalsForView, goalSectionLabel, type GoalsView } from "./views";

export function Goals({
  goals,
  view,
  onView,
  selectedId,
  onSelect,
  agents,
  editingNew,
  onCloseNew,
  onOpenNew,
  onOpenChat,
}: {
  goals: GoalsModel;
  view: GoalsView;
  onView: (view: GoalsView) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  agents: ReadonlyArray<{ id: string; name: string }>;
  editingNew: boolean;
  onCloseNew: () => void;
  onOpenNew: () => void;
  onOpenChat: (agentId: string, conversationId: string, brief?: string | null) => void;
}) {
  const now = useNow();
  const [query, setQuery] = useState("");
  const [editingGoal, setEditingGoal] = useState<Goal | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  const snap = goals.snap;
  const allGoals = snap?.goals ?? [];
  const visible = filterGoalsForView(allGoals, view, query);
  const resolvedSelected: Goal | null = visible.find((g) => g.id === selectedId) ?? (visible.length > 0 ? visible[0] : null);

  const shortActiveCount = allGoals.filter((g) => g.status === "active" && g.horizon === "short").length;
  const rows: ContentRow[] = visible.map((g) => {
    const health = goalHealth(g, now);
    return {
      id: g.id,
      section: goalSectionLabel(g, view),
      title: g.title,
      preview: g.next_step ?? g.progress ?? g.why ?? health.label,
      time: health.label,
      unread: g.status === "suggested" || health.state === "quiet" || health.state === "at_risk",
    };
  });

  const wipLine =
    (view === "active" || view === "short") && shortActiveCount > SHORT_TERM_WIP_LIMIT
      ? `${shortActiveCount} short-term goals active — aim for ${SHORT_TERM_WIP_LIMIT} or fewer in focus`
      : undefined;

  const listColumn = (
    <ContentList
      key={view}
      label={GOALS_VIEW_LABEL[view]}
      title={GOALS_VIEW_LABEL[view]}
      count={rows.length || null}
      line={wipLine}
      rows={rows}
      selectedId={resolvedSelected?.id ?? null}
      onSelect={(id) => onSelect(id)}
      onEnter={() => detailRef.current?.focus()}
      newAction={{ label: "New Goal", run: onOpenNew }}
      query={query}
      onQuery={setQuery}
      divided
      empty={snap ? emptyMessageFor(view) : "Loading…"}
    />
  );

  const partnerName = (snap?.settings.partner_agent_id && agents.find((a) => a.id === snap.settings.partner_agent_id)?.name) || agents[0]?.name || "your agent";

  const firstAgentId = agents.length > 0 ? agents[0].id : null;
  const handleDiscover = async () => {
    const started = await goals.startDiscover(snap?.settings.partner_agent_id ?? firstAgentId);
    if (started) onOpenChat(started.agent_id, started.conversation_id, started.brief);
  };

  const handleWork = async (goalId: string) => {
    const started = await goals.startWork(goalId);
    if (started) onOpenChat(started.agent_id, started.conversation_id, started.brief);
  };

  const detail = (
    <div ref={detailRef} tabIndex={-1} className="loki-goals-detail" onPointerDown={(e) => e.stopPropagation()}>
      {allGoals.length === 0 && snap ? (
        <>
          <PaneHeader title="Goals" />
          <EmptyPane icon="target" title="Set your direction">
            <p className="loki-meta loki-meta--wrap">
              Share your short, medium, and long term goals in a quick conversation with {partnerName}, or add one directly. Every agent will keep them in mind
              and prepare next steps in Flow.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button size="md" tone="positive" onClick={() => void handleDiscover()}>
                {`Discover Goals with ${partnerName}`}
              </Button>
              <Button size="md" onClick={onOpenNew}>
                Add a Goal
              </Button>
            </div>
          </EmptyPane>
        </>
      ) : resolvedSelected ? (
        <GoalDetail
          goal={resolvedSelected}
          goals={allGoals}
          agents={agents}
          timezone={snap?.settings.timezone ?? null}
          onWork={() => void handleWork(resolvedSelected.id)}
          onEdit={() => setEditingGoal(resolvedSelected)}
          onToggleStatus={(status) => void goals.update({ id: resolvedSelected.id, status })}
          onAdopt={() => void goals.update({ id: resolvedSelected.id, status: "active" })}
          onDelete={() => void goals.remove(resolvedSelected.id)}
          onLogProgress={(note) => goals.addProgress(resolvedSelected.id, note)}
          onToggleHabit={(day, done) => void goals.toggleHabit(resolvedSelected.id, day, done)}
          onSelectGoal={(id) => {
            onView("active");
            onSelect(id);
          }}
          onOpenChat={(agentId, conversationId) => onOpenChat(agentId, conversationId, null)}
        />
      ) : (
        <>
          <PaneHeader
            title={GOALS_VIEW_LABEL[view]}
            actions={
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => void goals.runPulse({ kind: "daily" })} disabled={goals.running}>
                  {goals.running ? "Checking In…" : "Check In Now"}
                </Button>
                <Button size="sm" tone="positive" onClick={onOpenNew}>
                  New Goal
                </Button>
              </div>
            }
          />
          <div className="flex-1" style={{ position: "relative" }}>
            <NothingSelected noun="Goal" />
          </div>
        </>
      )}

      {goals.error && (
        <div style={{ padding: "8px 20px" }}>
          <Meta negative wrap>
            {goals.error}
          </Meta>
        </div>
      )}

      {(editingNew || editingGoal) && (
        <GoalEditorSheet
          goal={editingGoal}
          initialHorizon={defaultHorizonForView(view)}
          goals={allGoals}
          agents={agents}
          onSave={(payload) => ("id" in payload ? goals.update(payload) : goals.create(payload))}
          onClose={() => {
            setEditingGoal(null);
            onCloseNew();
          }}
        />
      )}
    </div>
  );

  return <PlaceColumns list={listColumn} detail={detail} />;
}

function emptyMessageFor(view: GoalsView): string {
  switch (view) {
    case "active":
      return "No active goals yet.";
    case "short":
      return "No active short-term goals.";
    case "medium":
      return "No active medium-term goals.";
    case "long":
      return "No active long-term goals.";
    case "suggested":
      return "No suggested goals right now.";
    case "achieved":
      return "No achieved, paused, or dropped goals.";
  }
}
