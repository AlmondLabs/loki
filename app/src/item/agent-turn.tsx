import { capitalFirst } from "../kit/words";
import type { ReactNode } from "react";
import { Badge } from "@/ui/badge";
import { Loader } from "@/ui/ai-elements/loader";
import type { TurnPart, TurnState } from "./entries";

const STATE: Record<TurnState, { words: (failed: number) => string; className: string }> = {
  working: { words: () => "working", className: "text-muted-foreground data-[state=working]:shimmer" },
  "needs you": { words: () => "needs you", className: "text-foreground" },
  failed: { words: (n) => `${n} failed`, className: "text-loki-negative" },
  done: { words: () => "done", className: "text-loki-positive" },
};

export function AgentTurn({
  agentName,
  state,
  failed,
  took,
  parts,
  draw,
}: {
  agentName: string;
  state: TurnState;
  failed: number;
  took: string | null;
  parts: TurnPart[];
  draw: (part: TurnPart) => ReactNode;
}) {
  const look = STATE[state];
  const said = capitalFirst(look.words(failed));
  const header = took !== null || state !== "done";
  return (
    <section data-turn={state} aria-label={`${agentName}'s turn, ${look.words(failed)}`} className="flex flex-col gap-3">
      {header && (
        <header className="flex items-center gap-2 text-xs text-muted-foreground">
          {took && <span>Worked {took}</span>}
          {state !== "done" && (
            <Badge variant="outline" data-state={state} className={look.className}>
              {state === "working" && <Loader size={12} aria-hidden />}
              {state === "needs you" && <span aria-hidden className="size-1.5 rounded-full bg-loki-attention" />}
              {said}
            </Badge>
          )}
        </header>
      )}
      {parts.map((p) => (
        <div key={p.key} className="min-w-0">
          {draw(p)}
        </div>
      ))}
    </section>
  );
}
