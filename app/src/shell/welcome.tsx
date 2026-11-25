import { useEffect, useRef, useState, type RefObject } from "react";
import { Button, Field, Sheet, TextArea, Title } from "../components";
import type { ConnectProvider } from "../../../core/attention/protocol.ts";
import { PERSONA_HINT } from "../agents/new-agent";
import { Providers } from "../settings/providers";
import { isConnected } from "../settings/provider-model";
import { Progress } from "@/ui/progress";
import { platform, type Platform } from "../desk/env";
import type { DaemonStatus, NeedsNode, Preparing, WelcomeStep } from "./bootstrap";
import { formatKeys } from "./keymap";
import { nodeWords, toolsWords } from "./os-words";
import { useAgentDraft, type CreateAgent } from "./use-agent-draft";
import { CheckIcon } from "lucide-react";
import { Glyph } from "../shared/icons";

interface ProviderProps {
  providers: ConnectProvider[] | null;
  onLoadProviders: () => Promise<unknown>;
  onConnect: (providerId: string, fields: Record<string, string>, authMethodId?: string) => Promise<string | null>;
  onDisconnect: (providerId: string) => Promise<string | null>;
  onModelsChanged: () => void;
}

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
  onInstallTools,
  onInstallNode,
}: ProviderProps & {
  step: WelcomeStep;
  daemon: DaemonStatus | null;
  onRetryDaemon: () => Promise<void>;
  onInstallTools: () => Promise<string | null>;
  onInstallNode: () => Promise<string | null>;
  models: string[] | null;
  onLoadModels: () => void;
  onCreate: CreateAgent;
  onDone: (agentId: string) => void;
}) {
  const [skipProvider, setSkipProvider] = useState(false);
  const draft = useAgentDraft(onCreate, onDone);
  const nameRef = useRef<HTMLInputElement>(null);
  const showAgent = step === "agent" || (step === "provider" && skipProvider);
  useEffect(() => {
    if (!showAgent) return;
    const t = setTimeout(() => nameRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [showAgent]);
  const connected = providers?.some(isConnected) ?? false;

  if (step === "prepare")
    return (
      <Sheet label="Welcome" width={640} top="10vh" scroll style={{ padding: 24, display: "grid", gap: 16 }}>
        <Intro title="Getting loki ready" line="loki checks this computer has what it runs your agents on. This happens on first launch." />
        <PrepareStep status={daemon} onRetry={onRetryDaemon} onInstallTools={onInstallTools} onInstallNode={onInstallNode} />
      </Sheet>
    );

  return (
    <Sheet label="Welcome" width={640} top="10vh" scroll style={{ padding: 24, display: "grid", gap: 16 }}>
      <Intro
        title="Welcome to loki"
        line="A memory palace your agent builds. Two things before the first chat: a model to think with, and an agent to think."
      />

      <Step n={1} title="A model provider" done={connected} active={!showAgent}>
        <ProviderStep
          showAgent={showAgent}
          connected={connected}
          providers={providers}
          onLoadProviders={onLoadProviders}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
          onModelsChanged={onModelsChanged}
          onNext={() => (setSkipProvider(true), onLoadModels())}
        />
      </Step>

      <Step n={2} title="Your first agent" active={showAgent}>
        {showAgent && <AgentForm draft={draft} nameRef={nameRef} models={models} canGoBack={step === "provider"} onBack={() => setSkipProvider(false)} />}
      </Step>
    </Sheet>
  );
}

function Intro({ title, line }: { title: string; line: string }) {
  return (
    <div>
      <img src="/mark.png" alt="" aria-hidden width={48} height={48} className="block" style={{ borderRadius: "var(--radius-lg)", marginBottom: 16 }} />
      <Title page>{title}</Title>
      <div style={{ fontSize: "var(--text-sm)", color: "var(--loki-muted)", marginTop: 8, lineHeight: 1.5 }}>{line}</div>
    </div>
  );
}

function ProviderStep({
  showAgent,
  connected,
  providers,
  onLoadProviders,
  onConnect,
  onDisconnect,
  onModelsChanged,
  onNext,
}: ProviderProps & { showAgent: boolean; connected: boolean; onNext: () => void }) {
  if (!showAgent)
    return (
      <div className="grid gap-3">
        <Providers providers={providers} onLoad={onLoadProviders} onConnect={onConnect} onDisconnect={onDisconnect} onChanged={onModelsChanged} shortlist />
        <div className="loki-meta loki-meta--wrap flex items-center gap-2">
          <span>Keys are checked with the provider and kept in this computer's keychain.</span>
          <span className="flex-1" />
          <Button size="sm" onClick={onNext}>
            {connected ? "Next" : "Skip for Now"}
          </Button>
        </div>
      </div>
    );
  return (
    <span className="loki-meta loki-meta--wrap">
      {connected
        ? (providers ?? [])
            .filter(isConnected)
            .map((p) => p.display_name)
            .join(", ")
        : "none yet — Preferences › Providers, any time"}
    </span>
  );
}

function AgentForm({
  draft,
  nameRef,
  models,
  canGoBack,
  onBack,
}: {
  draft: ReturnType<typeof useAgentDraft>;
  nameRef: RefObject<HTMLInputElement | null>;
  models: string[] | null;
  canGoBack: boolean;
  onBack: () => void;
}) {
  const { name, setName, description, setDescription, persona, setPersona, model, setModel, busy, error, create } = draft;
  return (
    <div className="grid gap-3" onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLElement).tagName !== "TEXTAREA" && void create()}>
      <Labelled label="Name">
        <Field
          ref={nameRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="atlas, scout, sage…"
          autoComplete="off"
          data-1p-ignore
          data-form-type="other"
        />
      </Labelled>
      <Labelled label="Description">
        <Field
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this agent is for (optional)"
          autoComplete="off"
          data-form-type="other"
        />
      </Labelled>
      <Labelled label="Persona">
        <TextArea rows={4} value={persona} onChange={(e) => setPersona(e.target.value)} placeholder={PERSONA_HINT} data-form-type="other" />
      </Labelled>
      <Labelled label="Model">
        <Field
          mono
          list="loki-welcome-models"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={models === null ? "Loading the model list…" : models.length ? "The default, or pick one" : "No models yet — connect a provider first"}
          autoComplete="off"
          data-form-type="other"
        />
        <datalist id="loki-welcome-models">
          {(models ?? []).map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </Labelled>
      <div className="flex items-center gap-2" style={{ marginTop: 4 }}>
        {error && (
          <span role="alert" className="loki-meta loki-meta--negative loki-meta--wrap">
            {error}
          </span>
        )}
        <span className="flex-1" />
        {canGoBack && (
          <Button size="sm" onClick={onBack}>
            Back
          </Button>
        )}
        <Button size="sm" tone="positive" kbd={formatKeys("enter")} onClick={() => void create()} disabled={busy || !name.trim()}>
          {busy ? "Creating…" : "Create and Open the Chat"}
        </Button>
      </div>
    </div>
  );
}

export function PrepareStep({
  status,
  onRetry,
  onInstallTools,
  onInstallNode = () => Promise.resolve(null),
}: {
  status: DaemonStatus | null;
  onRetry: () => Promise<void>;
  onInstallTools: () => Promise<string | null>;
  onInstallNode?: () => Promise<string | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const retry = () => {
    setBusy(true);
    void onRetry().finally(() => setBusy(false));
  };
  const install = () => {
    setProblem(null);
    void onInstallTools().then((err) => {
      setAsked(!err);
      setProblem(err);
    });
  };
  const installNode = () => {
    setProblem(null);
    setBusy(true);
    void onInstallNode()
      .then((err) => {
        setAsked(!err);
        setProblem(err);
      })
      .finally(() => setBusy(false));
  };
  if (status?.needsNode)
    return <NodeNeeded os={platform} needs={status.needsNode} busy={busy} asked={asked} problem={problem} onInstall={installNode} onCheck={retry} />;
  if (status?.toolsMissing) return <Tools os={status.toolsMissing} busy={busy} asked={asked} problem={problem} onInstall={install} onCheck={retry} />;
  if (status?.preparing) return <Preparation preparing={status.preparing} error={status.error} busy={busy} onRetry={retry} />;
  return <DaemonProblem error={status?.error ?? null} busy={busy} onRetry={retry} />;
}

const megabytes = (bytes: number) => Math.round(bytes / 1_000_000);

export function Preparation({ preparing, error, busy, onRetry }: { preparing: Preparing; error: string | null; busy: boolean; onRetry: () => void }) {
  const what = `PortableGit ${preparing.version}`;
  if (error)
    return (
      <div className="grid gap-2">
        <div style={{ fontSize: "var(--text-sm)", color: "var(--loki-fg)", lineHeight: 1.5 }}>{`loki could not download ${what}.`}</div>
        <div className="loki-meta loki-meta--negative loki-meta--wrap">{error}</div>
        <Button size="sm" tone="positive" disabled={busy} onClick={onRetry} className="justify-self-start">
          {busy ? "Trying…" : "Try Again"}
        </Button>
      </div>
    );
  const { done, total } = preparing;
  const percent = total ? Math.min(100, Math.round((done / total) * 100)) : null;
  const far = total ? `${megabytes(done)} of ${megabytes(total)} MB` : done > 0 ? `${megabytes(done)} MB` : "Connecting…";
  return (
    <div className="grid gap-2">
      <div style={{ fontSize: "var(--text-sm)", color: "var(--loki-fg)", lineHeight: 1.5 }}>{`Downloading ${what}`}</div>
      <Progress value={percent} aria-label={`Downloading ${what}`} />
      <div className="loki-meta loki-meta--wrap">{far}</div>
      <div className="loki-meta loki-meta--wrap" style={{ lineHeight: 1.5 }}>
        loki checks it against the checksum it was built with before it runs anything.
      </div>
    </div>
  );
}

export function Tools({
  os,
  busy,
  asked,
  problem,
  onInstall,
  onCheck,
}: {
  os: "macos" | "linux";
  busy: boolean;
  asked: boolean;
  problem: string | null;
  onInstall: () => void;
  onCheck: () => void;
}) {
  const words = toolsWords(os);
  return (
    <div className="grid gap-2">
      <div style={{ fontSize: "var(--text-sm)", fontWeight: 700, color: "var(--loki-fg)" }}>{words.title}</div>
      <div style={{ fontSize: "var(--text-sm)", color: "var(--loki-fg)", lineHeight: 1.5 }}>{words.needed}</div>
      {words.commands.length > 0 && (
        <div className="loki-meta loki-meta--wrap" style={{ lineHeight: 1.5 }}>
          {words.commands.map((c, i) => (
            <span key={c}>
              {i > 0 && " or "}
              <code className="loki-mono">{c}</code>
            </span>
          ))}{" "}
          {words.where}
        </div>
      )}
      {asked && words.asked && <div className="loki-meta loki-meta--wrap">{words.asked}</div>}
      {problem && <div className="loki-meta loki-meta--negative loki-meta--wrap">{problem}</div>}
      <div className="flex items-center gap-2">
        {words.install && (
          <Button size="sm" tone="positive" disabled={busy} onClick={onInstall}>
            {words.install}
          </Button>
        )}
        <Button size="sm" tone={words.install ? undefined : "positive"} disabled={busy} onClick={onCheck}>
          {busy ? "Checking…" : "Check Again"}
        </Button>
      </div>
    </div>
  );
}

export function NodeNeeded({
  os,
  needs,
  busy,
  asked,
  problem,
  onInstall,
  onCheck,
}: {
  os: Platform;
  needs: NeedsNode;
  busy: boolean;
  asked: boolean;
  problem: string | null;
  onInstall: () => void;
  onCheck: () => void;
}) {
  const words = nodeWords(os, needs);
  return (
    <div className="grid gap-2">
      <div style={{ fontSize: "var(--text-sm)", fontWeight: 700, color: "var(--loki-fg)" }}>{words.title}</div>
      <div style={{ fontSize: "var(--text-sm)", color: "var(--loki-fg)", lineHeight: 1.5 }}>{words.needed}</div>
      {words.commands.length > 0 && (
        <div className="loki-meta loki-meta--wrap" style={{ lineHeight: 1.5 }}>
          {words.commands.map((c, i) => (
            <span key={c}>
              {i > 0 && " then "}
              <code className="loki-mono">{c}</code>
            </span>
          ))}{" "}
          {words.where}
        </div>
      )}
      {asked && words.asked && <div className="loki-meta loki-meta--wrap">{words.asked}</div>}
      {problem && <div className="loki-meta loki-meta--negative loki-meta--wrap">{problem}</div>}
      <div className="flex items-center gap-2">
        {words.install && (
          <Button size="sm" tone="positive" disabled={busy} onClick={onInstall}>
            {busy ? "Installing…" : words.install}
          </Button>
        )}
        <Button size="sm" tone={words.install ? undefined : "positive"} disabled={busy} onClick={onCheck}>
          Check Again
        </Button>
      </div>
    </div>
  );
}

function DaemonProblem({ error, busy, onRetry }: { error: string | null; busy: boolean; onRetry: () => void }) {
  return (
    <div className="grid gap-2">
      <div style={{ fontSize: "var(--text-sm)", color: "var(--loki-fg)", lineHeight: 1.5 }}>loki could not start the process that runs your agents.</div>
      {error && <div className="loki-meta loki-meta--negative loki-meta--wrap">{error}</div>}
      <div className="loki-meta loki-meta--wrap" style={{ lineHeight: 1.5 }}>
        Its log is <code className="loki-mono">~/.loki/logs/daemon.log</code>.
      </div>
      <Button size="sm" tone="positive" disabled={busy} onClick={onRetry} className="justify-self-start">
        {busy ? "Checking…" : "Check Again"}
      </Button>
    </div>
  );
}

function Step({ n, title, done, active, children }: { n: number; title: string; done?: boolean; active: boolean; children: React.ReactNode }) {
  return (
    <section className="grid grid-cols-[28px_1fr] gap-3" style={{ opacity: active || done ? 1 : 0.7 }}>
      <span
        aria-hidden
        className="grid place-items-center"
        style={{
          width: 24,
          height: 24,
          borderRadius: "var(--radius-xl)",
          fontSize: "var(--text-xs)",
          fontWeight: 600,
          border: `1px solid ${done ? "var(--loki-positive)" : active ? "var(--loki-accent)" : "var(--loki-border)"}`,
          color: done ? "var(--loki-positive)" : active ? "var(--loki-accent)" : "var(--loki-muted)",
        }}
      >
        {done ? <Glyph icon={CheckIcon} /> : n}
      </span>
      <div className="grid gap-2">
        <div style={{ fontSize: "var(--text-sm)", fontWeight: 700, color: "var(--loki-fg)" }}>{title}</div>
        {children}
      </div>
    </section>
  );
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid grid-cols-[90px_1fr] items-start gap-3" style={{ fontSize: "var(--text-xs)" }}>
      <span className="loki-label" style={{ paddingTop: 8 }}>
        {label}
      </span>
      <span className="grid min-w-0 gap-1">{children}</span>
    </label>
  );
}
