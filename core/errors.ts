/**
 * What went wrong, in words (plan 057). A catch receives `unknown`: an Error says its message, anything else is
 * written as it is. Every place that reports, logs or shows a failure says it this one way.
 */

/** An error's message, or the thrown value as a string. */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
