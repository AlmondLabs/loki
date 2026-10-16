import type { UsageLine, UsageOrigin, UsageSummary } from "../../../core/usage.ts";
import { Chip, Row } from "../components";
import { PERIOD_LABELS, PERIODS, modelName, money, originName, shareText, tokenCount, type UsagePeriod } from "../shared/usage-words";
import { UsageBars } from "../shared/usage-bars";
import { useUsage, type UsageApi } from "../shared/use-usage";
import { Choice, Fact, Section } from "./layout";

export type { UsageApi } from "../shared/use-usage";

/**
 * Settings › usage: what the agents cost over a period, from the daemon's usage ledger (daemon/usage.ts). The figures
 * are estimates at each provider's API prices; a subscription sign-in is billed by its plan. Choosing a line of a
 * breakdown narrows the page to it.
 */
export function UsagePage({ usage }: { usage: UsageApi }) {
  const { period, pick, setFilter, failed, summary, priced, seededUntil, agentName, narrowed } = useUsage(usage);
  if (!summary) return <Section title="Usage">{<Fact label="Ledger" value={failed ? "loki's daemon did not answer" : "loading…"} />}</Section>;
  return (
    <>
      <SpendSection summary={summary} period={period} onPeriod={pick} narrowed={narrowed} onShowAll={() => setFilter({})} seededUntil={seededUntil} />
      <TokensSection summary={summary} />
      <Section title="By origin" hint="your chats, the helpers they started, and loki's background passes">
        <Breakdown lines={summary.by_origin} name={originName} priced={() => true} onPick={(key) => setFilter({ origin: key as UsageOrigin })} />
      </Section>
      <Section title="By agent">
        <Breakdown lines={summary.by_agent} name={agentName} priced={() => true} onPick={(key) => setFilter({ agent_id: key })} />
      </Section>
      <Section title="By model">
        <Breakdown lines={summary.by_model} name={modelName} priced={priced} onPick={(key) => setFilter({ model: key })} />
      </Section>
    </>
  );
}

/** The period, what it cost, a bar a day, and what the estimate leaves out or cannot split. */
function SpendSection({
  summary,
  period,
  onPeriod,
  narrowed,
  onShowAll,
  seededUntil,
}: {
  summary: UsageSummary;
  period: UsagePeriod;
  onPeriod: (p: UsagePeriod) => void;
  narrowed: string | null;
  onShowAll: () => void;
  seededUntil: string | null;
}) {
  const hourly = period === "24h";
  return (
    <Section title="Spend" hint="estimated at each provider's API prices; a subscription sign-in is billed by its plan, not by these">
      <Fact label="Period" value={<Choice options={[...PERIODS]} value={period} onPick={onPeriod} labels={PERIOD_LABELS} />} />
      {narrowed && (
        <Fact
          label="Showing"
          value={
            <Chip label active onClick={onShowAll} aria-label={`Show everything, not only ${narrowed}`}>
              {narrowed} ×
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
      <Fact label={hourly ? "By hour" : "By day"} value={<UsageBars series={summary.series} hourly={hourly} />} />
      {summary.unpriced_tokens > 0 && (
        <Fact label="No price" value={`${tokenCount(summary.unpriced_tokens)} tokens from models with no known price, left out of the estimate`} />
      )}
      {summary.cost.other > 0 && seededUntil !== null && (
        <Fact
          label="Before"
          value={`${new Date(seededUntil).toLocaleDateString(undefined, { month: "short", day: "numeric" })}, cost comes from loki's analytics and is not split by token type`}
        />
      )}
    </Section>
  );
}

/** Tokens and their cost by type, what could not be split, and what the cache saved. */
function TokensSection({ summary }: { summary: UsageSummary }) {
  const { tokens, cost } = summary;
  return (
    <Section title="Tokens" hint="what was sent fresh, read from the provider's cache or written to it, and what the model wrote back">
      <Fact label="Input" value={<Amount tokens={tokens.input} cost={cost.input} />} />
      <Fact label="Cache read" value={<Amount tokens={tokens.cache_read} cost={cost.cache_read} />} />
      <Fact label="Cache write" value={<Amount tokens={tokens.cache_write} cost={cost.cache_write} />} />
      <Fact
        label="Output"
        value={<Amount tokens={tokens.output} cost={cost.output} note={tokens.reasoning > 0 ? `${tokenCount(tokens.reasoning)} of it reasoning` : null} />}
      />
      {cost.other > 0 && <Fact label="Not split" value={money(cost.other)} />}
      <Fact label="Cache saved" value={`${money(summary.cache_savings)} against paying for the cache reads as fresh input`} />
    </Section>
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
