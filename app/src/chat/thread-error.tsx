import { Button } from "../components";
import type { TranscriptRow } from "./transcript";
import { readTurnError, retryMessage } from "./turn-error";

/** A failed turn: one readable sentence, the harness's own words behind a disclosure, and a way to try again. */
export function ThreadError({ error, rows, onRetry }: { error: string; rows: TranscriptRow[]; onRetry?: (text: string) => void }) {
  const e = readTurnError(error);
  const retry = onRetry ? retryMessage(rows) : null;
  return (
    <div className="loki-thread-error" role="alert">
      <span>{e.text}</span>
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
