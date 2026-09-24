import { useEffect, useRef, useState, type RefObject } from "react";
import { Button, Field, Sheet, Title } from "../components";
import { PERSONALITIES, type ConnectProvider, type Personality } from "../../../core/attention/protocol.ts";
import { Providers } from "../settings/Providers";
import { isConnected } from "../settings/provider-model";
import { lettaPhase, nodeHelp, type BootstrapStatus, type NodeMissing } from "./bootstrap";
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
 * the first agent, then its desk. Shown only while the harness lists no agents at all.
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
  bootstrap,
  onInstallLetta,
}: ProviderProps & {
  step: "letta" | "provider" | "agent";
  /** The shell's view of Letta Code on this machine (null in a browser tab). */
  bootstrap: BootstrapStatus | null;
  onInstallLetta: () => Promise<void>;
  models: string[] | null;
  /** Fetch the model list; the "skip for now" / "next" button calls it, the shell does when it opens on the agent step. */
  onLoadModels: () => void;
  onCreate: CreateAgent;
  onDone: (agentId: string) => void;
}) {
  const [skipProvider, setSkipProvider] = useState(false);
  const draft = useAgentDraft(onCreate, onDone);
  const nameRef = useRef<HTMLInputElement>(null);
  const lettaStep = step === "letta";
  const showAgent = !lettaStep && (step === "agent" || skipProvider);
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
          A memory palace your agent builds. Two things before the first desk: a model to think with, and an agent to think.
        </div>
      </div>

      <Step n={0} title="Letta Code" done={!lettaStep} active={lettaStep}>
        <LettaStep lettaStep={lettaStep} bootstrap={bootstrap} onInstallLetta={onInstallLetta} />
      </Step>

      <Step n={1} title="A model provider" done={connected} active={!showAgent && !lettaStep}>
        <ProviderStep lettaStep={lettaStep} showAgent={showAgent} connected={connected} providers={providers} onLoadProviders={onLoadProviders} onConnect={onConnect} onDisconnect={onDisconnect} onModelsChanged={onModelsChanged} onNext={() => (setSkipProvider(true), onLoadModels())} />
      </Step>

      <Step n={2} title="Your first agent" active={showAgent}>
        {showAgent && <AgentForm draft={draft} nameRef={nameRef} models={models} canGoBack={step === "provider"} onBack={() => setSkipProvider(false)} />}
      </Step>
    </Sheet>
  );
}

/** Step 0: the install as it runs, or the Letta Code this window is linked to once it is done. */
function LettaStep({ lettaStep, bootstrap, onInstallLetta }: { lettaStep: boolean; bootstrap: BootstrapStatus | null; onInstallLetta: () => Promise<void> }) {
  return lettaStep ? (
    <LettaInstall status={bootstrap} onRetry={onInstallLetta} />
  ) : (
    <span className="loki-meta loki-meta--wrap" style={{ fontFamily: "var(--loki-mono)" }}>{bootstrap?.letta ?? "the harness this window is linked to"}</span>
  );
}

/** Step 1: waits for Letta Code, then the provider shortlist with "next" / "skip for now", then a line naming what connected. */
function ProviderStep({ lettaStep, showAgent, connected, providers, onLoadProviders, onConnect, onDisconnect, onModelsChanged, onNext }: ProviderProps & { lettaStep: boolean; showAgent: boolean; connected: boolean; onNext: () => void }) {
  if (lettaStep) return <span className="loki-meta loki-meta--wrap">after Letta Code is in place</span>;
  if (!showAgent)
    return (
      <div style={{ display: "grid", gap: 10 }}>
        <Providers providers={providers} onLoad={onLoadProviders} onConnect={onConnect} onDisconnect={onDisconnect} onChanged={onModelsChanged} shortlist />
        <div className="loki-meta loki-meta--wrap" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span>Keys are checked with the provider and kept by Letta on this Mac; loki never sees them again.</span>
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

/** Step 2: the form for the first agent; ↵ anywhere but the description creates it. */
function AgentForm({ draft, nameRef, models, canGoBack, onBack }: { draft: ReturnType<typeof useAgentDraft>; nameRef: RefObject<HTMLInputElement | null>; models: string[] | null; canGoBack: boolean; onBack: () => void }) {
  const { name, setName, description, setDescription, personality, setPersonality, model, setModel, busy, error, create } = draft;
  return (
    <div style={{ display: "grid", gap: 10 }} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLElement).tagName !== "TEXTAREA" && void create()}>
      <Labelled label="Name">
        <Field ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="ira, friday, atlas…" autoComplete="off" data-1p-ignore data-form-type="other" />
      </Labelled>
      <Labelled label="Description">
        <Field value={description} onChange={(e) => setDescription(e.target.value)} placeholder="what this agent is for (optional)" autoComplete="off" data-form-type="other" />
      </Labelled>
      <Labelled label="Personality">
        <PersonalityPicker value={personality} onPick={setPersonality} />
      </Labelled>
      <Labelled label="Model">
        <Field mono list="loki-welcome-models" value={model} onChange={(e) => setModel(e.target.value)} placeholder={models === null ? "loading the model list…" : models.length ? "the harness default, or pick one" : "no models yet — connect a provider first"} autoComplete="off" data-form-type="other" />
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
          {busy ? "creating…" : "create and open the desk"}
        </Button>
      </div>
    </div>
  );
}

/** The personalities as a radio group, one row each. */
function PersonalityPicker({ value, onPick }: { value: Personality; onPick: (p: Personality) => void }) {
  return (
    <div role="radiogroup" style={{ display: "grid", gap: 4 }}>
      {PERSONALITIES.map((p) => (
        <button key={p.id} type="button" role="radio" aria-checked={value === p.id} onClick={() => onPick(p.id)} style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: 10, textAlign: "left", padding: "6px 10px", border: `1px solid ${value === p.id ? "var(--loki-accent)" : "var(--loki-border)"}`, borderRadius: "var(--loki-radius-sm)", background: value === p.id ? "var(--loki-brass-soft)" : "transparent", color: "var(--loki-fg)", cursor: "pointer", font: "inherit" }}>
          <span style={{ fontSize: 13.5, color: value === p.id ? "var(--loki-accent)" : "var(--loki-fg)" }}>{p.label}</span>
          <span className="loki-meta loki-meta--wrap">{p.description}</span>
        </button>
      ))}
    </div>
  );
}

/** Letta Code is being installed with npm (or failed): the log as it comes, retry when it fails; no Node to install it with: the Node step. */
export function LettaInstall({ status, onRetry }: { status: BootstrapStatus | null; onRetry: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const lines = status?.log ?? [];
  const retry = () => {
    setBusy(true);
    void onRetry().finally(() => setBusy(false));
  };
  if (lettaPhase(status) === "node" && status?.node_missing) return <NodeNeeded missing={status.node_missing} busy={busy} onRecheck={retry} />;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ fontSize: 13.5, color: "var(--loki-fg)", lineHeight: 1.5 }}>
        {status?.error ? "Installing Letta Code did not finish." : status?.installing ? "This Mac has no Letta Code, so loki is installing it with npm — the same install a terminal's npm install -g makes, into npm's global folder, so the letta command works there too." : "Looking for Letta Code…"}
      </div>
      {lines.length > 0 && (
        <pre style={{ margin: 0, maxHeight: 160, overflowY: "auto", padding: "8px 10px", fontSize: 10.5, lineHeight: 1.5, fontFamily: "var(--loki-mono)", color: "var(--loki-muted)", background: "var(--loki-well)", borderRadius: "var(--loki-radius-sm)", whiteSpace: "pre-wrap" }}>
          {lines.slice(-12).join("\n")}
        </pre>
      )}
      {status?.error && (
        <div style={{ display: "grid", gap: 8 }}>
          <div className="loki-meta loki-meta--negative loki-meta--wrap">{status.error}</div>
          <div className="loki-meta loki-meta--wrap" style={{ lineHeight: 1.5 }}>
            The install needs a Node 22 or newer with npm (Homebrew's <code style={{ fontFamily: "var(--loki-mono)" }}>brew install node</code>; the loki cask
            brings it) and registry.npmjs.org to be reachable. A global folder npm may not write needs the sudo line above, run in a terminal. Retry below
            once it is fixed. Every line of every attempt is in <code style={{ fontFamily: "var(--loki-mono)" }}>~/.letta/loki/logs/install.log</code>.
          </div>
          <Button size="sm" tone="positive" disabled={busy} onClick={retry} style={{ justifySelf: "start" }}>
            {busy ? "starting…" : "retry the install"}
          </Button>
        </div>
      )}
      {!status?.error && status?.installing && <div className="loki-meta loki-meta--wrap">npm from the Node already on this Mac; Letta Code from registry.npmjs.org. A few minutes.</div>}
    </div>
  );
}

/**
 * No Node 22 or newer anywhere loki looks: what to install, this system's usual command, the nodejs.org link, and
 * one button — the install's own retry, which looks for Node afresh and goes on to npm once one is there. loki
 * never downloads Node itself.
 */
export function NodeNeeded({ missing, busy, onRecheck }: { missing: NodeMissing; busy: boolean; onRecheck: () => void }) {
  const help = nodeHelp(missing.os);
  const mono = { fontFamily: "var(--loki-mono)" };
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ fontSize: 13.5, color: "var(--loki-fg)", lineHeight: 1.5 }}>Node 22 or newer is needed. Letta Code runs on it, and its npm installs Letta Code.</div>
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
