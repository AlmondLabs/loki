import { useEffect, useEffectEvent, useState } from "react";
import { summarize, type UsageFilter, type UsageReply, type UsageSummary } from "../../../core/usage.ts";
import { PERIODS, modelName, originName, periodStart, type UsagePeriod } from "./usage-words";

/** What a usage page asks of the mod, on the Mac or the phone, and the agents' names for its breakdown. */
export interface UsageApi {
  /** The ledger's rows from `since` up to `until` (ISO instants), or null when the mod did not answer. */
  get: (since: string, until: string) => Promise<UsageReply | null>;
  /** Bumped when the ledger counts more, so the page refetches. */
  version: number;
  agents: ReadonlyArray<{ id: string; name: string }>;
}

const PERIOD_KEY = "loki.usagePeriod";

/** The period last shown on this device, 7 days the first time (or where storage is refused). */
function savedPeriod(): UsagePeriod {
  try {
    const v = localStorage.getItem(PERIOD_KEY);
    return PERIODS.find((p) => p === v) ?? "7d";
  } catch {
    return "7d";
  }
}

/**
 * A usage page's state: the period (remembered on this device), the line it is narrowed to, and the period summed up
 * in the reader's time zone, or null until the mod answers (`failed` when it did not). It reads the daemon's ledger
 * when the period changes and whenever the ledger says it counted more.
 */
export function useUsage(usage: UsageApi) {
  const [period, setPeriod] = useState<UsagePeriod>(savedPeriod);
  const [filter, setFilter] = useState<UsageFilter>({});
  const [data, setData] = useState<{ reply: UsageReply; since: number; until: number } | null>(null);
  const [failed, setFailed] = useState(false);

  const pick = (p: UsagePeriod) => {
    setPeriod(p);
    try {
      localStorage.setItem(PERIOD_KEY, p);
    } catch {
      // the choice holds for this visit
    }
  };

  const load = useEffectEvent((gone: () => boolean) => {
    const until = Date.now();
    const since = periodStart(period, until);
    void usage.get(new Date(since).toISOString(), new Date(until).toISOString()).then((reply) => {
      if (gone()) return;
      setFailed(reply === null);
      if (reply) setData({ reply, since, until });
    });
  });
  useEffect(() => {
    let gone = false;
    load(() => gone);
    return () => {
      gone = true;
    };
  }, [period, usage.version]);

  const summary: UsageSummary | null = data
    ? summarize(data.reply.rows, {
        since: data.since,
        until: data.until,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        resolution: period === "24h" ? "hour" : "day",
        priced: data.reply.priced,
        filter,
      })
    : null;
  const agentName = (id: string) => usage.agents.find((a) => a.id === id)?.name ?? id;
  return {
    period,
    pick,
    filter,
    setFilter,
    failed,
    summary,
    /** Whether pi-ai has a price for a model in the period. */
    priced: (model: string) => data?.reply.priced[model] === true,
    /** History before this instant has no cost split by token type (null before the seed). */
    seededUntil: data?.reply.seeded_until ?? null,
    agentName,
    /** The line the page is narrowed to, by its name, or null when it shows everything. */
    narrowed: filter.agent_id ? agentName(filter.agent_id) : filter.origin ? originName(filter.origin) : filter.model ? modelName(filter.model) : null,
  };
}
