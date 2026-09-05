import type { ReactNode } from "react";
import type { PendingApproval } from "../attention/model";
import { formatInput } from "../attention/format";

/**
 * "waiting for your approval to run X" with the tool input, as Catch Up shows
 * it. `actions` (approve/deny… buttons) render underneath when given.
 */
export function ApprovalCard({ approval, actions }: { approval: PendingApproval; actions?: ReactNode }) {
  return (
    <div data-approval style={{ padding: "12px 20px", borderTop: "1px solid var(--loci-accent)", background: "var(--loci-brass-soft)" }}>
      <div className="loci-label" style={{ color: "var(--loci-accent)", marginBottom: 8 }}>
        needs your approval · <code style={{ color: "var(--loci-fg)", fontFamily: "var(--loci-mono)", textTransform: "none", letterSpacing: 0 }}>{approval.toolName}</code>
      </div>
      <pre style={{ margin: 0, padding: "10px 12px", background: "#101014", border: "1px solid var(--loci-border)", borderRadius: 8, fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 140, overflow: "auto", color: "var(--loci-fg)" }}>
        {formatInput(approval.input)}
      </pre>
      {actions && <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>{actions}</div>}
    </div>
  );
}
