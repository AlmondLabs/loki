import type { TranscriptRow } from "../../../core/attention/transcript.ts";
import { repliesOf } from "../../../core/harness.ts";
import type { KeyboardEvent } from "react";
import { Button } from "../components";

/**
 * The quick replies the thread's last message offers (plan 066), or null. They belong to the last message only: any
 * row after it (the person's message, a new turn) or an older reply never offers a fork that has passed.
 */
export function lastReplies(rows: readonly TranscriptRow[] | undefined): string[] | null {
  const last = rows?.at(-1);
  return last?.role === "assistant" ? repliesOf(last.text) : null;
}

/**
 * The option a key sends while one of the quick replies has focus on the Mac: 1 to 4, no modifiers. Null for any other
 * key. Never read in the message box, where a digit is only a digit (plan 2026-11-14-0852, 5).
 */
export function replyKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }, options: readonly string[]): string | null {
  if (e.metaKey || e.ctrlKey || e.altKey || !/^[1-4]$/.test(e.key)) return null;
  return options[Number(e.key) - 1] ?? null;
}

/** The group's key handler: a digit sends its option while focus is on one of the replies. */
export function replyKeyDown(options: readonly string[], onPick: (text: string) => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    const option = replyKey(e, options);
    if (!option) return;
    e.preventDefault();
    onPick(option);
  };
}

/**
 * A row of buttons under the agent's last reply, at the end of the thread, one per quick reply; a click sends the option
 * as the person's message. On the Mac, with a reply focused, 1 to 4 send theirs; the key is in each one's tooltip.
 */
export function QuickReplies({
  options,
  onPick,
  touch = false,
  column = false,
}: {
  options: readonly string[];
  onPick: (text: string) => void;
  touch?: boolean;
  /** The avatar-led layout: the buttons start where the message text does, past the faces. */
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
