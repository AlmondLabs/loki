import { CheckCircle2Icon, CircleDotIcon, CircleIcon } from "lucide-react";
import type { PlanItem } from "../../../core/attention/transcript.ts";
import { Plan, PlanContent, PlanDescription, PlanHeader, PlanTitle, PlanTrigger } from "@/ui/ai-elements/plan";
import { cn } from "@/lib/utils";

/** Each entry's mark: done, under way, not started. */
const MARK: Record<PlanItem["status"], { Icon: typeof CircleIcon; className: string; word: string }> = {
  completed: { Icon: CheckCircle2Icon, className: "text-loki-positive", word: "done" },
  in_progress: { Icon: CircleDotIcon, className: "text-foreground", word: "under way" },
  pending: { Icon: CircleIcon, className: "text-muted-foreground", word: "not started" },
};

/** How far the plan is, as its line reads: "1 of 3 done". */
export const planProgress = (items: readonly PlanItem[]): string => `${items.filter((i) => i.status === "completed").length} of ${items.length} done`;

/**
 * The agent's plan as it stands (plan 097, U9) on AI Elements' Plan: "plan" with how far it is, open while the agent
 * works on it, each entry with its mark and the one under way in full ink. Drawn from the newest plan in a stretch of
 * work, so an updated plan replaces the one before rather than stacking.
 */
export function AgentPlan({ items, running }: { items: readonly PlanItem[]; running: boolean }) {
  const working = running && items.some((i) => i.status !== "completed");
  return (
    <Plan data-plan defaultOpen={working} isStreaming={working} className="gap-2 py-3">
      <PlanHeader className="px-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <PlanTitle className="text-body">plan</PlanTitle>
          <PlanDescription className="text-meta">{planProgress(items)}</PlanDescription>
        </div>
        <PlanTrigger className="size-7" />
      </PlanHeader>
      <PlanContent className="px-4">
        <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
          {items.map((item, i) => {
            const mark = MARK[item.status];
            return (
              <li key={i} data-status={item.status} className={cn("flex items-start gap-2 text-body", item.status === "completed" && "text-muted-foreground")}>
                <mark.Icon aria-label={mark.word} className={cn("mt-0.5 size-4 shrink-0", mark.className)} />
                <span className="min-w-0">{item.content}</span>
              </li>
            );
          })}
        </ol>
      </PlanContent>
    </Plan>
  );
}
