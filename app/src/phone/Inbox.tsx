import type { AttentionItem, AttentionStatus } from "../../../packages/core/src/attention/model.ts";
import { catchUpQueue, snoozedItems } from "../../../packages/core/src/attention/queue.ts";
import { formatIn } from "../../../packages/core/src/attention/snooze.ts";
import { formatInput } from "../../../packages/core/src/attention/format.ts";
import { AgentChip, AgentFace } from "../desk/AgentChip";
import { avatarUrl } from "../desk/env";
import { lastSeen } from "./model";
import { BADGE } from "../desk/CatchUp";
import { SAFE, tap } from "./ui";

/**
 * The inbox as one column: Catch Up's items in Catch Up's order (approvals, questions, failures,
 * finished), one card each, the decision buttons under the text. Tapping a card opens the
 * conversation. Deferred cards sit at the bottom, quieter, with "unsnooze".
 */


/** The two or three lines a card shows under its title. */
export function preview(item: AttentionItem): string {
  if (item.pendingApproval) return `run ${item.pendingApproval.toolName}\n${formatInput(item.pendingApproval.input)}`;
  if (item.pendingQuestion) return item.pendingQuestion.questions.map((q) => q.question).join("\n");
  if (item.status === "failed" && item.error) return item.error;
  return item.lastAssistantText ?? "";
}

export function Inbox({
  items,
  loaded,
  available,
  onOpen,
  onApprove,
  onSeen,
  onLater,
  onUnsnooze,
}: {
  items: AttentionItem[];
  /** The app-server has answered at least once; before that an empty list means nothing. */
  loaded: boolean;
  /** The mod found an app-server to tunnel to; without one there is no inbox to read. */
  available: boolean;
  onOpen: (item: AttentionItem) => void;
  onApprove: (item: AttentionItem, requestId: string, behavior: "allow" | "deny") => void;
  onSeen: (item: AttentionItem) => void;
  onLater: (item: AttentionItem) => void;
  onUnsnooze: (item: AttentionItem) => void;
}) {
  const queue = catchUpQueue(items);
  const snoozed = snoozedItems(items);
  const running = items.filter((i) => i.status === "running").length;

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", WebkitOverflowScrolling: "touch", padding: `12px calc(12px + ${SAFE.right}) calc(24px + ${SAFE.bottom}) calc(12px + ${SAFE.left})`, display: "grid", gap: 10, alignContent: "start" }}>
      {queue.length === 0 && (
        <div style={{ background: "var(--loki-panel)", border: "1px solid var(--loki-border)", borderRadius: 12, padding: "36px 20px", textAlign: "center", marginTop: 24 }}>
          <div style={{ fontFamily: "var(--loki-display)", fontSize: 22, color: "var(--loki-fg)" }}>{!available ? "No harness on the Mac." : loaded ? "You're caught up." : "Reading the inbox…"}</div>
          <div style={{ fontSize: 12, color: "var(--loki-muted)", marginTop: 8 }}>{!available ? "loki's mod has not found Letta's app-server; open loki on the Mac" : !loaded ? "the Mac is listing conversations" : running > 0 ? `${running} still running` : "nothing is waiting on you"}</div>
          {snoozed.length > 0 && <div style={{ fontSize: 12, color: "var(--loki-muted)", marginTop: 6 }}>{snoozed.length} deferred, below</div>}
        </div>
      )}
      {queue.map((item) => (
        <Card key={`${item.agentId}/${item.id}`} item={item} onOpen={onOpen} onApprove={onApprove} onSeen={onSeen} onLater={onLater} />
      ))}
      {snoozed.length > 0 && (
        <>
          <div className="loki-label" style={{ fontSize: 9.5, padding: "12px 4px 0" }}>
            deferred · {snoozed.length}
          </div>
          {snoozed.map((item) => (
            <div key={`${item.agentId}/${item.id}`} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", border: "1px solid var(--loki-border)", borderRadius: 8, opacity: 0.75 }}>
              <button type="button" onClick={() => onOpen(item)} style={{ flex: 1, minWidth: 0, textAlign: "left", background: "transparent", border: "none", padding: 0, color: "var(--loki-fg)", fontSize: 13.5, cursor: "pointer" }}>
                <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title ?? item.id}</span>
                <span style={{ display: "block", fontSize: 10.5, color: "var(--loki-muted)", fontFamily: "var(--loki-mono)", letterSpacing: "0.06em", marginTop: 2 }}>
                  {item.agentName ?? "agent"} · back in {item.snooze ? formatIn(item.snooze.until) : "a while"}
                </span>
              </button>
              <button type="button" onClick={() => onUnsnooze(item)} style={{ ...tap(), minHeight: 34, padding: "4px 10px", fontSize: 12 }}>
                unsnooze
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function Card({ item, onOpen, onApprove, onSeen, onLater }: { item: AttentionItem; onOpen: (i: AttentionItem) => void; onApprove: (i: AttentionItem, requestId: string, behavior: "allow" | "deny") => void; onSeen: (i: AttentionItem) => void; onLater: (i: AttentionItem) => void }) {
  const badge = BADGE[item.status];
  const waiting = item.status === "approval" ? (item.pendingApproval?.at ?? item.lastMessageAt) : item.lastMessageAt;
  const text = preview(item);
  return (
    <article aria-label={`${item.title ?? item.id}, ${badge.label}`} style={{ background: "var(--loki-panel)", border: `1px solid ${item.status === "approval" || item.status === "question" ? badge.color : "var(--loki-border)"}`, borderRadius: 12, overflow: "hidden" }}>
      <button type="button" onClick={() => onOpen(item)} style={{ display: "block", width: "100%", textAlign: "left", background: "transparent", border: "none", padding: "12px 14px 8px", color: "var(--loki-fg)", cursor: "pointer", WebkitTapHighlightColor: "transparent" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <AgentFace name={item.agentName} src={avatarUrl(item.agentId)} size={20} />
          <AgentChip name={item.agentName} />
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 10.5, letterSpacing: "0.06em", color: badge.color, border: `1px solid ${badge.color}`, borderRadius: 999, padding: "2px 9px", whiteSpace: "nowrap" }}>{badge.label}</span>
        </div>
        <div style={{ fontFamily: "var(--loki-display)", fontSize: 15, marginTop: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title ?? item.id}</div>
        {text && (
          <div style={{ fontSize: 13.5, lineHeight: 1.45, color: item.status === "failed" ? "var(--loki-negative)" : "var(--loki-muted)", marginTop: 4, whiteSpace: "pre-wrap", overflowWrap: "anywhere", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden", fontFamily: item.pendingApproval || item.status === "failed" ? "var(--loki-mono)" : undefined }}>
            {text}
          </div>
        )}
        <div style={{ fontSize: 10.5, color: "var(--loki-muted)", fontFamily: "var(--loki-mono)", letterSpacing: "0.06em", marginTop: 6 }}>{item.status === "approval" ? `waiting ${lastSeen(waiting).replace(" ago", "")}` : lastSeen(waiting)}</div>
      </button>
      <div style={{ display: "flex", gap: 8, padding: "0 10px 10px", flexWrap: "wrap" }}>
        {item.pendingApproval && (
          <>
            <button type="button" onClick={() => onApprove(item, item.pendingApproval!.requestId, "allow")} style={tap("var(--loki-positive)")}>
              approve
            </button>
            <button type="button" onClick={() => onApprove(item, item.pendingApproval!.requestId, "deny")} style={tap("var(--loki-negative)")}>
              deny
            </button>
          </>
        )}
        {item.pendingQuestion && (
          <button type="button" onClick={() => onOpen(item)} style={tap("var(--loki-accent)")}>
            answer
          </button>
        )}
        {!item.pendingApproval && (
          <button type="button" onClick={() => onSeen(item)} style={tap("var(--loki-fg)")}>
            seen
          </button>
        )}
        {!item.pendingApproval && (
          <button type="button" onClick={() => onLater(item)} style={tap()} title="comes back later, later each time">
            later
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button type="button" onClick={() => onOpen(item)} style={tap()}>
          open ›
        </button>
      </div>
    </article>
  );
}
