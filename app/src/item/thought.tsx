import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/ui/ai-elements/reasoning";
import type { TranscriptRow } from "../../../core/attention/transcript.ts";

export function thoughtOf(rows: readonly TranscriptRow[]): { text: string; seconds: number | undefined } | null {
  const thought = rows.filter((r) => r.thought);
  if (!thought.length) return null;
  const timed = thought.every((r) => r.thought_ms !== undefined);
  const ms = thought.reduce((n, r) => n + (r.thought_ms ?? 0), 0);
  return { text: thought.map((r) => r.thought).join("\n\n"), seconds: timed ? Math.max(1, Math.round(ms / 1000)) : undefined };
}

export const thoughtWords = (seconds: number | undefined): string =>
  seconds === undefined ? "Thought" : `Thought for ${seconds} ${seconds === 1 ? "second" : "seconds"}`;

const words = (seconds: number | undefined) => <span>{thoughtWords(seconds)}</span>;

export function Thought({ rows }: { rows: readonly TranscriptRow[] }) {
  const t = thoughtOf(rows);
  if (!t) return null;
  return (
    <Reasoning data-thought duration={t.seconds} defaultOpen={false} className="mb-2">
      <ReasoningTrigger getThinkingMessage={(_streaming, seconds) => words(seconds)} className="text-xs" />
      <ReasoningContent className="mt-2 text-xs">{t.text}</ReasoningContent>
    </Reasoning>
  );
}
