import type { ReactNode } from "react";
import type { UsageLine, UsageOrigin } from "../../../core/usage.ts";
import { UsageBars } from "../shared/usage-bars";
import { useUsage, type UsageApi } from "../shared/use-usage";
import { PERIOD_LABELS, PERIODS, modelName, money, originName, shareText, tokenCount } from "../shared/usage-words";
import { FactRow, MenuRow, RowGroup } from "./rows";
import { BackButton, Scroll, TopBar } from "./ui";

/**
 * Usage, under More: the desktop's Preferences › Usage in the phone's grammar, one column of groups on hairlines. The
 * period, the estimate with its tokens and a bar a day, then what each origin, agent and model spent; tapping a line
 * narrows the screen to it. The figures are estimates at each provider's API prices.
 */
export function UsageScreen({ usage, banner, backLabel = "more", onBack }: { usage: UsageApi; banner?: ReactNode; backLabel?: string; onBack: () => void }) {
  const { period, pick, filter, setFilter, failed, summary, priced, agentName } = useUsage(usage);
  const narrowed = filter.agent_id ? agentName(filter.agent_id) : filter.origin ? originName(filter.origin) : filter.model ? modelName(filter.model) : null;
  return (
    <div className="loki-phone-page">
      <TopBar left={<BackButton onClick={onBack} label={backLabel} />} title="Usage" />
      {banner}
      <Scroll memory="usage" flush>
        <div className="loki-phone-groups">
          <RowGroup title="Period" radio>
            {PERIODS.map((p) => (
              <MenuRow
                key={p}
                icon="clock"
                label={PERIOD_LABELS[p][0].toUpperCase() + PERIOD_LABELS[p].slice(1)}
                checked={period === p}
                onClick={() => pick(p)}
              />
            ))}
          </RowGroup>
          {!summary ? (
            <p className="loki-phone-group-note">{failed ? "The Mac did not answer." : "Loading…"}</p>
          ) : (
            <>
              {narrowed && (
                <RowGroup title="Showing">
                  <MenuRow icon="close" label={`Only ${narrowed}`} aside="Show all" onClick={() => setFilter({})} />
                </RowGroup>
              )}
              <RowGroup title="Estimated">
                <FactRow label="Cost" value={money(summary.cost.total)} />
                <FactRow label="Tokens" value={tokenCount(summary.tokens.total)} />
                <FactRow label="Cache saved" value={money(summary.cache_savings)} />
                {summary.unpriced_tokens > 0 && <FactRow label="No price" value={`${tokenCount(summary.unpriced_tokens)} tokens`} />}
              </RowGroup>
              <div className="loki-phone-group-note">
                <UsageBars series={summary.series} hourly={period === "24h"} />
              </div>
              <Lines
                title="By origin"
                lines={summary.by_origin}
                name={originName}
                priced={() => true}
                onPick={(key) => setFilter({ origin: key as UsageOrigin })}
              />
              <Lines title="By agent" lines={summary.by_agent} name={agentName} priced={() => true} onPick={(key) => setFilter({ agent_id: key })} />
              <Lines title="By model" lines={summary.by_model} name={modelName} priced={priced} onPick={(key) => setFilter({ model: key })} />
              <p className="loki-phone-group-note">Estimated at each provider&apos;s API prices. A subscription sign-in is billed by its plan, not by these.</p>
            </>
          )}
        </div>
      </Scroll>
    </div>
  );
}

/** One breakdown as a group of rows, costliest first; a line of tokens with no cost was spent on unpriced models. */
function Lines({
  title,
  lines,
  name,
  priced,
  onPick,
}: {
  title: string;
  lines: UsageLine[];
  name: (key: string) => string;
  priced: (key: string) => boolean;
  onPick: (key: string) => void;
}) {
  if (lines.length === 0) return null;
  const known = (l: UsageLine) => priced(l.key) && (l.cost > 0 || l.tokens === 0);
  return (
    <RowGroup title={title}>
      {lines.map((l) => (
        <MenuRow
          key={l.key}
          icon="filter"
          label={name(l.key)}
          aside={known(l) ? `${money(l.cost)} · ${shareText(l.share)}` : `No price · ${tokenCount(l.tokens)}`}
          onClick={() => onPick(l.key)}
        />
      ))}
    </RowGroup>
  );
}
