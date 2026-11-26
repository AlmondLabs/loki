import type { useWorkspace } from "../workspace/use-workspace";
import type { useAttention } from "../../../core/attention/use-attention.ts";

export type Workspace = ReturnType<typeof useWorkspace>;
export type CatchUp = ReturnType<typeof useAttention>;
export interface Runtime {
  agent_id: string;
  conversation_id: string;
}
