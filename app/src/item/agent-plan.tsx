import { CheckCircle2Icon, CircleDotIcon, CircleIcon } from "lucide-react";
import type { PlanItem } from "../../../core/attention/transcript.ts";
import { Plan, PlanContent, PlanDescription, PlanHeader, PlanTitle, PlanTrigger } from "@/ui/ai-elements/plan";
import { cn } from "@/lib/utils";

const MARK: Record<PlanItem["status"], { Icon: typeof CircleIcon; className: string; word: string }> = {
  completed: { Icon: CheckCircle2Icon, className: "text-loki-positive", word: "done" },
  in_progress: { Icon: CircleDotIcon, className: "text-foreground", word: "under way" },
  pending: { Icon: CircleIcon, className: "text-muted-foreground", word: "not started" },
};

export const planProgress = (items: readonly PlanItem[]): string => `${items.filter((i) => i.status === "completed").length} of ${items.length} done`;

export function AgentPlan({ items }: { items: readonly PlanItem[] }) {
  return (
    <Plan data-plan defaultOpen={false} className="gap-2 py-3">
      <PlanHeader className="px-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <PlanTitle className="text-sm">Plan</PlanTitle>
          <PlanDescription className="text-xs">{planProgress(items)}</PlanDescription>
        </div>
        <PlanTrigger className="size-7" />
      </PlanHeader>
      <PlanContent className="px-4">
        <ol className="m-0 flex list-none flex-col gap-2 p-0">
          {items.map((item, i) => {
            const mark = MARK[item.status];
            return (
              <li key={i} data-status={item.status} className={cn("flex items-start gap-2 text-sm", item.status === "completed" && "text-muted-foreground")}>
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
