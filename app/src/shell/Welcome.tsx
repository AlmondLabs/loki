import { useEffect, useRef, useState, type RefObject } from "react";
import { Button, Field, Sheet, TextArea, Title } from "../components";
import type { ConnectProvider } from "../../../core/attention/protocol.ts";
import { PERSONA_HINT } from "../agents/NewAgent";
import { Providers } from "../settings/Providers";
import { isConnected } from "../settings/provider-model";
import { nodeHelp, type DaemonStatus, type NodeMissing } from "./bootstrap";
import { formatKeys } from "./keymap";
import { useAgentDraft, type CreateAgent } from "./useAgentDraft";

type ProviderProps = {
  providers: ConnectProvider[] | null;
  onLoadProviders: () => Promise<unknown>;
  onConnect: (providerId: string, fields: Record<string, string>, authMethodId?: string) => Promise<string | null>;
  onDisconnect: (providerId: string) => Promise<string | null>;
  onModelsChanged: () => void;
};

/**
 * First launch, as a sheet over the empty desk: a provider (skipped when one is connected), then
 * the first agent, then its desk. Shown only while the daemon lists no agents at all, or could not start
 * (then Node, or the reason, comes first).
 */
export function Welcome({
  step,
  providers,
  onLoadProviders,
  onConnect,
  onDisconnect,
  onModelsChanged,
  models,
  onLoadModels,
  onCreate,
  onDone,
  daemon,
  onRetryDaemon,
}: ProviderProps & {
  step: "node" | "provider" | "agent";
  /** The shell's view of loki's daemon (null in a browser tab). */
  daemon: DaemonStatus | null;
  /** Look for Node again and start the daemon (the shell's retry_daemon). */
  onRetryDaemon: () => Promise<void>;
  models: string[] | null;
  /** Fetch the model list; the "skip for now" / "next" button calls it, the shell does when it opens on the agent step. */
  onLoadModels: () => void;
  onCreate: CreateAgent;
  onDone: (agentId: string) => void;
}) {
  const [skipProvider, setSkipProvider] = useState(false);
  const draft = useAgentDraft(onCreate, onDone);
  const nameRef = useRef<HTMLInputElement>(null);
  const nodeStep = step === "node";
  const showAgent = !nodeStep && (step === "agent" || skipProvider);
  useEffect(() => {
    if (!showAgent) return;
    const t = setTimeout(() => nameRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [showAgent]);
  const connected = providers?.some(isConnected) ?? false;

  return (
    // Nothing closes this sheet — it stays until the first agent exists — so the veil's click and Escape are no-ops.
    <Sheet label="welcome" width={640} top="10vh" scroll style={{ padding: "26px 28px 22px", display: "grid", gap: 18 }}>
      <div>
        <Title page>Welcome to loki</Title>
        <div style={{ fontSize: 13.5, color: "var(--loki-muted)", marginTop: 6, lineHeight: 1.5 }}>
          A memory palace your agent builds. Two things before the first chat: a model to think with, and an agent to think.
        </div>
      </div>

      {nodeStep && (
        <Step n={0} title={daemon?.nodeMissing ? "Node" : "Starting loki"} active>
          <DaemonProblem status={daemon} onRetry={onRetryDaemon} />
        </Step>
      )}

      <Step n={1} title="A model provider" done={connected} active={!showAgent && !nodeStep}>
        <ProviderStep nodeStep={nodeStep} showAgent={showAgent} connected={connected} providers={providers} onLoadProviders={onLoadProviders} onConnect={onConnect} onDisconnect={onDisconnect} onModelsChanged={onModelsChanged} onNext={() => (setSkipProvider(true), onLoadModels())} />
      </Step>

      <Step n={2} title="Your first agent" active={showAgent}>
        {showAgent && <AgentForm draft={draft} nameRef={nameRef} models={models} canGoBack={step === "provider"} onBack={() => setSkipProvider(false)} />}
      </Step>
    </Sheet>
  );
}

/** Step 1: waits for the daemon, then the provider shortlist with "next" / "skip for now", then a line naming what connected. */
function ProviderStep({ nodeStep, showAgent, connected, providers, onLoadProviders, onConnect, onDisconnect, onModelsChanged, onNext }: ProviderProps & { nodeStep: boolean; showAgent: boolean; connected: boolean; onNext: () => void }) {
  if (nodeStep) return <span className="loki-meta loki-meta--wrap">once loki is running</span>;
  if (!showAgent)
    return (
      <div style={{ display: "grid", gap: 10 }}>
        <Providers providers={providers} onLoad={onLoadProviders} onConnect={onConnect} onDisconnect={onDisconnect} onChanged={onModelsChanged} shortlist />
        <div className="loki-meta loki-meta--wrap" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span>Keys are checked with the provider and kept in this computer's keychain.</span>
          <span style={{ flex: 1 }} />
          {/* Moving on shows the agent form, which lists models; when the shell gets here on its own it asks for them itself. */}
          <Button size="sm" onClick={onNext}>
            {connected ? "next" : "skip for now"}
          </Button>
        </div>
      </div>
    );
  return <span className="loki-meta loki-meta--wrap">{connected ? `${providers!.filter(isConnected).map((p) => p.display_name).join(", ")}` : "none yet — Settings › providers, any time"}</span>;
}

/** Step 2: the form for the first agent; ↵ anywhere but the persona creates it. */
function AgentForm({ draft, nameRef, models, canGoBack, onBack }: { draft: ReturnType<typeof useAgentDraft>; nameRef: RefObject<HTMLInputElement | null>; models: string[] | null; canGoBack: boolean; onBack: () => void }) {
  const { name, setName, description, setDescription, persona, setPersona, model, setModel, busy, error, create } = draft;
  return (
    <div style={{ display: "grid", gap: 10 }} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLElement).tagName !== "TEXTAREA" && void create()}>
      <Labelled label="Name">
        <Field ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="atlas, scout, sage…" autoComplete="off" data-1p-ignore data-form-type="other" />
      </Labelled>
      <Labelled label="Description">
        <Field value={description} onChange={(e) => setDescription(e.target.value)} placeholder="what this agent is for (optional)" autoComplete="off" data-form-type="other" />
      </Labelled>
      <Labelled label="Persona">
        <TextArea rows={4} value={persona} onChange={(e) => setPersona(e.target.value)} placeholder={PERSONA_HINT} data-form-type="other" />
      </Labelled>
      <Labelled label="Model">
        <Field mono list="loki-welcome-models" value={model} onChange={(e) => setModel(e.target.value)} placeholder={models === null ? "loading the model list…" : models.length ? "the default, or pick one" : "no models yet — connect a provider first"} autoComplete="off" data-form-type="other" />
        <datalist id="loki-welcome-models">{(models ?? []).map((m) => <option key={m} value={m} />)}</datalist>
      </Labelled>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
        {error && <span className="loki-meta loki-meta--negative loki-meta--wrap">{error}</span>}
        <span style={{ flex: 1 }} />
        {canGoBack && (
          <Button size="sm" onClick={onBack}>
            back
          </Button>
        )}
        <Button size="sm" tone="positive" kbd={formatKeys("enter")} onClick={() => void create()} disabled={busy || !name.trim()}>
          {busy ? "creating…" : "create and open the chat"}
        </Button>
      </div>
    </div>
  );
}

/** The daemon could not start: for want of a new-enough Node, the Node step; for anything else, the reason and "check again". */
export function DaemonProblem({ status, onRetry }: { status: DaemonStatus | null; onRetry: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const retry = () => {
    setBusy(true);
    void onRetry().finally(() => setBusy(false));
  };
  if (status?.nodeMissing) return <NodeNeeded missing={status.nodeMissing} busy={busy} onRecheck={retry} />;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ fontSize: 13.5, color: "var(--loki-fg)", lineHeight: 1.5 }}>loki could not start the process that runs your agents.</div>
      {status?.error && <div className="loki-meta loki-meta--negative loki-meta--wrap">{status.error}</div>}
      <div className="loki-meta loki-meta--wrap" style={{ lineHeight: 1.5 }}>
        Its log is <code style={mono}>~/.loki/logs/daemon.log</code>.
      </div>
      <Button size="sm" tone="positive" disabled={busy} onClick={retry} style={{ justifySelf: "start" }}>
        {busy ? "checking…" : "check again"}
      </Button>
    </div>
  );
}

const mono = { fontFamily: "var(--loki-mono)" };

/**
 * No Node 22 or newer anywhere loki looks: what to install, this system's usual command, the nodejs.org link, and
 * one button — the daemon's retry, which looks for Node afresh and starts the daemon once one is there. loki
 * never downloads Node itself.
 */
export function NodeNeeded({ missing, busy, onRecheck }: { missing: NodeMissing; busy: boolean; onRecheck: () => void }) {
  const help = nodeHelp(missing.os);
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ fontSize: 13.5, color: "var(--loki-fg)", lineHeight: 1.5 }}>Node 22 or newer is needed. loki runs your agents on it.</div>
      {missing.found && (
        <div className="loki-meta loki-meta--wrap">
          The Node found is {missing.found}
          {missing.at ? <> at <code style={mono}>{missing.at}</code></> : null}, older than {missing.needed}.
        </div>
      )}
      <div className="loki-meta loki-meta--wrap" style={{ lineHeight: 1.5 }}>
        <code style={mono}>{help.command}</code>
        {help.also ? <> or <code style={mono}>{help.also}</code></> : null} {help.note} Or get it from <a href="https://nodejs.org/">nodejs.org</a>. Then check again.
      </div>
      <Button size="sm" tone="positive" disabled={busy} onClick={onRecheck} style={{ justifySelf: "start" }}>
        {busy ? "checking…" : "check again"}
      </Button>
    </div>
  );
}

function Step({ n, title, done, active, children }: { n: number; title: string; done?: boolean; active: boolean; children: React.ReactNode }) {
  return (
    <section style={{ display: "grid", gridTemplateColumns: "28px 1fr", gap: 14, opacity: active || done ? 1 : 0.7 }}>
      <span aria-hidden style={{ width: 24, height: 24, borderRadius: "var(--loki-radius-lg)", display: "grid", placeItems: "center", fontSize: 12, fontWeight: 600, border: `1px solid ${done ? "var(--loki-positive)" : active ? "var(--loki-accent)" : "var(--loki-border)"}`, color: done ? "var(--loki-positive)" : active ? "var(--loki-accent)" : "var(--loki-muted)" }}>
        {done ? "✓" : n}
      </span>
      <div style={{ display: "grid", gap: 8 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "var(--loki-fg)" }}>{title}</div>
        {children}
      </div>
    </section>
  );
}

/** A labelled line of the form: the label column matches Settings' facts. */
function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: 10, alignItems: "start", fontSize: 12 }}>
      <span className="loki-label" style={{ paddingTop: 9 }}>{label}</span>
      <span style={{ display: "grid", gap: 4, minWidth: 0 }}>{children}</span>
    </label>
  );
}
