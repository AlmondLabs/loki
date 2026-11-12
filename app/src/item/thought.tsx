import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/ui/ai-elements/reasoning";
import type { TranscriptRow } from "../../../core/attention/transcript.ts";

/** What the agent thought across some rows: their thoughts in order, and how long, when every one was timed. */
export function thoughtOf(rows: readonly TranscriptRow[]): { text: string; seconds: number | undefined } | null {
  const thought = rows.filter((r) => r.thought);
  if (!thought.length) return null;
  const timed = thought.every((r) => r.thought_ms !== undefined);
  const ms = thought.reduce((n, r) => n + (r.thought_ms ?? 0), 0);
  return { text: thought.map((r) => r.thought).join("\n\n"), seconds: timed ? Math.max(1, Math.round(ms / 1000)) : undefined };
}

/** The trigger's words: how long it thought when that is known, never a guess (KTD8). */
const words = (_streaming: boolean, seconds?: number) => (
  <span>{seconds === undefined ? "thought" : `thought for ${seconds} ${seconds === 1 ? "second" : "seconds"}`}</span>
);

/**
 * What the agent thought before a reply or a stretch of work (plan 097, U9), on AI Elements' Reasoning: folded to one
 * quiet line, "thought for 12 seconds", opening to the thought itself. Drawn only where a row carries a thought, so a
 * turn with none shows no line.
 */
export function Thought({ rows }: { rows: readonly TranscriptRow[] }) {
  const t = thoughtOf(rows);
  if (!t) return null;
  return (
    <Reasoning data-thought duration={t.seconds} defaultOpen={false} className="mb-2">
      <ReasoningTrigger getThinkingMessage={words} className="text-meta" />
      <ReasoningContent className="mt-2 text-meta">{t.text}</ReasoningContent>
    </Reasoning>
  );
}
