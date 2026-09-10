import type { useDesk } from "../desk/useDesk";
import type { useAttention } from "../../../core/attention/useAttention.ts";

/** The desk model the window holds (useDesk()); the views and hooks under shell/ read it by this name. */
export type Desk = ReturnType<typeof useDesk>;
/** The attention model (useAttention()): the app-server link, the inbox items, agents and providers. */
export type CatchUp = ReturnType<typeof useAttention>;
/** The app-server runtime a chat or a model switch addresses. */
export type Runtime = { agent_id: string; conversation_id: string };
