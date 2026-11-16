import type { TranscriptRow } from "../../../core/attention/transcript.ts";
import { withoutReplies } from "../../../core/harness.ts";
import type { ChatStatus } from "./conversation";

const SAID_CHARS = 160;

export function threadAnnouncement({
  status,
  waiting,
  rows,
  who,
}: {
  status: ChatStatus;
  waiting: boolean;
  rows: readonly TranscriptRow[];
  who: string;
}): string {
  const name = who.charAt(0).toUpperCase() + who.slice(1);
  if (waiting) return `${name} is waiting for you`;
  if (status !== "idle") return `${name} is thinking`;
  const last = rows.at(-1);
  if (last?.role !== "assistant") return "";
  const text = withoutReplies(last.text)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_#>|~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return `${name} replied`;
  return `${name} replied: ${text.length > SAID_CHARS ? `${text.slice(0, SAID_CHARS - 1).trimEnd()}…` : text}`;
}

/**
 * The thread's spoken line: a polite status region that is always mounted, so each change is read (a region mounted
 * with its words is not), and atomic, so the whole line is read rather than the part that changed.
 */
export function ThreadAnnouncer(props: Parameters<typeof threadAnnouncement>[0]) {
  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {threadAnnouncement(props)}
    </div>
  );
}
