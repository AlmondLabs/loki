import type { MacIdentity } from "../../../core/frame-types.ts";
import { useEffect, useEffectEvent, useMemo, useState } from "react";

import { AgentFace } from "../desk/agent-chip";
import { Button, Field, Row, Switch } from "../components";
import type { McpApi } from "../settings/mcp";
import type { McpView } from "../../../core/frame-types.ts";

import { ago } from "../shared/ago";
import { Head } from "./bits";
import { keyFor } from "../shell/keymap";
import type { AgentDetails, AgentEdit } from "./types";
import type { DeskSummary, Task } from "../../../core/frame-types.ts";

/** The profile page: who the agent is (editable), where it is working (desks, tasks), and the way out. */
export function ProfilePage({
  d,
  selected,
  avatar,
  models,
  onLoadModels,
  onSave,
  desks,
  tasks,
  onOpenDesk,
  onShowDesks,
  onShowTasks,
  mcp,
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
  tasks: Task[] | null;
  onOpenDesk: (agentId: string, conversationId: string) => void;
  onShowDesks: () => void;
  onShowTasks: () => void;
  mcp?: Pick<McpApi, "get" | "agent">;
  /** This Mac first, then the Macs paired with it (plan 023); with more than one, the agent's home can be changed. */
  macs?: MacIdentity[];
  confirmDelete: boolean;
  setConfirmDelete: (v: boolean) => void;
  onRemove: () => Promise<void>;
}) {
  const myDesks = useMemo(() => desks.filter((x) => x.agent_id === selected && x.status === "live"), [desks, selected]);
  const myTasks = useMemo(
    () => (tasks ?? []).filter((t) => t.status !== "closed" && (t.metadata.assigned_agent_id === selected || t.assignee === d.agent.name)),
    [tasks, selected, d],
  );
  return (
    <div style={{ minWidth: 0, minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "22px 28px 32px" }}>
      <div style={{ maxWidth: 760, display: "grid", gap: 28 }}>
        <Identity d={d} avatar={avatar} models={models} onLoadModels={onLoadModels} onSave={onSave} macs={macs} />
        <DesksSection myDesks={myDesks} onOpen={(conversationId) => onOpenDesk(selected, conversationId)} onShowDesks={onShowDesks} />
        <TasksSection count={myTasks.length} onShowTasks={onShowTasks} />
        {mcp && <McpSection key={selected} agentId={selected} mcp={mcp} />}
        <div style={{ paddingTop: 8 }}>
          {confirmDelete ? (
            <ConfirmDelete d={d} myDesks={myDesks} taskCount={myTasks.length} onRemove={onRemove} onKeep={() => setConfirmDelete(false)} />
          ) : (
            <Button tone="negative" onClick={() => setConfirmDelete(true)}>
              delete this agent…
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
        Desks <span style={{ marginLeft: "auto", fontWeight: 400 }}>{myDesks.length ? `${myDesks.length} live` : ""}</span>
      </Head>
      {myDesks.length === 0 && (
        <div className="loki-meta loki-meta--wrap" style={{ padding: "0 8px" }}>
          no live chats
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 2 }}>
        {myDesks.map((x) => (
          <Row dense key={x.scope} onClick={() => onOpen(x.conversation_id ?? "default")} style={{ justifyContent: "space-between", fontSize: 13.5 }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.title ?? "main chat"}</span>
            <span className="loki-meta loki-meta--wrap" style={{ flex: "0 0 auto" }}>
              {x.active ? "active" : x.last_active ? ago(x.last_active) : ""}
            </span>
          </Row>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, padding: "8px 8px 0" }}>
        <Button tone="brass" onClick={() => onOpen("default")}>
          main chat
        </Button>
        <Button onClick={onShowDesks} kbd={keyFor("segment.desk")}>
          chats
        </Button>
      </div>
    </section>
  );
}

function TasksSection({ count, onShowTasks }: { count: number; onShowTasks: () => void }) {
  return (
    <section>
      <Head>
        Tasks <span style={{ marginLeft: "auto", fontWeight: 400 }}>{count ? `${count} open` : ""}</span>
      </Head>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 8px", fontSize: 13.5, color: "var(--loki-muted)" }}>
        <span>{count === 0 ? "nothing assigned" : `${count} assigned in Tasks`}</span>
        <Button onClick={onShowTasks} kbd={keyFor("segment.tasks")}>
          tasks
        </Button>
      </div>
    </section>
  );
}

/** The last step before deleting: what closes (live desks) and what stays (open tasks, unassigned). */
function ConfirmDelete({
  d,
  myDesks,
  taskCount,
  onRemove,
  onKeep,
}: {
  d: AgentDetails;
  myDesks: DeskSummary[];
  taskCount: number;
  onRemove: () => Promise<void>;
  onKeep: () => void;
}) {
  return (
    <div
      role="alertdialog"
      aria-label={`delete ${d.agent.name}`}
      style={{
        display: "grid",
        gap: 8,
        padding: "10px 12px",
        border: "1px solid var(--loki-negative)",
        borderRadius: "var(--loki-radius-md)",
        fontSize: 12,
        color: "var(--loki-fg)",
        lineHeight: 1.5,
      }}
    >
      <span>
        Delete <b>{d.agent.name}</b> and its memory.{" "}
        {myDesks.length
          ? `${myDesks.length} live chat${myDesks.length === 1 ? "" : "s"} (${myDesks
              .slice(0, 3)
              .map((x) => x.title ?? "main chat")
              .join(", ")}${myDesks.length > 3 ? ", …" : ""}) close.`
          : ""}
        {taskCount ? ` ${taskCount} open task${taskCount === 1 ? "" : "s"} stay in Tasks, unassigned.` : ""}
      </span>
      <div style={{ display: "flex", gap: 8 }}>
        <Button tone="negative" onClick={() => void onRemove()}>
          delete {d.agent.name}
        </Button>
        <Button onClick={onKeep}>keep</Button>
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
    <section style={{ display: "grid", gridTemplateColumns: "64px 1fr", gap: 14, alignItems: "start" }}>
      <AgentFace name={d.agent.name} src={avatar} size={64} />
      <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
        <Field
          inline
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name.trim() !== d.agent.name && void onSave({ name: name.trim() })}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          aria-label="agent name"
          style={{ fontSize: 22, fontWeight: 700 }}
        />
        <Field
          inline
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => description.trim() !== (d.agent.description ?? "") && void onSave({ description: description.trim() })}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          placeholder="a line about this agent"
          aria-label="agent description"
          style={{ fontSize: 13.5, color: "var(--loki-muted)" }}
        />
        <div className="loki-meta loki-meta--wrap" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
          <Field
            inline
            mono
            list="loki-models"
            value={model}
            onFocus={onLoadModels}
            onChange={(e) => setModel(e.target.value)}
            onBlur={() => model.trim() && model.trim() !== (d.agent.model ?? "") && void onSave({ model: model.trim() })}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            aria-label="model"
            style={{ width: 240, fontSize: 12 }}
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
          <label className="loki-meta loki-meta--wrap" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            lives on
            <select
              aria-label="the Mac this agent lives on"
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
 * Servers are added in Settings › MCP.
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
      <div style={{ display: "grid", gap: 6, padding: "0 8px" }}>
        {view?.servers.map((s) => {
          const on = !s.off_for.includes(agentId);
          return (
            <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Switch on={on} onToggle={() => void mcp.agent(agentId, s.name, !on).then(apply)} label={s.entry} small />
              <span className="loki-meta">{s.state === "connected" ? `${s.tools.length} tools` : s.state}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
