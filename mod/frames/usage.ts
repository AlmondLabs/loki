import type { UsageReply, UsageRow } from "../../core/usage.ts";
import { reply, type FrameHandlers } from "./context.ts";

/** What the usage frame handler needs from its host: the daemon's usage ledger (daemon/usage.ts), if it has one. */
export interface UsageDeps {
  usage?: {
    rows: () => UsageRow[];
    /** Whether pi-ai has a price for `provider/modelId`. */
    priced: (model: string) => boolean;
    seeded: () => string | null;
  };
}

/** The rows of the usage page's period, from `since` up to `until` (ISO instants), with each model's price status. */
export function usageFrames({ usage }: UsageDeps): FrameHandlers {
  return {
    usage_get: ({ since, until }) => {
      if (!usage) return reply<UsageReply>({ rows: [], priced: {}, seeded_until: null });
      // A row is an hour; one that starts before `since` but ends after it is part of the period.
      const from = new Date(Date.parse(since)).toISOString().slice(0, 13);
      const rows = usage.rows().filter((r) => r.hour.slice(0, 13) >= from && r.hour < until);
      const priced = Object.fromEntries([...new Set(rows.map((r) => r.model))].map((m) => [m, usage.priced(m)]));
      return reply<UsageReply>({ rows, priced, seeded_until: usage.seeded() });
    },
  };
}
