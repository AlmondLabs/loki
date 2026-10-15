import { useMemo } from "react";
import { IconButton, ListIcon, ListRow, ListSection } from "../components";
import { Icon, type IconName } from "../shared/icons";
import { ColumnHeader } from "../shell/ListColumn";
import { AgentFace } from "../desk/AgentChip";
import { resolveTaskView, taskViews, type TaskViewId } from "./model";
import { useTaskView } from "./useTaskView";
import { keyFor } from "../shell/keymap";
import type { Task } from "../../../core/frame-types.ts";

const VIEW_ICON: Record<string, IconName> = { all: "menu", mine: "check", waiting: "clock" };

/**
 * The Tasks list column: the built-in views (All, Mine, Waiting for you, each agent with tasks), each with the number
 * of tasks it shows. Choosing one sets the pane's view (shared through useTaskView).
 */
export function TasksColumn({ tasks, onNew }: { tasks: Task[] | null; onNew: () => void }) {
  const [stored, setView] = useTaskView();
  const { views, agents } = useMemo(() => taskViews(tasks ?? []), [tasks]);
  // A missing agent's view marks no row: the pane asks for a new pick.
  const { view } = useMemo(() => resolveTaskView(stored, tasks), [stored, tasks]);
  const row = (v: { view: TaskViewId; label: string; count: number }, lead: React.ReactNode) => (
    <ListRow
      key={v.view}
      lead={lead}
      title={v.label}
      time={tasks === null ? null : String(v.count)}
      current={view === v.view}
      label={`${v.label}, ${v.count} task${v.count === 1 ? "" : "s"}`}
      onOpen={() => setView(v.view)}
    />
  );
  return (
    <>
      <ColumnHeader
        title="Tasks"
        actions={
          <IconButton label={`New task (${keyFor("task.new")})`} onClick={onNew}>
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
