import { RETURN_TIMES_DEFAULT, parseRestFirst, type ReturnTimes } from "../../../core/attention/rest.ts";

const REST_FIRST_KEY = "loki.restFirst";

export function moveRestFirst(
  stored: ReturnTimes | null | undefined,
  set: (times: ReturnTimes) => boolean,
  storage: Pick<Storage, "getItem" | "removeItem"> = localStorage,
): boolean {
  if (stored !== null) return false;
  let raw: string | null;
  try {
    raw = storage.getItem(REST_FIRST_KEY);
  } catch {
    return false;
  }
  if (raw === null) return false;
  const first = parseRestFirst(raw);
  if (!set({ ...RETURN_TIMES_DEFAULT, read_first: { chat: first, email: first } })) return false;
  try {
    storage.removeItem(REST_FIRST_KEY);
  } catch {}
  return true;
}
