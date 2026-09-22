import { useEffect, useState, type ReactNode } from "react";
import type { AgentDetails, AgentsApi } from "../agents/Agents";
import { AgentFace } from "../desk/AgentChip";
import { avatarUrl } from "../desk/env";
import type { DeskSummary } from "../desk/useDesk";
import { liveDeskCount, liveDesksLabel } from "./model";
import { navigate } from "./router";
import { Meta, Row } from "../components";
import { GUTTER, Scroll, TopBar } from "./ui";

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
 * The Agents tab: one row per agent the app-server lists — face, name, a line about it, its model,
 * how many desks are live. Everything here is read-only; the row opens the agent's page.
 */
export function Agents({ agents, loaded, desks, api, sub, banner }: { agents: Array<{ id: string; name: string }>; loaded: boolean; desks: DeskSummary[]; api: PhoneAgentsApi; sub?: ReactNode; banner?: ReactNode }) {
  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <TopBar title="Agents" sub={sub} />
      {banner}
      <Scroll style={{ padding: `4px ${GUTTER.right} 24px ${GUTTER.left}` }}>
        <ul aria-label="agents" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {agents.map((a) => (
            <AgentRow key={a.id} agent={a} api={api} live={liveDeskCount(desks, a.id)} />
          ))}
        </ul>
        {agents.length === 0 && <div style={{ padding: "32px 4px", fontSize: 13.5, color: "var(--loki-muted)", textAlign: "center" }}>{loaded ? "No agents yet. Make one in loki on the Mac." : "asking the Mac…"}</div>}
      </Scroll>
    </div>
  );
}

function AgentRow({ agent, api, live }: { agent: { id: string; name: string }; api: PhoneAgentsApi; live: number }) {
  const d = useAgentDetails(api, agent.id);
  const description = d?.agent.description ?? null;
  const model = d?.agent.model ?? null;
  return (
    <li style={{ borderBottom: "1px solid var(--loki-border)" }}>
      <Row touch onClick={() => navigate({ kind: "agent", agentId: agent.id })} style={{ alignItems: "flex-start", gap: 12, padding: `12px calc(12px + env(safe-area-inset-right, 0px)) 12px calc(12px + env(safe-area-inset-left, 0px))`, touchAction: "manipulation" }}>
        <AgentFace name={agent.name} src={avatarUrl(agent.id)} size={28} />
        <span style={{ flex: 1, minWidth: 0, display: "grid", gap: 4 }}>
          <span style={{ fontFamily: "var(--loki-display)", fontSize: 15, color: "var(--loki-fg)" }}>{d?.agent.name ?? agent.name}</span>
          {description && <span style={{ fontSize: 13.5, lineHeight: 1.45, color: "var(--loki-muted)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{description}</span>}
          {d === null && <span style={{ fontSize: 12, color: "var(--loki-muted)" }}>no local record on this Mac</span>}
          <Meta style={{ marginTop: 2 }}>
            {model ? `${model} · ` : ""}
            {liveDesksLabel(live)}
          </Meta>
        </span>
        <Chevron />
      </Row>
    </li>
  );
}

/** The "there is a page behind this row" chevron. */
export function Chevron() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="var(--loki-muted)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flex: "0 0 auto", alignSelf: "center" }}>
      <path d="m7.5 4 6 6-6 6" />
    </svg>
  );
}
