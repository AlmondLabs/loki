import { useEffect, useEffectEvent, useState } from "react";
import { summarize, type UsageFilter, type UsageLine, type UsageOrigin, type UsagePoint, type UsageReply } from "../../../core/usage.ts";
import { Chip, Row } from "../components";
import { PERIOD_LABELS, PERIODS, modelName, money, originName, periodStart, shareText, tokenCount, type UsagePeriod } from "../shared/usage-words";
import { Choice, Fact, Section } from "./layout";

/** What Settings › usage asks of the mod, and the agents' names for its breakdown. */
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

/** The reader's own time zone, which the days and hours are counted in. */
const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Settings › usage: what the agents cost over a period, from the daemon's usage ledger (daemon/usage.ts). The figures
 * are estimates at each provider's API prices; a subscription sign-in is billed by its plan. Choosing a line of a
 * breakdown narrows the page to it.
 */
export function UsagePage({ usage }: { usage: UsageApi }) {
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
  // The ledger is the daemon's: read it when the period changes and whenever it says it counted more.
  useEffect(() => {
    let gone = false;
    load(() => gone);
    return () => {
      gone = true;
    };
  }, [period, usage.version]);

  if (!data) return <Section title="Usage">{<Fact label="Ledger" value={failed ? "loki's daemon did not answer" : "loading…"} />}</Section>;

  const summary = summarize(data.reply.rows, {
    since: data.since,
    until: data.until,
    timeZone: timeZone(),
    resolution: period === "24h" ? "hour" : "day",
    priced: data.reply.priced,
    filter,
  });
  const agentName = (id: string) => usage.agents.find((a) => a.id === id)?.name ?? id;
  const seededUntil = data.reply.seeded_until;
  const unsplit = summary.cost.other > 0 && seededUntil !== null;
  const narrowed = filter.agent_id ?? filter.origin ?? filter.model;
  const narrowedName = filter.agent_id ? agentName(filter.agent_id) : filter.origin ? originName(filter.origin) : filter.model ? modelName(filter.model) : "";

  return (
    <>
      <Section title="Spend" hint="estimated at each provider's API prices; a subscription sign-in is billed by its plan, not by these">
        <Fact label="Period" value={<Choice options={[...PERIODS]} value={period} onPick={pick} labels={PERIOD_LABELS} />} />
        {narrowed && (
          <Fact
            label="Showing"
            value={
              <Chip label active onClick={() => setFilter({})} aria-label={`Show everything, not only ${narrowedName}`}>
                {narrowedName} ×
              </Chip>
            }
          />
        )}
        <Fact
          label="Estimated"
          value={
            <span style={{ display: "inline-flex", alignItems: "baseline", gap: 10 }}>
              <span style={{ fontSize: 22, fontWeight: 700 }}>{money(summary.cost.total)}</span>
              <span className="loki-meta">{tokenCount(summary.tokens.total)} tokens</span>
            </span>
          }
        />
        <Fact label={period === "24h" ? "By hour" : "By day"} value={<Bars series={summary.series} hourly={period === "24h"} />} />
        {summary.unpriced_tokens > 0 && (
          <Fact label="No price" value={`${tokenCount(summary.unpriced_tokens)} tokens from models with no known price, left out of the estimate`} />
        )}
        {unsplit && (
          <Fact
            label="Before"
            value={`${new Date(seededUntil).toLocaleDateString(undefined, { month: "short", day: "numeric" })}, cost comes from loki's analytics and is not split by token type`}
          />
        )}
      </Section>
      <Section title="Tokens" hint="what was sent fresh, read from the provider's cache or written to it, and what the model wrote back">
        <Fact label="Input" value={<Amount tokens={summary.tokens.input} cost={summary.cost.input} />} />
        <Fact label="Cache read" value={<Amount tokens={summary.tokens.cache_read} cost={summary.cost.cache_read} />} />
        <Fact label="Cache write" value={<Amount tokens={summary.tokens.cache_write} cost={summary.cost.cache_write} />} />
        <Fact
          label="Output"
          value={
            <Amount
              tokens={summary.tokens.output}
              cost={summary.cost.output}
              note={summary.tokens.reasoning > 0 ? `${tokenCount(summary.tokens.reasoning)} of it reasoning` : null}
            />
          }
        />
        {summary.cost.other > 0 && <Fact label="Not split" value={money(summary.cost.other)} />}
        <Fact label="Cache saved" value={`${money(summary.cache_savings)} against paying for the cache reads as fresh input`} />
      </Section>
      <Section title="By origin" hint="your chats, the helpers they started, and loki's background passes">
        <Breakdown lines={summary.by_origin} name={originName} priced={() => true} onPick={(key) => setFilter({ origin: key as UsageOrigin })} />
      </Section>
      <Section title="By agent">
        <Breakdown lines={summary.by_agent} name={agentName} priced={() => true} onPick={(key) => setFilter({ agent_id: key })} />
      </Section>
      <Section title="By model">
        <Breakdown lines={summary.by_model} name={modelName} priced={(key) => data.reply.priced[key] === true} onPick={(key) => setFilter({ model: key })} />
      </Section>
    </>
  );
}

/** Tokens, and what they cost. */
function Amount({ tokens, cost, note = null }: { tokens: number; cost: number; note?: string | null }) {
  return (
    <span>
      {tokenCount(tokens)}
      <span className="loki-meta" style={{ marginLeft: 8 }}>
        {money(cost)}
        {note ? ` · ${note}` : ""}
      </span>
    </span>
  );
}

/** The period's bars, each a day (or an hour), its height its cost, or its tokens when nothing had a cost. */
function Bars({ series, hourly }: { series: UsagePoint[]; hourly: boolean }) {
  const byCost = series.some((p) => p.cost > 0);
  const value = (p: UsagePoint) => (byCost ? p.cost : p.tokens);
  const top = Math.max(...series.map(value), 0);
  const day = (bucket: string, weekday: boolean) =>
    new Date(`${bucket.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(weekday ? { weekday: "short" } : {}) });
  // An hour says its day too: a day's bars run from one midnight to the next.
  const label = (bucket: string) => (hourly ? `${day(bucket, false)}, ${bucket.slice(11)}:00` : day(bucket, series.length <= 7));
  return (
    <div role="img" aria-label={`${byCost ? "Cost" : "Tokens"} by ${hourly ? "hour" : "day"}`} style={{ display: "grid", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 64 }}>
        {series.map((p) => (
          <div
            key={p.bucket}
            title={`${label(p.bucket)}: ${money(p.cost)} · ${tokenCount(p.tokens)} tokens`}
            style={{
              flex: 1,
              minWidth: 2,
              height: top > 0 ? `${Math.max(value(p) > 0 ? 4 : 0, (value(p) / top) * 100)}%` : 0,
              background: "var(--loki-accent)",
              borderRadius: "var(--loki-radius-sm)",
            }}
          />
        ))}
      </div>
      {series.length > 0 && (
        <div className="loki-meta" style={{ display: "flex", justifyContent: "space-between" }}>
          <span>{label(series[0].bucket)}</span>
          <span>{label(series[series.length - 1].bucket)}</span>
        </div>
      )}
    </div>
  );
}

/** A breakdown's lines, costliest first: a name, its share as a bar, its cost and tokens. Choosing one narrows the page. */
function Breakdown({
  lines,
  name,
  priced,
  onPick,
}: {
  lines: UsageLine[];
  name: (key: string) => string;
  priced: (key: string) => boolean;
  onPick: (key: string) => void;
}) {
  if (lines.length === 0) return <Fact label="Nothing" value="no calls in this period" />;
  // A line of tokens with no cost at all was spent on models with no known price (an agent on a local model, say).
  const known = (l: UsageLine) => priced(l.key) && (l.cost > 0 || l.tokens === 0);
  return (
    <div style={{ display: "grid", gap: 2 }}>
      {lines.map((l) => (
        <Row key={l.key} dense onClick={() => onPick(l.key)} title={`Show only ${name(l.key)}`}>
          <span style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 80px 72px 64px", gap: 12, alignItems: "center", width: "100%", fontSize: 13.5 }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={l.key}>
              {name(l.key)}
            </span>
            <span aria-hidden style={{ height: 6, borderRadius: "var(--loki-radius-pill)", background: "var(--loki-hover)" }}>
              <span
                style={{
                  display: "block",
                  height: "100%",
                  width: `${Math.round(l.share * 100)}%`,
                  borderRadius: "var(--loki-radius-pill)",
                  background: "var(--loki-accent)",
                }}
              />
            </span>
            <span style={{ textAlign: "right" }}>{known(l) ? money(l.cost) : "no price"}</span>
            <span className="loki-meta" style={{ textAlign: "right" }}>
              {known(l) ? shareText(l.share) : tokenCount(l.tokens)}
            </span>
          </span>
        </Row>
      ))}
    </div>
  );
}
