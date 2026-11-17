import type { useDesk } from "../desk/use-desk";
import type { useAttention } from "../../../core/attention/use-attention.ts";

export type Desk = ReturnType<typeof useDesk>;
export type CatchUp = ReturnType<typeof useAttention>;
export interface Runtime {
  agent_id: string;
  conversation_id: string;
}
