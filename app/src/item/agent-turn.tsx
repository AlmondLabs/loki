import type { ReactNode } from "react";
import { Badge } from "@/ui/badge";
import type { TurnPart, TurnState } from "./entries";

/** How each state reads in the header, and the role its colour comes from. */
const STATE: Record<TurnState, { words: (failed: number) => string; className: string }> = {
  working: { words: () => "working", className: "text-muted-foreground data-[state=working]:shimmer" },
  "needs you": { words: () => "needs you", className: "text-loki-attention" },
  failed: { words: (n) => `${n} failed`, className: "text-loki-negative" },
  done: { words: () => "done", className: "text-loki-positive" },
};

/**
 * One turn of the agent's (plan 096, U6, the Turns direction): a header with its name, how long it worked and where it
 * stands, then everything it did between two of your messages in the order it happened, its words, its stretches of
 * work, its events and the widgets it changed. The header is where a turn says it is working, waits on you or failed,
 * so that reads without opening anything.
 */
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
  return (
    <section data-turn={state} aria-label={`${agentName}'s turn, ${look.words(failed)}`} className="flex flex-col gap-3">
      <header className="flex items-center gap-2 text-meta text-muted-foreground">
        <span className="font-semibold text-foreground">{agentName}</span>
        {took && <span>worked {took}</span>}
        <Badge variant="outline" data-state={state} className={look.className}>
          {look.words(failed)}
        </Badge>
      </header>
      {parts.map((p) => (
        <div key={p.key} className="min-w-0">
          {draw(p)}
        </div>
      ))}
    </section>
  );
}
