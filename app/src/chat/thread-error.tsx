import { MOVE_OUT_OF_REACH } from "../../../core/frames.ts";
import { Button } from "../components";
import type { TranscriptRow } from "./transcript";
import { readTurnError, retryMessage } from "./turn-error";

export function ThreadError({
  error,
  rows,
  onRetry,
  onKeepHere,
}: {
  error: string;
  rows: TranscriptRow[];
  onRetry?: (text: string) => void;
  onKeepHere?: () => Promise<string | null>;
}) {
  const e = readTurnError(error);
  const retry = onRetry ? retryMessage(rows) : null;
  const moving = onKeepHere && error.includes(MOVE_OUT_OF_REACH);
  return (
    <div className="loki-thread-error" role="alert">
      <span>{e.text}</span>
      {moving && (
        <Button size="sm" onClick={() => void onKeepHere()}>
          Keep It Here
        </Button>
      )}
      {retry && (
        <Button size="sm" onClick={() => onRetry?.(retry.text)}>
          {retry.label}
        </Button>
      )}
      {e.raw && (
        <details className="loki-thread-error-raw">
          <summary>Details</summary>
          <pre>{e.raw}</pre>
        </details>
      )}
    </div>
  );
}
