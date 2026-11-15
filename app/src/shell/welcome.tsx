import { useEffect, useRef, useState, type RefObject } from "react";
import { Button, Field, Sheet, TextArea, Title } from "../components";
import type { ConnectProvider } from "../../../core/attention/protocol.ts";
import { PERSONA_HINT } from "../agents/new-agent";
import { Providers } from "../settings/providers";
import { isConnected } from "../settings/provider-model";
import { Progress } from "@/ui/progress";
import type { DaemonStatus, Preparing, WelcomeStep } from "./bootstrap";
import { formatKeys } from "./keymap";
import { toolsWords } from "./os-words";
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

/**
 * First launch, as a sheet over the empty desk: a provider (skipped when one is connected), then the first agent, then
 * its desk. Shown only while the daemon lists no agents at all. Before the daemon runs it shows only the machine being
 * readied (`prepare`): the runtime downloading, the tools step, or why the daemon could not start. That is all someone
 * who finished Welcome before sees after an update that names a new Node.
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
  onInstallTools,
}: ProviderProps & {
  step: WelcomeStep;
  /** The shell's view of loki's daemon (null in a browser tab). */
  daemon: DaemonStatus | null;
  /** Run the shell's start sequence again (retry_daemon): the runtime, git, the daemon. */
  onRetryDaemon: () => Promise<void>;
  /** Have macOS install its command line tools (install_tools); what went wrong, if it could not. */
  onInstallTools: () => Promise<string | null>;
  models: string[] | null;
  /** Fetch the model list; the Skip for Now / Next button calls it, the shell does when it opens on the agent step. */
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
      // Nothing closes this sheet either: it goes once the daemon answers.
      <Sheet label="Welcome" width={640} top="10vh" scroll style={{ padding: 24, display: "grid", gap: 16 }}>
        <Intro
          title="Getting loki ready"
          line="loki downloads what it runs your agents on. This happens on first launch, and after an update that needs a newer version."
        />
        <PrepareStep status={daemon} onRetry={onRetryDaemon} onInstallTools={onInstallTools} />
      </Sheet>
    );

  return (
    // Nothing closes this sheet — it stays until the first agent exists — so the veil's click and Escape are no-ops.
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

/** The sheet's head: loki's mark, a title and a line under it. */
function Intro({ title, line }: { title: string; line: string }) {
  return (
    <div>
      {/* loki's mark, the L (app/public/mark.png). */}
      <img src="/mark.png" alt="" aria-hidden width={48} height={48} className="block" style={{ borderRadius: "var(--radius-lg)", marginBottom: 16 }} />
      <Title page>{title}</Title>
      <div style={{ fontSize: "var(--text-sm)", color: "var(--loki-muted)", marginTop: 8, lineHeight: 1.5 }}>{line}</div>
    </div>
  );
}

/** Step 1: the provider shortlist with Next / Skip for Now, then a line naming what connected. */
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
          {/* Moving on shows the agent form, which lists models; when the shell gets here on its own it asks for them itself. */}
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

/** Step 2: the form for the first agent; ↵ anywhere but the persona creates it. */
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

/**
 * The machine being readied, as the shell reports it: git missing (the tools step), the runtime downloading or failed
 * to (Preparation), or any other reason the daemon could not start. Try Again and Check Again run the shell's start
 * sequence again.
 */
export function PrepareStep({
  status,
  onRetry,
  onInstallTools,
}: {
  status: DaemonStatus | null;
  onRetry: () => Promise<void>;
  onInstallTools: () => Promise<string | null>;
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
  if (status?.toolsMissing) return <Tools os={status.toolsMissing} busy={busy} asked={asked} problem={problem} onInstall={install} onCheck={retry} />;
  if (status?.preparing) return <Preparation preparing={status.preparing} error={status.error} busy={busy} onRetry={retry} />;
  return <DaemonProblem error={status?.error ?? null} busy={busy} onRetry={retry} />;
}

/** Megabytes as the download line says them: whole, as the system's own download windows do. */
const megabytes = (bytes: number) => Math.round(bytes / 1_000_000);

/**
 * The runtime downloading (Node, or PortableGit on Windows): what, a bar, and how far along. A download that failed
 * says what failed, the error and Try Again.
 */
export function Preparation({ preparing, error, busy, onRetry }: { preparing: Preparing; error: string | null; busy: boolean; onRetry: () => void }) {
  const what = `${preparing.name === "git" ? "PortableGit" : "Node"} ${preparing.version}`;
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

/**
 * git is missing: on the Mac, Apple's command line tools, with a button that has macOS install them; on Linux, the
 * package commands to run. Check Again looks once more and starts the daemon when git is there.
 */
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
  /** macOS was asked to install the tools. */
  asked: boolean;
  /** Why asking failed, if it did. */
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

/** Any other reason the daemon could not start: the reason, where its log is, and Check Again. */
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

/** A labelled line of the form: the label column matches Settings' facts. */
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
