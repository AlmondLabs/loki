import { useEffect, useState } from "react";
import type { ReflectionMerge, ReflectionSettings, ReflectionTrigger, Runtime } from "../../../core/attention/protocol.ts";
import type { ReflectionConversation, ReflectionState } from "../../../mod/reflection.ts";
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
type Patch = Partial<Pick<ReflectionSettings, "trigger" | "stepCount" | "merge" | "mergeInstructions">>;

export function ReflectionPage({ agentId, agentName, desks, api, reflect, onOpenDesk }: { agentId: string; agentName: string; desks: DeskSummary[]; api: AgentsApi; reflect: ReflectionControls; onOpenDesk: (agentId: string, conversationId: string) => void }) {
  /** undefined: reading; null: the app-server did not answer. */
  const [settings, setSettings] = useState<ReflectionSettings | null | undefined>(undefined);
  const [state, setState] = useState<ReflectionState | null | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // The settings are per agent, but the protocol addresses a conversation: any of the agent's will do.
  const rtFor = (conversationId: string): Runtime => ({ agent_id: agentId, conversation_id: conversationId });
  const someConversation = (s: ReflectionState | null | undefined) => s?.conversations[0]?.conversationId ?? desks.find((d) => d.agentId === agentId && d.conversationId)?.conversationId ?? null;

  // Mounted per agent (Agents.tsx keys this page by the agent id), so the state above starts fresh with each tab.
  // The two halves come from different places (the mod, the app-server) and neither waits for the other: the
  // settings go through one of the agent's desks when there is one, else through the first counted conversation.
  useEffect(() => {
    let gone = false;
    const statePromise = api.reflection(agentId);
    void statePromise.then((s) => !gone && setState(s));
    const settingsFor = (conv: string | null) => (conv ? reflect.get(rtFor(conv)) : Promise.resolve(null));
    const direct = someConversation(null);
    void (direct ? settingsFor(direct) : statePromise.then((s) => settingsFor(someConversation(s)))).then((st) => !gone && setSettings(st));
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

  const save = async (patch: Patch) => {
    const conv = someConversation(state);
    if (!settings || !conv) return;
    const next = { ...settings, ...patch };
    const err = await reflect.set(rtFor(conv), next);
    if (err) setNotice(err);
    else setSettings(next);
  };
  const run = async (conversationId: string) => {
    setBusy(conversationId);
    const answer = await reflect.run(rtFor(conversationId));
    setBusy(null);
    setNotice(answer);
  };

  return (
    <div style={{ minHeight: 0, display: "grid", gridTemplateColumns: "minmax(280px, 360px) 1fr" }}>
      <ListPane>
        <Head>when it reflects</Head>
        <SettingsPane settings={settings} state={state} agentName={agentName} onSave={save} />
      </ListPane>
      <Pane>
        <div className="loki-label" style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 9.5, marginBottom: 12 }}>
          <span>conversations · steps since the last pass</span>
          <span style={{ flex: 1 }} />
          {notice && <span style={{ textTransform: "none", letterSpacing: 0, color: "var(--loki-fg)" }}>{notice}</span>}
        </div>
        <Conversations state={state} settings={settings ?? null} agentName={agentName} busy={busy} onRun={run} onOpen={(c) => onOpenDesk(agentId, c)} />
      </Pane>
    </div>
  );
}

/** The left half: trigger, steps, merge (with review instructions when the agent reviews), and the last pass that changed memory. */
function SettingsPane({ settings, state, agentName, onSave }: { settings: ReflectionSettings | null | undefined; state: ReflectionState | null | undefined; agentName: string; onSave: (patch: Patch) => Promise<void> }) {
  if (settings === undefined) return <Meta>reading Letta's settings…</Meta>;
  if (settings === null) return <Meta wrap>Letta did not answer for these settings — loki has to be linked to the harness, and the agent needs a conversation.</Meta>;
  const ranBefore = state?.conversations.some((c) => c.lastSucceededAt) ?? false;
  return (
    <div style={{ display: "grid", gap: 14, padding: "4px 8px 0" }}>
      <Line label="trigger">
        <Choices options={["step-count", "compaction-event", "off"] as ReflectionTrigger[]} value={settings.trigger} word={(t) => TRIGGER_WORD[t]} onPick={(trigger) => void onSave({ trigger })} />
        <Meta wrap>{TRIGGER_HINT[settings.trigger]}</Meta>
      </Line>
      {settings.trigger === "step-count" && <StepsLine value={settings.stepCount} onSave={(stepCount) => void onSave({ stepCount })} />}
      <Line label="merge">
        <Choices options={["auto", "explicit"] as ReflectionMerge[]} value={settings.merge} word={(m) => (m === "auto" ? "applied automatically" : `${agentName} reviews first`)} onPick={(merge) => void onSave({ merge })} />
        <Meta wrap>{settings.merge === "auto" ? "what a pass keeps is merged into memory as the pass finishes" : `a pass that changed something is handed to ${agentName} in a background conversation of its own: it reviews the proposal for accuracy and placement, edits it, and merges it`}</Meta>
      </Line>
      {settings.merge === "explicit" && <InstructionsLine value={settings.mergeInstructions} onSave={(mergeInstructions) => void onSave({ mergeInstructions })} />}
      <Line label="last change">
        {state?.lastCommit ? (
          <Meta wrap>
            {ago(state.lastCommit.at)} · {state.lastCommit.message}
          </Meta>
        ) : (
          <Meta wrap>no pass has changed memory yet{ranBefore ? " — the passes that ran found nothing to keep" : ""}</Meta>
        )}
      </Line>
      <Meta wrap>These are Letta's own settings for {agentName}, the same ones its /sleeptime overlay shows in a terminal; a pass runs inside the harness whether loki is open or not.</Meta>
    </div>
  );
}

function Choices<T extends string>({ options, value, word, onPick }: { options: T[]; value: T; word: (o: T) => string; onPick: (o: T) => void }) {
  return (
    <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
      {options.map((o) => (
        <Chip key={o} label active={value === o} aria-pressed={value === o} onClick={() => onPick(o)}>
          {word(o)}
        </Chip>
      ))}
    </span>
  );
}

/** The step count, saved on blur when it is a new positive whole number. */
function StepsLine({ value, onSave }: { value: number; onSave: (n: number) => void }) {
  const [steps, setSteps] = useState(String(value));
  const commit = () => {
    const n = Number(steps);
    if (Number.isInteger(n) && n > 0 && n !== value) onSave(n);
    else setSteps(String(value));
  };
  return (
    <Line label="steps">
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <Field size="sm" mono value={steps} onChange={(e) => setSteps(e.target.value)} onBlur={commit} style={{ width: 64 }} aria-label="steps between passes" />
        <Meta>of a conversation since its last pass</Meta>
      </span>
    </Line>
  );
}

/** Letta's "review instructions": a line the reviewing pass is told to follow, saved on blur. */
function InstructionsLine({ value, onSave }: { value: string; onSave: (s: string) => void }) {
  const [text, setText] = useState(value);
  return (
    <Line label="review notes">
      <Field size="sm" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => text.trim() !== value.trim() && onSave(text.trim())} placeholder="anything the review should keep in mind" aria-label="review instructions" style={{ width: "100%" }} />
      <Meta wrap>handed to the reviewing pass with the proposal</Meta>
    </Line>
  );
}

/** The right half: each counted conversation, nearest the next pass first, with "reflect now". */
function Conversations({ state, settings, agentName, busy, onRun, onOpen }: { state: ReflectionState | null | undefined; settings: ReflectionSettings | null; agentName: string; busy: string | null; onRun: (conversationId: string) => void; onOpen: (conversationId: string) => void }) {
  if (state === undefined) return <Meta>reading…</Meta>;
  if (state === null) return <Meta wrap>the mod did not answer — after a loki update, /reload in a chat brings the new mod up</Meta>;
  if (state.conversations.length === 0) return <Meta wrap>no conversation of {agentName} has a transcript yet; the counters start with its first turn</Meta>;
  const threshold = settings?.trigger === "step-count" ? settings.stepCount : null;
  return (
    <div style={{ display: "grid", gap: 4 }}>
      {state.conversations.map((c) => (
        <div key={c.conversationId} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto auto", alignItems: "center", gap: 12, padding: "6px 8px", borderBottom: "1px solid var(--loki-border)" }}>
          <Row dense flush onClick={() => onOpen(c.conversationId)} title="open this conversation" style={{ minWidth: 0, display: "grid", gap: 2 }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13.5 }}>{c.title ?? c.conversationId}</span>
            <span style={{ fontFamily: "var(--loki-mono)", fontSize: 10.5, color: "var(--loki-muted)" }}>{countLine(c, threshold)}</span>
          </Row>
          <span style={{ fontFamily: "var(--loki-mono)", fontSize: 10.5, color: "var(--loki-muted)" }}>{c.totalSteps} in all</span>
          <Button size="sm" onClick={() => onRun(c.conversationId)} disabled={busy !== null} title="start a pass over this conversation now, the same as /reflect in its chat">
            {busy === c.conversationId ? "starting…" : "reflect now"}
          </Button>
        </div>
      ))}
    </div>
  );
}

/** "24 steps since the pass 3h ago · fires at 25 · due after its next turn". */
export function countLine(c: ReflectionConversation, threshold: number | null): string {
  const since = c.lastSucceededAt ? `the pass ${ago(c.lastSucceededAt)}` : "the start, no pass yet";
  const head = `${c.stepsSince} step${c.stepsSince === 1 ? "" : "s"} since ${since}`;
  if (threshold === null) return head;
  return `${head} · fires at ${threshold}${c.stepsSince >= threshold ? " · due after its next turn" : ""}`;
}

const TRIGGER_WORD: Record<ReflectionTrigger, string> = { "step-count": "every n steps", "compaction-event": "after a compaction", off: "off" };
const TRIGGER_HINT: Record<ReflectionTrigger, string> = {
  "step-count": "after a turn, once the conversation has gathered this many steps since its last pass",
  "compaction-event": "after a turn in which the conversation was compacted",
  off: "never on its own; only reflect now, or /reflect in a chat",
};

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "84px 1fr", gap: 12, alignItems: "start", fontSize: 13.5, lineHeight: 1.5 }}>
      <span className="loki-label" style={{ fontSize: 9.5, paddingTop: 4 }}>{label}</span>
      <span style={{ minWidth: 0, display: "grid", gap: 4 }}>{children}</span>
    </div>
  );
}
