import { useMemo } from "react";
import { IconButton, ListIcon, ListRow, ListSection } from "../components";
import { Icon, type IconName } from "../shared/icons";
import { ColumnHeader } from "../shell/ListColumn";
import { AgentFace } from "../desk/AgentChip";
import { boardViews, type BoardView, type Task } from "./model";
import { useBoardView } from "./useBoardView";

const VIEW_ICON: Record<string, IconName> = { all: "menu", open: "inbox", in_progress: "clock", blocked: "info", done: "check" };

/**
 * The Board's list column (plan 013 U11): its views — all tasks, each status, each agent with tasks — each
 * with the number of tasks it shows. Choosing one sets the pane's view (shared through useBoardView).
 */
export function BoardColumn({ tasks, onNew }: { tasks: Task[] | null; onNew: () => void }) {
  const [view, setView] = useBoardView();
  const { views, agents } = useMemo(() => boardViews(tasks ?? []), [tasks]);
  const row = (v: { view: BoardView; label: string; count: number }, lead: React.ReactNode) => (
    <ListRow key={v.view} lead={lead} title={v.label} time={tasks === null ? null : String(v.count)} current={view === v.view} label={`${v.label}, ${v.count} task${v.count === 1 ? "" : "s"}`} onOpen={() => setView(v.view)} />
  );
  return (
    <>
      <ColumnHeader
        title="Board"
        actions={
          <IconButton label="New task (⌘T)" onClick={onNew}>
            <Icon name="plus" size={16} />
          </IconButton>
        }
      />
      <div className="loki-column-scroll">
        <ListSection title="Views">{views.map((v) => row(v, <ListIcon name={VIEW_ICON[v.view]} />))}</ListSection>
        {agents.length > 0 && <ListSection title="By agent">{agents.map((v) => row(v, <AgentFace name={v.label} src={null} size={20} />))}</ListSection>}
      </div>
    </>
  );
}
