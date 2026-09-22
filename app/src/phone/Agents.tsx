import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import type { AgentDetails, AgentsApi } from "../agents/Agents";
import { ago } from "../board/model";
import { avatarUrl } from "../desk/env";
import type { DeskSummary } from "../desk/useDesk";
import { AGENT_FILTERS, agentLine, agentRows, agentsShown, type AgentFilter, type AgentRowModel, type LinkState } from "./model";
import { navigate } from "./router";
import { Avatar, PhoneRow } from "./rows";
import { Button, Chip } from "../components";
import { Scroll, TopBar } from "./ui";

/** What the phone reads about agents: the mod's `agent_get`, `memory_read`, `memory_log`, `memory_diff`. */
export type PhoneAgentsApi = Pick<AgentsApi, "get" | "read" | "log" | "diff">;

/**
 * Agent records, read once per session: the list and every page share them, so a page opened from
 * the list does not ask the Mac again. `null` is a firm "no local record"; absent means not asked yet.
 */
const cache = new Map<string, AgentDetails | null>();
const inflight = new Map<string, Promise<AgentDetails | null>>();
export function useAgentDetails(api: PhoneAgentsApi, agentId: string | null): AgentDetails | null | undefined {
  const [d, setD] = useState<AgentDetails | null | undefined>(() => (agentId ? cache.get(agentId) : undefined));
  useEffect(() => {
    if (!agentId) return;
    const hit = cache.get(agentId);
    if (hit !== undefined) {
      setD(hit);
      return;
    }
    let live = true;
    let p = inflight.get(agentId);
    if (!p) {
      p = api.get(agentId).then((r) => {
        cache.set(agentId, r);
        inflight.delete(agentId);
        return r;
      });
      inflight.set(agentId, p);
    }
    void p.then((r) => live && setD(r));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);
  return d;
}

/**
 * The filter chosen on the Agents tab, kept for the session like the records: the tab mounts afresh each
 * visit, and its place in the list comes back from the scroll memory, so its filter comes back from here.
 */
const kept = new Map<"filter", AgentFilter>();

/**
 * The Agents tab, Slack's DM list with loki's agents: one avatar-led row each — its name (bold while
 * something of it waits on you), what it is doing and who it is on one line, when its memory last
 * changed, the count waiting on you as the badge, and a presence dot while a turn runs. Chips narrow the
 * list to the agents running or waiting on you. A row opens the agent's profile; the list's place and the
 * filter survive the trip.
 */
export function Agents({ agents, loaded, link, desks, items, api, banner }: { agents: Array<{ id: string; name: string }>; loaded: boolean; link: LinkState; desks: DeskSummary[]; items: AttentionItem[]; api: PhoneAgentsApi; banner?: ReactNode }) {
  const [filter, setFilterState] = useState<AgentFilter>(() => kept.get("filter") ?? "all");
  const setFilter = (f: AgentFilter) => {
    kept.set("filter", f);
    setFilterState(f);
  };
  const rows = useMemo(() => agentRows(agents, desks, items), [agents, desks, items]);
  const shown = agentsShown(rows, filter);
  const running = rows.filter((r) => r.running).length;
  return (
    <div className="loki-phone-page">
      <TopBar title="Agents" sub={rows.length ? <span>{rows.length === 1 ? "1 agent" : `${rows.length} agents`}{running ? ` · ${running} running` : ""}</span> : undefined} />
      {banner}
      <Scroll memory="agents" flush>
        {rows.length > 0 && (
          <div role="group" aria-label="Show" className="loki-phone-chips loki-phone-filter">
            {AGENT_FILTERS.map((f) => (
              <Chip key={f.id} touch active={filter === f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                {f.label}
              </Chip>
            ))}
          </div>
        )}
        <ul aria-label="agents" className="loki-phone-list">
          {shown.map((r) => (
            <AgentRow key={r.id} row={r} api={api} />
          ))}
        </ul>
        {rows.length === 0 ? (
          !loaded ? (
            <p className="loki-phone-empty">{link === "offline" ? "The Mac is unreachable. Agents show once it answers." : "Asking the Mac…"}</p>
          ) : (
            <div className="loki-phone-empty">
              <p className="loki-phone-headline">No agents yet</p>
              <p>Make one in loki on the Mac; it shows here at once.</p>
            </div>
          )
        ) : (
          shown.length === 0 && (
            <div className="loki-phone-empty">
              <p>{filter === "running" ? "No agent is working right now." : "Nothing waits on you."}</p>
              <Button size="touch" tone="paper" onClick={() => setFilter("all")}>
                Show all agents
              </Button>
            </div>
          )
        )}
      </Scroll>
    </div>
  );
}

/** One agent: its record (description, last memory change) arrives from the shared cache and fills the row in. */
function AgentRow({ row, api }: { row: AgentRowModel; api: PhoneAgentsApi }) {
  const d = useAgentDetails(api, row.id);
  const name = d?.agent.name ?? row.name;
  const line = d === null ? agentLine(row, "No local record on this Mac") : agentLine(row, d?.agent.description);
  return (
    <PhoneRow
      lead={<Avatar name={name} src={avatarUrl(row.id)} presence={row.running} />}
      title={name}
      preview={line}
      time={d?.lastCommit ? ago(d.lastCommit.at) : null}
      badge={row.waiting || null}
      unread={row.waiting > 0}
      label={`${name}, ${line}`}
      launch={`agent:${row.id}`}
      onOpen={() => navigate({ kind: "agent", agentId: row.id })}
    />
  );
}
