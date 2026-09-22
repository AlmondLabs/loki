import { useMemo, type ReactNode } from "react";
import type { DeskSummary } from "../desk/useDesk";
import { archivedDesks } from "../shell/DeskTree";
import { DeskRow, openDesk } from "./Home";
import { BackButton, GUTTER, SAFE, Scroll, TopBar } from "./ui";

/**
 * The archived desks, one page reached from Home and from More: every desk no longer live, newest
 * first as the desk list orders them, each reopening its conversation. U3 gives it Home's new row
 * anatomy; until then it reuses Home's desk row.
 */
export function Archive({ desks, banner, backLabel, onBack }: { desks: DeskSummary[]; banner?: ReactNode; backLabel: string; onBack: () => void }) {
  // The shared sheet has no conversation to open on a phone, so it stays out.
  const archive = useMemo(() => archivedDesks(desks, null, "").filter((d) => d.agentId && d.conversationId), [desks]);
  return (
    <>
      <TopBar left={<BackButton onClick={onBack} label={backLabel} />} title="Archived desks" sub={archive.length ? <span>{archive.length}</span> : undefined} />
      {banner}
      <Scroll memory="archive" style={{ padding: `4px ${GUTTER.right} calc(24px + ${SAFE.bottom}) ${GUTTER.left}` }}>
        <ul aria-label="archived desks" className="loki-phone-list">
          {archive.map((d) => (
            <DeskRow key={d.scope} desk={d} mark={undefined} showFace onOpen={() => openDesk(d)} onPin={null} />
          ))}
        </ul>
        {archive.length === 0 && <div className="loki-phone-meta" style={{ padding: "32px 4px", textAlign: "center" }}>{desks.length ? "No archived desks." : "reading the desks…"}</div>}
      </Scroll>
    </>
  );
}
