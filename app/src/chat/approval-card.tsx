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
        Needs your approval ·{" "}
        <code className="loki-approval-tool loki-mono" style={{ color: "var(--loki-fg)" }}>
          {approval.toolName}
        </code>
      </div>
      <pre className="loki-approval-input">{formatInput(approval.input)}</pre>
      {actions && (
        <div className="flex flex-wrap items-center gap-2" style={{ marginTop: 12 }}>
          {actions}
        </div>
      )}
    </div>
  );
}
