import { useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { IconButton, ListIcon, ListRow, ListSection } from "../components";
import { Icon } from "../shared/icons";
import type { AttentionItem } from "../../../core/attention/model.ts";
import type { DeskSummary } from "../desk/useDesk";
import { deskMark, sectionDesks } from "./DeskTree";
import { COLUMN_MAX, COLUMN_MIN } from "./column";
import type { Segment } from "./keymap";
import { SIDEBAR_WIDTH, TITLEBAR_HEIGHT } from "./Sidebar";

/** One arrow press on the resize handle, in px. */
const KEY_STEP = 16;

/**
 * Slack's second column, between the rail and the main pane (plan 013 U3). Each section's body mounts on
 * its first visit and then stays, hidden with `visibility` while another section shows, so its scroll and
 * selection survive switching (the Surface's trick, KTD2). The right edge is a separator: drag it, or
 * focus it and use the arrows (Home / End for the ends); the width is kept when the drag ends.
 */
export function ListColumn({ segment, shown, width, onWidth, sections }: { segment: Segment; shown: boolean; width: number; onWidth: (w: number, commit: boolean) => void; sections: Partial<Record<Segment, ReactNode>> }) {
  // Which bodies have mounted: set during render (the React pattern for state derived from a prop), so the showing one mounts on the same pass.
  const [mounted, setMounted] = useState<ReadonlySet<Segment>>(() => new Set(shown ? [segment] : []));
  if (shown && !mounted.has(segment)) setMounted(new Set(mounted).add(segment));

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = width;
    const at = (ev: globalThis.PointerEvent) => startW + ev.clientX - startX;
    const move = (ev: globalThis.PointerEvent) => onWidth(at(ev), false);
    const up = (ev: globalThis.PointerEvent) => {
      onWidth(at(ev), true);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = e.key === "ArrowLeft" ? width - KEY_STEP : e.key === "ArrowRight" ? width + KEY_STEP : e.key === "Home" ? COLUMN_MIN : e.key === "End" ? COLUMN_MAX : null;
    if (next === null) return;
    e.preventDefault();
    onWidth(next, true);
  };

  return (
    <aside className="loki-column" aria-label="Sidebar" aria-hidden={!shown} onPointerDown={(e) => e.stopPropagation()} style={{ top: TITLEBAR_HEIGHT, left: SIDEBAR_WIDTH, width, visibility: shown ? "visible" : "hidden" }}>
      {[...mounted].map((s) => (
        <div key={s} className="loki-column-body" style={{ visibility: shown && s === segment ? "visible" : "hidden" }} aria-hidden={s !== segment}>
          {sections[s]}
        </div>
      ))}
      <div role="separator" aria-orientation="vertical" aria-label="Resize sidebar" aria-valuemin={COLUMN_MIN} aria-valuemax={COLUMN_MAX} aria-valuenow={width} tabIndex={shown ? 0 : -1} className="loki-column-edge" onPointerDown={onPointerDown} onKeyDown={onKeyDown} />
    </aside>
  );
}

/** The column's top line, level with the main pane's header: the section's name and its actions. It drags the window like the pane header's name line. */
export function ColumnHeader({ title, actions }: { title: ReactNode; actions?: ReactNode }) {
  return (
    <div className="loki-column-header" data-tauri-drag-region="deep">
      <h2 className="loki-column-title">{title}</h2>
      {actions && <span className="loki-column-actions">{actions}</span>}
    </div>
  );
}

/** A section whose list is still to come (Board and Learn views, the agents as DMs): its name only. */
export function ColumnPlaceholder({ title }: { title: string }) {
  return <ColumnHeader title={title} />;
}

/**
 * The Desk column until the desk sidebar lands (U4): the tree's sections — waiting on you, pinned, recent,
 * the rest — as Slack rows, the open desk current, so desks stay one click away without ⌘K.
 */
export function DeskColumn({ desks, items, visited, current, onOpen, onNew }: { desks: DeskSummary[]; items: AttentionItem[]; visited: string[]; current: string; onOpen: (scope: string) => void; onNew?: () => void }) {
  const itemFor = (d: DeskSummary) => items.find((i) => i.agentId === d.agentId && i.id === d.conversationId);
  const sections = sectionDesks(desks, null, items, visited);
  return (
    <>
      <ColumnHeader
        title="Desks"
        actions={
          onNew && (
            <IconButton label="New desk" onClick={onNew}>
              <Icon name="plus" size={16} />
            </IconButton>
          )
        }
      />
      <div className="loki-column-scroll">
        {sections.map((sec) => (
          <ListSection key={sec.id} title={sec.label}>
            {sec.desks.map((d) => {
              const mark = deskMark(itemFor(d), d.status);
              return (
                <ListRow
                  key={d.scope}
                  lead={<ListIcon name="desk" />}
                  title={d.title ?? d.scope}
                  flags={d.pinned ? <Icon name="pin" size={12} title="pinned" /> : undefined}
                  badge={mark.kind === "waits" ? 1 : null}
                  badgeNoun={mark.kind === "waits" ? mark.title : undefined}
                  unread={mark.kind === "finished"}
                  live={mark.kind === "running"}
                  current={d.scope === current}
                  onOpen={() => onOpen(d.scope)}
                />
              );
            })}
          </ListSection>
        ))}
      </div>
    </>
  );
}
