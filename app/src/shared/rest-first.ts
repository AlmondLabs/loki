import { RETURN_TIMES_DEFAULT, parseRestFirst, type ReturnTimes } from "../../../core/attention/rest.ts";

/** Where the Mac kept its first-rest choice before the daemon kept the return times (plan 065). */
const REST_FIRST_KEY = "loki.restFirst";

/**
 * Move this device's old first-rest choice to the daemon, once (plan 070, KTD8): when the daemon has said it keeps no
 * return times (`stored` null, not undefined, which is a mod that has not said or never will) and this device has a
 * choice, it becomes the chat and email ⌘] rest and leaves the device. `set` sends it and says whether it went. True
 * when it moved.
 */
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
    return false; // storage off: nothing to move
  }
  if (raw === null) return false;
  const first = parseRestFirst(raw);
  if (!set({ ...RETURN_TIMES_DEFAULT, read_first: { chat: first, email: first } })) return false; // not sent: kept for the next push
  try {
    storage.removeItem(REST_FIRST_KEY);
  } catch {
    // Storage off: the daemon now has the value, which wins over this one from here on.
  }
  return true;
}
