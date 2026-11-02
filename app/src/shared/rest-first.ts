import { createSessionValue } from "./session-value";
import { parseRestFirst } from "../../../core/attention/rest.ts";

/** How long Next first rests an Inbox card on this device (Preferences › Inbox), kept across launches. */
const restFirst = createSessionValue("loki.restFirst", parseRestFirst, () => localStorage);
/** The first rest's choice and its setter, `[choice, setChoice]`; REST_FIRST_CHOICES (rest.ts) gives its length. */
export const useRestFirst = restFirst.use;
