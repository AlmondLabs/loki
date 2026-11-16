import type { TranscriptRow } from "../../../core/attention/transcript.ts";
import { repliesOf } from "../../../core/harness.ts";
import type { KeyboardEvent } from "react";
import { Button } from "../components";

export function lastReplies(rows: readonly TranscriptRow[] | undefined): string[] | null {
  const last = rows?.at(-1);
  return last?.role === "assistant" ? repliesOf(last.text) : null;
}

export function replyKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }, options: readonly string[]): string | null {
  if (e.metaKey || e.ctrlKey || e.altKey || !/^[1-4]$/.test(e.key)) return null;
  return options[Number(e.key) - 1] ?? null;
}

export function replyKeyDown(options: readonly string[], onPick: (text: string) => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    const option = replyKey(e, options);
    if (!option) return;
    e.preventDefault();
    onPick(option);
  };
}

export function QuickReplies({
  options,
  onPick,
  touch = false,
  column = false,
}: {
  options: readonly string[];
  onPick: (text: string) => void;
  touch?: boolean;
  column?: boolean;
}) {
  return (
    <div
      className={column ? "loki-quick-replies loki-quick-replies--column" : "loki-quick-replies"}
      role="group"
      aria-label="Quick replies"
      onKeyDown={touch ? undefined : replyKeyDown(options, onPick)}
    >
      {options.map((option, i) => (
        <Button
          key={option}
          tone="brass"
          size={touch ? "touch" : "sm"}
          className="loki-quick-reply"
          title={`Send “${option}”`}
          onClick={() => onPick(option)}
          kbd={touch ? undefined : String(i + 1)}
        >
          <span className="loki-quick-reply-text">{option}</span>
        </Button>
      ))}
    </div>
  );
}
