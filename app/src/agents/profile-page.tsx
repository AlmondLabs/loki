import type { MacIdentity } from "../../../core/frame-types.ts";
import { useEffect, useEffectEvent, useMemo, useState } from "react";

import { AgentFace } from "../desk/agent-chip";
import { Button, Field, Row, Switch } from "../components";
import type { McpApi } from "../settings/mcp";
import { OwnedAccounts, type AccountsApi, type AgentName } from "../settings/accounts";
import type { McpView } from "../../../core/frame-types.ts";

import { ago } from "../shared/ago";
import { Head } from "./bits";
import { keyFor } from "../shell/keymap";
import type { AgentDetails, AgentEdit } from "./types";
import type { DeskSummary } from "../../../core/frame-types.ts";

/** The profile page: who the agent is (editable), where it is working (its chats), and the way out. */
export function ProfilePage({
  d,
  selected,
  avatar,
  models,
  onLoadModels,
  onSave,
  desks,
  onOpenDesk,
  onShowDesks,
  mcp,
  accounts,
  macs,
  confirmDelete,
  setConfirmDelete,
  onRemove,
}: {
  d: AgentDetails;
  selected: string;
  avatar: string;
  models: string[] | null;
  onLoadModels: () => void;
  onSave: (body: AgentEdit) => Promise<void>;
  desks: DeskSummary[];
  onOpenDesk: (agentId: string, conversationId: string) => void;
  onShowDesks: () => void;
  mcp?: Pick<McpApi, "get" | "agent">;
  /** The Inbox accounts and every agent, so a delete first moves or disconnects the accounts this agent owns (plan 067, R4). */
  accounts?: { api: AccountsApi; agents: readonly AgentName[] };
  /** This Mac first, then the Macs paired with it (plan 023); with more than one, the agent's home can be changed. */
  macs?: MacIdentity[];
  confirmDelete: boolean;
  setConfirmDelete: (v: boolean) => void;
  onRemove: () => Promise<void>;
}) {
  const myDesks = useMemo(() => desks.filter((x) => x.agent_id === selected && x.status === "live"), [desks, selected]);
  return (
    <div className="min-w-0" style={{ minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "24px 20px 32px" }}>
      <div className="grid gap-6" style={{ maxWidth: 760 }}>
        <Identity d={d} avatar={avatar} models={models} onLoadModels={onLoadModels} onSave={onSave} macs={macs} />
        <DesksSection myDesks={myDesks} onOpen={(conversationId) => onOpenDesk(selected, conversationId)} onShowDesks={onShowDesks} />
        {mcp && <McpSection key={selected} agentId={selected} mcp={mcp} />}
        <div style={{ paddingTop: 8 }}>
          {confirmDelete ? (
            <ConfirmDelete d={d} myDesks={myDesks} accounts={accounts} onRemove={onRemove} onKeep={() => setConfirmDelete(false)} />
          ) : (
            <Button tone="negative" onClick={() => setConfirmDelete(true)}>
              Delete Agent…
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function DesksSection({ myDesks, onOpen, onShowDesks }: { myDesks: DeskSummary[]; onOpen: (conversationId: string) => void; onShowDesks: () => void }) {
  return (
    <section>
      <Head>
        Chats <span style={{ marginLeft: "auto", fontWeight: 400 }}>{myDesks.length ? `${myDesks.length} live` : ""}</span>
      </Head>
      {myDesks.length === 0 && (
        <div className="loki-meta loki-meta--wrap" style={{ padding: "0 8px" }}>
          No live chats
        </div>
      )}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-0.5">
        {myDesks.map((x) => (
          <Row
            dense
            key={x.scope}
            onClick={() => onOpen(x.conversation_id ?? "default")}
            className="justify-between"
            style={{ fontSize: "var(--loki-text-body)" }}
          >
            <span className="loki-truncate">{x.title ?? "Main chat"}</span>
            <span className="loki-meta loki-meta--wrap flex-none">{x.active ? "Active" : x.last_active ? ago(x.last_active) : ""}</span>
          </Row>
        ))}
      </div>
      <div className="flex gap-2" style={{ padding: "8px 8px 0" }}>
        <Button tone="brass" onClick={() => onOpen("default")}>
          Main Chat
        </Button>
        <Button onClick={onShowDesks} kbd={keyFor("segment.desk")}>
          Chats
        </Button>
      </div>
    </section>
  );
}

/**
 * The last step before deleting: what closes (live desks), and the accounts the agent owns, each to move or disconnect
 * before it can go (plan 067, R4). A refused delete asks for the accounts again, so one connected meanwhile shows too.
 */
function ConfirmDelete({
  d,
  myDesks,
  accounts,
  onRemove,
  onKeep,
}: {
  d: AgentDetails;
  myDesks: DeskSummary[];
  accounts?: { api: AccountsApi; agents: readonly AgentName[] };
  onRemove: () => Promise<void>;
  onKeep: () => void;
}) {
  const [asked, setAsked] = useState(0);
  const [owned, setOwned] = useState(0);
  const remove = async () => {
    await onRemove();
    setAsked((n) => n + 1);
  };
  return (
    <div
      role="alertdialog"
      aria-label={`Delete ${d.agent.name}`}
      className="grid gap-2"
      style={{
        padding: 12,
        border: "1px solid var(--loki-negative)",
        borderRadius: "var(--loki-radius-md)",
        fontSize: "var(--loki-text-meta)",
        color: "var(--loki-fg)",
        lineHeight: 1.5,
      }}
    >
      <span>
        Delete <b>{d.agent.name}</b> and its memory.{" "}
        {myDesks.length
          ? `${myDesks.length} live chat${myDesks.length === 1 ? "" : "s"} (${myDesks
              .slice(0, 3)
              .map((x) => x.title ?? "Main chat")
              .join(", ")}${myDesks.length > 3 ? ", …" : ""}) close.`
          : ""}
      </span>
      {accounts && <OwnedAccounts api={accounts.api} agentId={d.agent.id} agents={accounts.agents} asked={asked} onOwned={setOwned} />}
      <div className="flex gap-2">
        <Button tone="negative" disabled={owned > 0} onClick={() => void remove()}>
          Delete {d.agent.name}
        </Button>
        <Button onClick={onKeep}>Keep</Button>
      </div>
    </div>
  );
}

function Identity({
  d,
  avatar,
  models,
  onLoadModels,
  onSave,
  macs = [],
}: {
  macs?: MacIdentity[];
  d: AgentDetails;
  avatar: string;
  models: string[] | null;
  onLoadModels: () => void;
  onSave: (body: AgentEdit) => Promise<void>;
}) {
  const [name, setName] = useState(d.agent.name);
  const [description, setDescription] = useState(d.agent.description ?? "");
  const [model, setModel] = useState(d.agent.model ?? "");
  const [shownD, setShownD] = useState(d);
  if (shownD !== d) {
    setShownD(d);
    setName(d.agent.name);
    setDescription(d.agent.description ?? "");
    setModel(d.agent.model ?? "");
  }
  const settings = d.agent.model_settings;
  const bits = [
    typeof settings.reasoning_effort === "string" ? `effort ${settings.reasoning_effort}` : null,
    settings.context_window_limit ? `${contextSize(Number(settings.context_window_limit))} context` : null,
  ].filter(Boolean);
  return (
    <section className="grid grid-cols-[64px_1fr] items-start gap-3">
      <AgentFace name={d.agent.name} src={avatar} size={64} />
      <div className="grid min-w-0 gap-1">
        <Field
          inline
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name.trim() !== d.agent.name && void onSave({ name: name.trim() })}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          aria-label="Agent name"
          style={{ fontSize: "var(--loki-text-display)", fontWeight: 700 }}
        />
        <Field
          inline
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => description.trim() !== (d.agent.description ?? "") && void onSave({ description: description.trim() })}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          placeholder="A line about this agent"
          aria-label="Agent description"
          style={{ fontSize: "var(--loki-text-body)", color: "var(--loki-muted)" }}
        />
        <div className="loki-meta loki-meta--wrap flex flex-wrap items-center gap-2" style={{ marginTop: 4 }}>
          <Field
            inline
            mono
            list="loki-models"
            value={model}
            onFocus={onLoadModels}
            onChange={(e) => setModel(e.target.value)}
            onBlur={() => model.trim() && model.trim() !== (d.agent.model ?? "") && void onSave({ model: model.trim() })}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            aria-label="Model"
            style={{ width: 240, fontSize: "var(--loki-text-meta)" }}
          />
          <datalist id="loki-models">
            {(models ?? []).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {bits.map((b) => (
            <span key={b}>· {b}</span>
          ))}
          {d.agent.favourite && <span style={{ color: "var(--loki-accent)" }}>· ★ favourite</span>}
        </div>
        {macs.length > 1 && (
          <label className="loki-meta loki-meta--wrap flex items-center gap-2">
            Lives on
            <select
              aria-label="The Mac this agent lives on"
              value={d.agent.home_mac ?? macs[0].mac_id}
              onChange={(e) => void onSave({ home_mac: e.target.value })}
              style={{ font: "inherit", color: "var(--loki-fg)" }}
            >
              {macs.map((m) => (
                <option key={m.mac_id} value={m.mac_id}>
                  {m.name}
                </option>
              ))}
            </select>
            <span>· new chats start there</span>
          </label>
        )}
      </div>
    </section>
  );
}

/** A context window as people say it: 200k, 1M. */
function contextSize(tokens: number): string {
  return tokens >= 1_000_000 ? `${Math.round(tokens / 100_000) / 10}M` : `${Math.round(tokens / 1000)}k`;
}

/**
 * The MCP servers this agent can use, each switched on or off for it alone; its chats follow from their next message.
 * Servers are added in Preferences › MCP servers.
 */
function McpSection({ agentId, mcp }: { agentId: string; mcp: Pick<McpApi, "get" | "agent"> }) {
  const [view, setView] = useState<McpView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const apply = (r: McpView | string) => (typeof r === "string" ? setError(r) : (setError(null), setView(r)));
  const load = useEffectEvent(() => void mcp.get().then(apply));
  useEffect(() => load(), []);
  if (!view?.servers.length && !error) return null;
  return (
    <section>
      <Head>MCP servers</Head>
      {error && (
        <div className="loki-meta loki-meta--negative loki-meta--wrap" style={{ padding: "0 8px" }}>
          {error}
        </div>
      )}
      <div className="grid gap-1.5" style={{ padding: "0 8px" }}>
        {view?.servers.map((s) => {
          const on = !s.off_for.includes(agentId);
          return (
            <div key={s.name} className="flex items-center gap-2">
              <Switch on={on} onToggle={() => void mcp.agent(agentId, s.name, !on).then(apply)} label={s.entry} small />
              <span className="loki-meta">{s.state === "connected" ? `${s.tools.length} tools` : s.state}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
