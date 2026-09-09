import type { PendingApproval, PendingQuestion } from "../../../packages/core/src/attention/model.ts";
import { Button } from "../ui";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";

/** Between the transcript and the composer: the agent's open question, and the tool permission it is paused on. */
export function AttentionStrip({
  question,
  onAnswer,
  approval,
  onApprove,
}: {
  question: PendingQuestion | null;
  onAnswer?: (answers: Record<string, string | string[]>) => void;
  approval: PendingApproval | null;
  onApprove?: (behavior: "allow" | "deny") => void;
}) {
  return (
    <>
      {question && onAnswer && <QuestionCard question={question} onAnswer={onAnswer} />}
      {approval && (
        <ApprovalCard
          approval={approval}
          actions={
            onApprove && (
              <>
                <Button size="sm" tone="positive" onClick={() => onApprove("allow")}>approve</Button>
                <Button size="sm" tone="negative" onClick={() => onApprove("deny")}>deny</Button>
              </>
            )
          }
        />
      )}
    </>
  );
}
