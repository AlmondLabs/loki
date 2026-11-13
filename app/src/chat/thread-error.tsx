import { MOVE_OUT_OF_REACH } from "../../../core/frames.ts";
import { Button } from "../components";
import type { TranscriptRow } from "./transcript";
import { readTurnError, retryMessage } from "./turn-error";

/** A failed turn: one readable sentence, the harness's own words behind a disclosure, and a way to try again. */
export function ThreadError({
  error,
  rows,
  onRetry,
  onKeepHere,
}: {
  error: string;
  rows: TranscriptRow[];
  onRetry?: (text: string) => void;
  /** Keep the chat on this Mac when its move cannot finish (plan 096); offered only for that error. */
  onKeepHere?: () => Promise<string | null>;
}) {
  const e = readTurnError(error);
  const retry = onRetry ? retryMessage(rows) : null;
  // A move to a Mac out of reach holds the chat until that Mac is back, unless the person keeps it here (plan 096).
  const moving = onKeepHere && error.includes(MOVE_OUT_OF_REACH);
  return (
    <div className="loki-thread-error" role="alert">
      <span>{e.text}</span>
      {moving && (
        <Button size="sm" onClick={() => void onKeepHere()}>
          keep it here
        </Button>
      )}
      {retry && (
        <Button size="sm" onClick={() => onRetry?.(retry.text)}>
          {retry.label}
        </Button>
      )}
      {e.raw && (
        <details className="loki-thread-error-raw">
          <summary>details</summary>
          <pre>{e.raw}</pre>
        </details>
      )}
    </div>
  );
}
