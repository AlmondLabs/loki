import { useEffect, useEffectEvent, useState } from "react";
import { summarize, type UsageFilter, type UsageReply, type UsageSummary } from "../../../core/usage.ts";
import { PERIODS, modelName, originName, periodStart, type UsagePeriod } from "./usage-words";

export interface UsageApi {
  get: (since: string, until: string) => Promise<UsageReply | null>;
  version: number;
  agents: ReadonlyArray<{ id: string; name: string }>;
}

const PERIOD_KEY = "loki.usagePeriod";

function savedPeriod(): UsagePeriod {
  try {
    const v = localStorage.getItem(PERIOD_KEY);
    return PERIODS.find((p) => p === v) ?? "7d";
  } catch {
    return "7d";
  }
}

export function useUsage(usage: UsageApi) {
  const [period, setPeriod] = useState<UsagePeriod>(savedPeriod);
  const [filter, setFilter] = useState<UsageFilter>({});
  const [data, setData] = useState<{ reply: UsageReply; since: number; until: number } | null>(null);
  const [failed, setFailed] = useState(false);

  const pick = (p: UsagePeriod) => {
    setPeriod(p);
    try {
      localStorage.setItem(PERIOD_KEY, p);
    } catch {}
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
    priced: (model: string) => data?.reply.priced[model] === true,
    seededUntil: data?.reply.seeded_until ?? null,
    agentName,
    narrowed: filter.agent_id ? agentName(filter.agent_id) : filter.origin ? originName(filter.origin) : filter.model ? modelName(filter.model) : null,
  };
}
