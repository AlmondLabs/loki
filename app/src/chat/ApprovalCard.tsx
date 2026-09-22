import type { ReactNode } from "react";
import type { PendingApproval } from "../../../core/attention/model.ts";
import { formatInput } from "../../../core/attention/format.ts";

/**
 * "waiting for your approval to run X" with the tool input, as Catch Up shows
 * it. `actions` (approve/deny… buttons) render underneath when given.
 */
export function ApprovalCard({ approval, actions }: { approval: PendingApproval; actions?: ReactNode }) {
  return (
    <div data-approval className="loki-approval">
      <div className="loki-label loki-approval-kicker">
        needs your approval · <code className="loki-approval-tool" style={{ color: "var(--loki-fg)", fontFamily: "var(--loki-mono)", textTransform: "none", letterSpacing: 0 }}>{approval.toolName}</code>
      </div>
      <pre className="loki-approval-input">
        {formatInput(approval.input)}
      </pre>
      {actions && <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>{actions}</div>}
    </div>
  );
}
