import { ListIcon, ListRow, ListSection } from "../components";
import type { IconName } from "../shared/icons";
import { ColumnHeader } from "../shell/ListColumn";
import type { Recall as RecallModel } from "../shell/useRecall";
import { useLearnView } from "./useLearnView";
import { learnViews, type LearnView } from "./views";

const VIEW_ICON: Record<LearnView, IconName> = { review: "learn", leads: "link", all: "file", deleted: "archive" };

/**
 * Learn's list column (plan 013 U11): the four views that were tabs, each with its count. Cards due for
 * review wear the red badge, as on the rail; the rest are quiet counts. Choosing one sets the pane's view.
 */
export function LearnColumn({ recall }: { recall: RecallModel }) {
  const [view, setView] = useLearnView();
  const loaded = !!recall.snap;
  return (
    <>
      <ColumnHeader title="Learn" />
      <div className="loki-column-scroll">
        <ListSection title="Views">
          {learnViews(recall.snap, recall.due).map((v) => (
            <ListRow
              key={v.view}
              lead={<ListIcon name={VIEW_ICON[v.view]} />}
              title={v.label}
              badge={v.view === "review" ? v.count : null}
              badgeNoun="due"
              time={loaded && v.view !== "review" ? String(v.count) : null}
              current={view === v.view}
              onOpen={() => setView(v.view)}
            />
          ))}
        </ListSection>
      </div>
    </>
  );
}
