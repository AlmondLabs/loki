import { useEffect, useMemo, useState } from "react";
import type { DeskSummary } from "../desk/useDesk";
import { AgentFace } from "../desk/AgentChip";
import { Button, Field, Row } from "../components";
import type { Task } from "../board/model";
import { ago } from "../board/model";
import { Head } from "./bits";
import type { AgentDetails, AgentEdit } from "./types";

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
  onShowBoard,
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
  onShowBoard: () => void;
  confirmDelete: boolean;
  setConfirmDelete: (v: boolean) => void;
  onRemove: () => Promise<void>;
}) {
  const myDesks = useMemo(() => desks.filter((x) => x.agentId === selected && x.status === "live"), [desks, selected]);
  const myTasks = useMemo(() => (tasks ?? []).filter((t) => t.status !== "closed" && (t.metadata.assignedAgentId === selected || t.assignee === d.agent.name)), [tasks, selected, d]);
  return (
    <div style={{ minWidth: 0, minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "22px 28px 32px" }}>
      <div style={{ maxWidth: 760, display: "grid", gap: 28 }}>
        <Identity d={d} avatar={avatar} models={models} onLoadModels={onLoadModels} onSave={onSave} />
        <DesksSection myDesks={myDesks} onOpen={(conversationId) => onOpenDesk(selected, conversationId)} onShowDesks={onShowDesks} />
        <TasksSection count={myTasks.length} onShowBoard={onShowBoard} />
        <div style={{ paddingTop: 8 }}>
          {confirmDelete ? <ConfirmDelete d={d} myDesks={myDesks} taskCount={myTasks.length} onRemove={onRemove} onKeep={() => setConfirmDelete(false)} /> : <Button tone="negative" onClick={() => setConfirmDelete(true)}>delete this agent…</Button>}
        </div>
      </div>
    </div>
  );
}

function DesksSection({ myDesks, onOpen, onShowDesks }: { myDesks: DeskSummary[]; onOpen: (conversationId: string) => void; onShowDesks: () => void }) {
  return (
    <section>
      <Head>
        desks <span style={{ marginLeft: "auto", letterSpacing: 0, fontFamily: "var(--loki-mono)" }}>{myDesks.length ? `${myDesks.length} live` : ""}</span>
      </Head>
      {myDesks.length === 0 && <div style={{ fontSize: 12, color: "var(--loki-muted)", padding: "0 8px" }}>no live desks</div>}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 2 }}>
        {myDesks.map((x) => (
          <Row dense key={x.scope} onClick={() => onOpen(x.conversationId ?? "default")} style={{ justifyContent: "space-between", fontSize: 13.5 }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.title ?? "main chat"}</span>
            <span style={{ fontFamily: "var(--loki-mono)", fontSize: 10.5, color: "var(--loki-muted)", flex: "0 0 auto" }}>{x.active ? "active" : x.lastActive ? ago(x.lastActive) : ""}</span>
          </Row>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, padding: "8px 8px 0" }}>
        <Button tone="brass" onClick={() => onOpen("default")}>main chat</Button>
        <Button onClick={onShowDesks} kbd="⌘K">the desk tree</Button>
      </div>
    </section>
  );
}

function TasksSection({ count, onShowBoard }: { count: number; onShowBoard: () => void }) {
  return (
    <section>
      <Head>
        tasks <span style={{ marginLeft: "auto", letterSpacing: 0, fontFamily: "var(--loki-mono)" }}>{count ? `${count} open` : ""}</span>
      </Head>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 8px", fontSize: 13.5, color: "var(--loki-muted)" }}>
        <span>{count === 0 ? "nothing assigned" : `${count} assigned on the board`}</span>
        <Button onClick={onShowBoard} kbd="⌘3">board</Button>
      </div>
    </section>
  );
}

/** The last step before deleting: what closes (live desks) and what stays (open tasks, unassigned). */
function ConfirmDelete({ d, myDesks, taskCount, onRemove, onKeep }: { d: AgentDetails; myDesks: DeskSummary[]; taskCount: number; onRemove: () => Promise<void>; onKeep: () => void }) {
  return (
    <div role="alertdialog" aria-label={`delete ${d.agent.name}`} style={{ display: "grid", gap: 8, padding: "10px 12px", border: "1px solid var(--loki-negative)", borderRadius: 8, fontSize: 12, color: "var(--loki-fg)", lineHeight: 1.5 }}>
      <span>
        Delete <b>{d.agent.name}</b> and its memory. {myDesks.length ? `${myDesks.length} live desk${myDesks.length === 1 ? "" : "s"} (${myDesks.slice(0, 3).map((x) => x.title ?? "main chat").join(", ")}${myDesks.length > 3 ? ", …" : ""}) close.` : ""}
        {taskCount ? ` ${taskCount} open task${taskCount === 1 ? "" : "s"} stay on the board, unassigned.` : ""}
      </span>
      <div style={{ display: "flex", gap: 8 }}>
        <Button tone="negative" onClick={() => void onRemove()}>delete {d.agent.name}</Button>
        <Button onClick={onKeep}>keep</Button>
      </div>
    </div>
  );
}

function Identity({ d, avatar, models, onLoadModels, onSave }: { d: AgentDetails; avatar: string; models: string[] | null; onLoadModels: () => void; onSave: (body: AgentEdit) => Promise<void> }) {
  const [name, setName] = useState(d.agent.name);
  const [description, setDescription] = useState(d.agent.description ?? "");
  const [model, setModel] = useState(d.agent.model ?? "");
  useEffect(() => {
    setName(d.agent.name);
    setDescription(d.agent.description ?? "");
    setModel(d.agent.model ?? "");
  }, [d]);
  const settings = d.agent.modelSettings;
  const bits = [settings.effort ? `effort ${String(settings.effort)}` : null, settings.thinking ? "thinking" : null, settings.context_window_limit ? `${contextSize(Number(settings.context_window_limit))} context` : null].filter(Boolean);
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
          style={{ fontFamily: "var(--loki-display)", fontSize: 22 }}
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
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, fontSize: 12, color: "var(--loki-muted)", fontFamily: "var(--loki-mono)", flexWrap: "wrap" }}>
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
          <datalist id="loki-models">{(models ?? []).map((m) => <option key={m} value={m} />)}</datalist>
          {bits.map((b) => (
            <span key={b}>· {b}</span>
          ))}
          {d.agent.favourite && <span style={{ color: "var(--loki-accent)" }}>· ★ favourite</span>}
        </div>
      </div>
    </section>
  );
}

/** A context window as people say it: 200k, 1M. */
function contextSize(tokens: number): string {
  return tokens >= 1_000_000 ? `${Math.round(tokens / 100_000) / 10}M` : `${Math.round(tokens / 1000)}k`;
}
