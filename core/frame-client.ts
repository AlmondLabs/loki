export const MOVE_TIMEOUT_MS = 180_000;
export const PASS_RUN_TIMEOUT_MS = 10 * 60_000;
export const DOCTOR_WAIT_MS = PASS_RUN_TIMEOUT_MS + 60_000;
export const MAIL_HOLD_MS = 10_000;
export const REPLY_WAIT_MS = 60_000;
export const HANDOFF_WAIT_MS = 60_000;
/**
 * What a chat says while it is held for a move to a Mac out of reach (plan 096); the app finds it in the error line and
 * offers **keep it here** there.
 */
export const MOVE_OUT_OF_REACH = "which is out of reach: keep it here";

export type RequestResult<R> = { ok: true; reply: R } | { ok: false; error: string; timed_out: boolean };

export function requestResult<R>(answer: Record<string, unknown> | null): RequestResult<R> {
  if (!answer) return { ok: false, error: "no answer from the mod", timed_out: true };
  if (answer.type === "error") return { ok: false, error: typeof answer.message === "string" ? answer.message : "the mod refused", timed_out: false };
  return { ok: true, reply: answer as unknown as R };
}
