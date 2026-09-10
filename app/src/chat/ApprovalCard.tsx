import type { ReactNode } from "react";
import type { PendingApproval } from "../../../core/attention/model.ts";
import { formatInput } from "../../../core/attention/format.ts";

/**
 * "waiting for your approval to run X" with the tool input, as Catch Up shows
 * it. `actions` (approve/deny… buttons) render underneath when given.
 */
export function ApprovalCard({ approval, actions }: { approval: PendingApproval; actions?: ReactNode }) {
  return (
    <div data-approval style={{ padding: "12px 20px", borderTop: "1px solid var(--loki-accent)", background: "var(--loki-brass-soft)" }}>
      <div className="loki-label" style={{ color: "var(--loki-accent)", marginBottom: 8 }}>
        needs your approval · <code style={{ color: "var(--loki-fg)", fontFamily: "var(--loki-mono)", textTransform: "none", letterSpacing: 0 }}>{approval.toolName}</code>
      </div>
      <pre style={{ margin: 0, padding: "10px 12px", background: "var(--loki-well)", border: "1px solid var(--loki-border)", borderRadius: 8, fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 140, overflow: "auto", color: "var(--loki-fg)" }}>
        {formatInput(approval.input)}
      </pre>
      {actions && <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>{actions}</div>}
    </div>
  );
}
