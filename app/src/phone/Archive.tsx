import { useMemo, useState, type ReactNode } from "react";
import type { DeskSummary } from "../desk/useDesk";
import { Button, Field } from "../components";
import { DeskActions, DeskRow, type ArchiveDesk, type RenameDeskName } from "./Home";
import { archiveList } from "./model";
import { SkeletonRows } from "./rows";
import { BackButton, Scroll, TopBar } from "./ui";

/**
 * The archived desks, one page reached from Home's rail and from More: every desk no longer live that
 * has a conversation, in the desk list's order, each reopening it. A filter narrows a long archive; a long
 * press (or a row's actions button) restores one to Desks while the app-server is reachable — offline,
 * the action stays visible and says why it cannot run. Back returns to wherever the page was opened from.
 */
export function Archive({ desks, loaded, banner, backLabel, onBack, onArchive, onRename }: { desks: DeskSummary[]; /** The mod has answered with the desk list. */ loaded: boolean; banner?: ReactNode; backLabel: string; onBack: () => void; /** Null while the app-server cannot take it. */ onArchive: ArchiveDesk | null; onRename: RenameDeskName | null }) {
  const [query, setQuery] = useState("");
  const [acting, setActing] = useState<DeskSummary | null>(null);
  const all = useMemo(() => archiveList(desks, null, ""), [desks]);
  const shown = useMemo(() => archiveList(desks, null, query), [desks, query]);
  return (
    <div className="loki-phone-page">
      <TopBar left={<BackButton onClick={onBack} label={backLabel} />} title="Archived chats" sub={all.length ? <span>{all.length === 1 ? "1 chat" : `${all.length} desks`}</span> : undefined} />
      {banner}
      <Scroll memory="archive" flush>
        {all.length > 0 && (
          <div className="loki-phone-filter">
            <Field type="search" size="touch" name="archive-filter" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter archived chats" aria-label="Filter archived chats" autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false} enterKeyHint="search" data-1p-ignore data-form-type="other" />
          </div>
        )}
        <ul aria-label="archived chats" className="loki-phone-list">
          {shown.map((d) => (
            <DeskRow key={d.scope} desk={d} mark={undefined} onActions={() => setActing(d)} />
          ))}
        </ul>
        {!loaded && desks.length === 0 ? (
          <SkeletonRows label="Reading the chats…" />
        ) : all.length === 0 ? (
          <div className="loki-phone-empty">
            <p className="loki-phone-headline">No archived chats</p>
            <p>A chat you archive, here or on the Mac, waits here until you open or restore it.</p>
          </div>
        ) : (
          shown.length === 0 && (
            <div className="loki-phone-empty">
              <p>No archived chats match.</p>
              <Button size="touch" tone="paper" onClick={() => setQuery("")}>
                Clear filter
              </Button>
            </div>
          )
        )}
      </Scroll>
      {acting && <DeskActions desk={acting} onClose={() => setActing(null)} onPin={null} onArchive={onArchive ? (archived) => onArchive(acting, archived) : null} onRename={onRename ? (name) => onRename(acting, name) : null} />}
    </div>
  );
}
