import type { TranscriptRow } from "../../../core/attention/transcript.ts";
import { repliesOf } from "../../../core/harness.ts";
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
 * The key that sends option `index` from an empty, focused message box on the Mac: 1 to 4, no modifiers. Null for any
 * other key, so the box types it as usual.
 */
export function replyKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }, options: readonly string[]): string | null {
  if (e.metaKey || e.ctrlKey || e.altKey || !/^[1-4]$/.test(e.key)) return null;
  return options[Number(e.key) - 1] ?? null;
}

/**
 * A row of buttons under the agent's last reply, at the end of the thread, one per quick reply; a click sends the option as the person's message.
 * The Mac shows each one's key (1 to 4); the phone has none.
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
    <div className={column ? "loki-quick-replies loki-quick-replies--column" : "loki-quick-replies"} role="group" aria-label="quick replies">
      {options.map((option, i) => (
        <Button
          key={option}
          tone="brass"
          size={touch ? "touch" : "sm"}
          className="loki-quick-reply"
          title={`send "${option}"`}
          onClick={() => onPick(option)}
          kbd={touch ? undefined : String(i + 1)}
        >
          <span className="loki-quick-reply-text">{option}</span>
        </Button>
      ))}
    </div>
  );
}
