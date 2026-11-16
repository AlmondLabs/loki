import type { UsageReply, UsageRow } from "../../core/usage.ts";
import { reply, type FrameHandlers } from "./context.ts";

export interface UsageDeps {
  usage?: {
    rows: () => UsageRow[];
    priced: (model: string) => boolean;
    seeded: () => string | null;
  };
}

export function usageFrames({ usage }: UsageDeps): FrameHandlers {
  return {
    usage_get: ({ since, until }) => {
      if (!usage) return reply<UsageReply>({ rows: [], priced: {}, seeded_until: null });
      const from = new Date(Date.parse(since)).toISOString().slice(0, 13);
      const rows = usage.rows().filter((r) => r.hour.slice(0, 13) >= from && r.hour < until);
      const priced = Object.fromEntries([...new Set(rows.map((r) => r.model))].map((m) => [m, usage.priced(m)]));
      return reply<UsageReply>({ rows, priced, seeded_until: usage.seeded() });
    },
  };
}
