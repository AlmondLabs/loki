import type { ChatSummary, MacIdentity, McpServerView, McpView } from "../../../core/frame-types.ts";
import type { ModelEntry } from "../../../core/models.ts";
import { MAIN_CHAT_ID } from "../../../core/chat-scope.ts";
import { StarIcon } from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useState } from "react";

import { Button, Dot, Field, Meta, Sheet, Switch, sentence } from "../components";
import { modelName } from "../chat/model-picker";
import { OwnedAccounts, type AccountsApi, type AgentName } from "../settings/accounts";
import { Block, PopUp, Setting } from "../settings/layout";
import type { McpApi } from "../settings/mcp";
import { ago } from "../shared/ago";
import { Glyph } from "../shared/icons";
import type { ContentRow } from "../shell/content-list";
import { osWords } from "../shell/os-words";
import { AgentFace } from "../workspace/agent-chip";
import { ModelSelect } from "./model-select";
import type { AgentDetails, AgentEdit } from "./types";

const MCP_TONE: Record<McpServerView["state"], string> = {
  connected: "var(--loki-positive)",
  starting: "var(--loki-accent)",
  down: "var(--loki-negative)",
  signin: "var(--loki-accent)",
};

export function chatRows(desks: readonly ChatSummary[], agentId: string, query = ""): ContentRow[] {
  const q = query.trim().toLowerCase();
  return desks
    .filter((x) => x.agent_id === agentId && x.status === "live")
    .filter((x) => !q || (x.title ?? "Main chat").toLowerCase().includes(q))
    .map((x) => ({
      id: x.conversation_id ?? MAIN_CHAT_ID,
      title: x.title ?? "Main chat",
      time: x.active ? undefined : x.last_active ? ago(x.last_active) : undefined,
      live: x.active,
      liveAtEnd: true,
    }));
}

export function ProfilePage({
  d,
  selected,
  avatar,
  models,
  onLoadModels,
  onSave,
  desks,
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
  models: ModelEntry[] | null;
  onLoadModels: () => void;
  onSave: (body: AgentEdit) => Promise<void>;
  desks: ChatSummary[];
  mcp?: Pick<McpApi, "get" | "agent">;
  accounts?: { api: AccountsApi; agents: readonly AgentName[] };
  macs?: MacIdentity[];
  confirmDelete: boolean;
  setConfirmDelete: (v: boolean) => void;
  onRemove: () => Promise<void>;
}) {
  const myDesks = useMemo(() => desks.filter((x) => x.agent_id === selected && x.status === "live"), [desks, selected]);
  const [name, setName] = useState(d.agent.name);
  const [description, setDescription] = useState(d.agent.description ?? "");
  const [shownD, setShownD] = useState(d);
  if (shownD !== d) {
    setShownD(d);
    setName(d.agent.name);
    setDescription(d.agent.description ?? "");
  }

  const running = myDesks.some((x) => x.active);
  const settings = d.agent.model_settings;
  const bits = [
    typeof settings.reasoning_effort === "string" ? `effort ${settings.reasoning_effort}` : null,
    settings.context_window_limit ? `${contextSize(Number(settings.context_window_limit))} context` : null,
  ].filter(Boolean);
  const modelDisplay = d.agent.model ? modelName(models, d.agent.model) : "Harness default";

  return (
    <div className="min-w-0" style={{ minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "24px 20px 48px" }}>
      <div className="grid gap-6" style={{ maxWidth: 760 }}>
        <section className="grid grid-cols-[64px_1fr] items-center gap-4">
          <AgentFace name={d.agent.name} src={avatar} size={64} />
          <div className="grid min-w-0 gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="loki-title loki-title--page loki-truncate" style={{ margin: 0 }}>
                {d.agent.name}
              </h2>
              {d.agent.favourite && (
                <Meta brass className="inline-flex items-center gap-1">
                  <Glyph icon={StarIcon} size={12} inline />
                  Favourite
                </Meta>
              )}
            </div>
            {d.agent.description && (
              <div style={{ fontSize: "var(--text-sm)", color: "var(--loki-muted)", overflowWrap: "anywhere" }}>{d.agent.description}</div>
            )}
            <Meta wrap>
              {[running ? "Working now" : "Idle", `${myDesks.length} live chat${myDesks.length === 1 ? "" : "s"}`, modelDisplay, ...bits].join(" · ")}
            </Meta>
          </div>
        </section>

        <Block title="Identity">
          <Setting label="Name">
            <Field
              size="sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => name.trim() && name.trim() !== d.agent.name && void onSave({ name: name.trim() })}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              aria-label="Agent name"
              style={{ width: 260 }}
            />
          </Setting>
          <Setting label="Description">
            <Field
              size="sm"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={() => description.trim() !== (d.agent.description ?? "") && void onSave({ description: description.trim() })}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              placeholder="What this agent is for"
              aria-label="Agent description"
              style={{ width: 260 }}
            />
          </Setting>
          <Setting label="Model" help={bits.length ? bits.join(" · ") : "Used for new main chats and background passes."}>
            <ModelSelect
              value={d.agent.model ?? ""}
              entries={models}
              onLoad={onLoadModels}
              onPick={(model) => void onSave({ model })}
              anchor="right"
              ariaLabel="Model"
            />
          </Setting>
          {macs && macs.length > 1 && (
            <Setting label="Lives on" help="New chats with this agent start on that computer.">
              <PopUp
                label="The computer this agent lives on"
                options={macs.map((m) => m.mac_id)}
                value={d.agent.home_mac ?? macs[0].mac_id}
                onPick={(homeMac) => void onSave({ home_mac: homeMac })}
                labels={Object.fromEntries(macs.map((m) => [m.mac_id, m.name]))}
              />
            </Setting>
          )}
        </Block>

        {mcp && <McpSection key={selected} agentId={selected} mcp={mcp} />}

        <Block>
          <Setting label={`Delete ${d.agent.name}`} help={`Removes this agent, its memory and its live chats from ${osWords().machine}.`}>
            <Button size="sm" tone="negative" onClick={() => setConfirmDelete(true)}>
              Delete Agent…
            </Button>
          </Setting>
        </Block>
      </div>

      {confirmDelete && <ConfirmDeleteSheet d={d} myDesks={myDesks} accounts={accounts} onRemove={onRemove} onKeep={() => setConfirmDelete(false)} />}
    </div>
  );
}

function ConfirmDeleteSheet({
  d,
  myDesks,
  accounts,
  onRemove,
  onKeep,
}: {
  d: AgentDetails;
  myDesks: ChatSummary[];
  accounts?: { api: AccountsApi; agents: readonly AgentName[] };
  onRemove: () => Promise<void>;
  onKeep: () => void;
}) {
  const [asked, setAsked] = useState(0);
  const [owned, setOwned] = useState(0);
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onRemove();
      setAsked((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet label={`Delete ${d.agent.name}`} onClose={onKeep} width={440} top="14vh">
      <div className="grid gap-4" style={{ padding: 20 }}>
        <div className="grid gap-2">
          <div style={{ fontSize: "var(--text-base)", fontWeight: 700, color: "var(--loki-fg)" }}>{`Delete ${d.agent.name}?`}</div>
          <div style={{ fontSize: "var(--text-sm)", color: "var(--loki-muted)", lineHeight: 1.5 }}>
            Deletes <b>{d.agent.name}</b> and its memory.{" "}
            {myDesks.length
              ? `${myDesks.length} live chat${myDesks.length === 1 ? "" : "s"} (${myDesks
                  .slice(0, 3)
                  .map((x) => x.title ?? "Main chat")
                  .join(", ")}${myDesks.length > 3 ? ", …" : ""}) will close.`
              : ""}
          </div>
        </div>
        {accounts && (
          <div style={{ fontSize: "var(--text-xs)", color: "var(--loki-fg)", lineHeight: 1.5 }}>
            <OwnedAccounts api={accounts.api} agentId={d.agent.id} agents={accounts.agents} asked={asked} onOwned={setOwned} />
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button size="sm" onClick={onKeep}>
            Cancel
          </Button>
          <Button size="sm" tone="negative" disabled={busy || owned > 0} onClick={() => void remove()}>
            {busy ? "Deleting…" : `Delete ${d.agent.name}`}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

function contextSize(tokens: number): string {
  return tokens >= 1_000_000 ? `${Math.round(tokens / 100_000) / 10}M` : `${Math.round(tokens / 1000)}k`;
}

function McpSection({ agentId, mcp }: { agentId: string; mcp: Pick<McpApi, "get" | "agent"> }) {
  const [view, setView] = useState<McpView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const apply = (r: McpView | string) => (typeof r === "string" ? setError(r) : (setError(null), setView(r)));
  const load = useEffectEvent(() => void mcp.get().then(apply));
  useEffect(() => load(), []);
  if (!view?.servers.length && !error) return null;
  return (
    <Block title="MCP servers" help="Servers this agent can search and call tools from.">
      {error && (
        <div className="loki-meta loki-meta--negative loki-meta--wrap" style={{ padding: "12px 0" }}>
          {error}
        </div>
      )}
      {view?.servers.map((s) => {
        const on = !s.off_for.includes(agentId);
        return (
          <Setting key={s.name} label={s.entry} help={s.purpose ?? undefined}>
            <Dot color={MCP_TONE[s.state]} />
            <Meta>{s.state === "connected" ? `${s.tools.length} tools` : sentence(s.state)}</Meta>
            <Switch on={on} onToggle={() => void mcp.agent(agentId, s.name, !on).then(apply)} label={s.entry} hideLabel />
          </Setting>
        );
      })}
    </Block>
  );
}
