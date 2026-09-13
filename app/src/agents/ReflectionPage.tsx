import { useEffect, useState } from "react";
import type { ReflectionMerge, ReflectionSettings, ReflectionTrigger, Runtime } from "../../../core/attention/protocol.ts";
import type { ReflectionState } from "../../../mod/reflection.ts";
import type { DeskSummary } from "../desk/useDesk";
import { Button, Chip, Field, Meta, Row } from "../components";
import { ago } from "../board/model";
import { Head, ListPane, Pane } from "./bits";
import type { AgentsApi, ReflectionControls } from "./types";

/**
 * The reflection page: Letta's sleep-time pass over what happened, for one agent. After a turn, Letta may launch a
 * Reflection Subagent over a conversation's unreflected transcript; what it keeps becomes memory commits. The
 * settings on the left are Letta's own for this agent (what its /sleeptime overlay shows in a terminal), read and
 * written through the app-server. The list on the right is what the step-count trigger looks at: each conversation's
 * steps since its last pass, from Letta's transcript state files through the mod. "reflect now" starts a pass by
 * hand, the same as /reflect in that conversation's chat; the harness answers in a line, and the pass itself runs in
 * the background and lands on the changes page when it commits.
 */
export function ReflectionPage({ agentId, agentName, desks, api, reflect, onOpenDesk }: { agentId: string; agentName: string; desks: DeskSummary[]; api: AgentsApi; reflect: ReflectionControls; onOpenDesk: (agentId: string, conversationId: string) => void }) {
  /** undefined: reading; null: the app-server did not answer. */
  const [settings, setSettings] = useState<ReflectionSettings | null | undefined>(undefined);
  const [state, setState] = useState<ReflectionState | null | undefined>(undefined);
  const [steps, setSteps] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // The settings are per agent, but the protocol addresses a conversation: any of the agent's will do.
  const rtFor = (conversationId: string): Runtime => ({ agent_id: agentId, conversation_id: conversationId });
  const someConversation = (s: ReflectionState | null | undefined) => s?.conversations[0]?.conversationId ?? desks.find((d) => d.agentId === agentId && d.conversationId)?.conversationId ?? null;

  // Mounted per agent (Agents.tsx keys this page by the agent id), so the state above starts fresh with each tab.
  useEffect(() => {
    let gone = false;
    // The two halves come from different places (the mod, the app-server) and neither should wait for the other:
    // the settings go through one of the agent's desks when there is one, else through the first counted conversation.
    const statePromise = api.reflection(agentId);
    void statePromise.then((s) => !gone && setState(s));
    void (async () => {
      const conv = someConversation(null) ?? someConversation(await statePromise);
      const st = conv ? await reflect.get(rtFor(conv)) : null;
      if (gone) return;
      setSettings(st);
      setSteps(st ? String(st.stepCount) : "");
    })();
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  const save = async (patch: Partial<Pick<ReflectionSettings, "trigger" | "stepCount" | "merge">>) => {
    const conv = someConversation(state);
    if (!settings || !conv) return;
    const next = { ...settings, ...patch };
    const err = await reflect.set(rtFor(conv), next);
    if (err) setNotice(err);
    else {
      setSettings(next);
      setSteps(String(next.stepCount));
    }
  };
  const run = async (conversationId: string) => {
    setBusy(conversationId);
    const answer = await reflect.run(rtFor(conversationId));
    setBusy(null);
    setNotice(answer);
  };

  const stepCount = settings?.stepCount ?? 25;
  return (
    <div style={{ minHeight: 0, display: "grid", gridTemplateColumns: "minmax(280px, 360px) 1fr" }}>
      <ListPane>
        <Head>when it reflects</Head>
        {settings === undefined && <Meta>reading Letta's settings…</Meta>}
        {settings === null && <Meta wrap>Letta did not answer for these settings — loki has to be linked to the harness, and the agent needs a conversation.</Meta>}
        {settings && (
          <div style={{ display: "grid", gap: 14, padding: "4px 8px 0" }}>
            <Line label="trigger">
              <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                {(["step-count", "compaction-event", "off"] as ReflectionTrigger[]).map((t) => (
                  <Chip key={t} label active={settings.trigger === t} aria-pressed={settings.trigger === t} onClick={() => void save({ trigger: t })}>
                    {TRIGGER_WORD[t]}
                  </Chip>
                ))}
              </span>
              <Meta wrap>{TRIGGER_HINT[settings.trigger]}</Meta>
            </Line>
            {settings.trigger === "step-count" && (
              <Line label="steps">
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <Field size="sm" mono value={steps} onChange={(e) => setSteps(e.target.value)} onBlur={() => Number.isInteger(Number(steps)) && Number(steps) > 0 && Number(steps) !== settings.stepCount && void save({ stepCount: Number(steps) })} style={{ width: 64 }} aria-label="steps between passes" />
                  <Meta>of a conversation since its last pass</Meta>
                </span>
              </Line>
            )}
            <Line label="merge">
              <span style={{ display: "inline-flex", gap: 6 }}>
                {(["auto", "explicit"] as ReflectionMerge[]).map((m) => (
                  <Chip key={m} label active={settings.merge === m} aria-pressed={settings.merge === m} onClick={() => void save({ merge: m })}>
                    {m === "auto" ? "on its own" : "explicit"}
                  </Chip>
                ))}
              </span>
              <Meta wrap>{settings.merge === "auto" ? "what a pass keeps is committed to memory as it finishes" : `a pass leaves its changes for ${agentName} to integrate in its next turn`}</Meta>
            </Line>
            <Line label="last change">
              {state?.lastCommit ? (
                <Meta wrap>
                  {ago(state.lastCommit.at)} · {state.lastCommit.message}
                </Meta>
              ) : (
                <Meta wrap>no pass has changed memory yet{state?.conversations.some((c) => c.lastSucceededAt) ? " — the passes that ran found nothing to keep" : ""}</Meta>
              )}
            </Line>
            <Meta wrap>These are Letta's own settings for {agentName}, the same ones its /sleeptime overlay shows in a terminal; a pass runs inside the harness whether loki is open or not.</Meta>
          </div>
        )}
      </ListPane>
      <Pane>
        <div className="loki-label" style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 9.5, marginBottom: 12 }}>
          <span>conversations · steps since the last pass</span>
          <span style={{ flex: 1 }} />
          {notice && <span style={{ textTransform: "none", letterSpacing: 0, color: "var(--loki-fg)" }}>{notice}</span>}
        </div>
        {state === undefined && <Meta>reading…</Meta>}
        {state === null && <Meta wrap>the mod did not answer</Meta>}
        {state && state.conversations.length === 0 && <Meta wrap>no conversation of {agentName} has a transcript yet; the counters start with its first turn</Meta>}
        {state && state.conversations.length > 0 && (
          <div style={{ display: "grid", gap: 4 }}>
            {state.conversations.map((c) => {
              const due = settings?.trigger === "step-count" && c.stepsSince >= stepCount;
              return (
                <div key={c.conversationId} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto auto", alignItems: "center", gap: 12, padding: "6px 8px", borderBottom: "1px solid var(--loki-border)" }}>
                  <Row dense flush onClick={() => onOpenDesk(agentId, c.conversationId)} title="open this conversation" style={{ minWidth: 0, display: "grid", gap: 2 }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 }}>{c.title ?? c.conversationId}</span>
                    <span style={{ fontFamily: "var(--loki-mono)", fontSize: 10.5, color: "var(--loki-muted)" }}>
                      {c.stepsSince} step{c.stepsSince === 1 ? "" : "s"} since {c.lastSucceededAt ? `the pass ${ago(c.lastSucceededAt)}` : "the start, no pass yet"}
                      {settings?.trigger === "step-count" ? ` · fires at ${stepCount}${due ? " · due after its next turn" : ""}` : ""}
                    </span>
                  </Row>
                  <span style={{ fontFamily: "var(--loki-mono)", fontSize: 10.5, color: "var(--loki-muted)" }}>{c.totalSteps} in all</span>
                  <Button size="sm" onClick={() => void run(c.conversationId)} disabled={busy !== null} title="start a pass over this conversation now, the same as /reflect in its chat">
                    {busy === c.conversationId ? "starting…" : "reflect now"}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </Pane>
    </div>
  );
}

const TRIGGER_WORD: Record<ReflectionTrigger, string> = { "step-count": "every n steps", "compaction-event": "after a compaction", off: "off" };
const TRIGGER_HINT: Record<ReflectionTrigger, string> = {
  "step-count": "after a turn, once the conversation has gathered this many steps since its last pass",
  "compaction-event": "after a turn in which the conversation was compacted",
  off: "never on its own; only reflect now, or /reflect in a chat",
};

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "84px 1fr", gap: 12, alignItems: "start", fontSize: 13, lineHeight: 1.5 }}>
      <span className="loki-label" style={{ fontSize: 9.5, paddingTop: 4 }}>{label}</span>
      <span style={{ minWidth: 0, display: "grid", gap: 4 }}>{children}</span>
    </div>
  );
}
