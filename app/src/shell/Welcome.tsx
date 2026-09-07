import { useEffect, useRef, useState } from "react";
import { LAYER } from "../kit/layers";
import { btn, kbd } from "../chat/ui";
import { PERSONALITIES, type ConnectProvider, type Personality } from "../attention/protocol";
import { Providers } from "../settings/Providers";
import { isConnected } from "../settings/provider-model";
import type { BootstrapStatus } from "./bootstrap";

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
}: {
  step: "letta" | "provider" | "agent";
  /** The shell's view of Letta Code on this machine (null in a browser tab). */
  bootstrap: BootstrapStatus | null;
  onInstallLetta: () => Promise<void>;
  providers: ConnectProvider[] | null;
  onLoadProviders: () => Promise<unknown>;
  onConnect: (providerId: string, fields: Record<string, string>, authMethodId?: string) => Promise<string | null>;
  onDisconnect: (providerId: string) => Promise<string | null>;
  onModelsChanged: () => void;
  models: string[] | null;
  onLoadModels: () => void;
  onCreate: (opts: { personality: Personality; name: string; description?: string; model?: string }) => Promise<{ id: string } | { error: string }>;
  onDone: (agentId: string) => void;
}) {
  const [skipProvider, setSkipProvider] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [personality, setPersonality] = useState<Personality>("memo");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const lettaStep = step === "letta";
  const showAgent = !lettaStep && (step === "agent" || skipProvider);
  useEffect(() => {
    if (showAgent) {
      onLoadModels();
      setTimeout(() => nameRef.current?.focus(), 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAgent]);
  const connected = providers?.some(isConnected) ?? false;

  const create = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    const r = await onCreate({ personality, name: name.trim(), description: description.trim() || undefined, model: model.trim() || undefined });
    setBusy(false);
    if ("error" in r) return setError(r.error);
    onDone(r.id);
  };

  return (
    <div style={{ position: "absolute", inset: 0, background: "var(--loki-veil)", display: "grid", placeItems: "start center", paddingTop: "10vh", zIndex: LAYER.modal, overflowY: "auto" }}>
      <div role="dialog" aria-label="welcome" className="loki-sheet" style={{ width: 640, maxWidth: "92vw", background: "var(--loki-panel)", border: "1px solid var(--loki-border)", borderRadius: 12, boxShadow: "var(--loki-shadow-sheet)", padding: "26px 28px 22px", display: "grid", gap: 18, marginBottom: 40 }}>
        <div>
          <div style={{ fontFamily: "var(--loki-display)", fontSize: 22, color: "var(--loki-fg)" }}>Welcome to loki</div>
          <div style={{ fontSize: 13.5, color: "var(--loki-muted)", marginTop: 6, lineHeight: 1.5 }}>
            A memory palace your agent builds. Two things before the first desk: a model to think with, and an agent to think.
          </div>
        </div>

        <Step n={0} title="Letta Code" done={!lettaStep} active={lettaStep}>
          {lettaStep ? (
            <LettaInstall status={bootstrap} onRetry={onInstallLetta} />
          ) : (
            <span style={{ fontSize: 12, color: "var(--loki-muted)", fontFamily: "var(--loki-mono)" }}>{bootstrap?.letta ? `${bootstrap.private ? "installed by loki · " : ""}${bootstrap.letta}` : "the harness this window is linked to"}</span>
          )}
        </Step>

        <Step n={1} title="a model provider" done={connected} active={!showAgent && !lettaStep}>
          {lettaStep ? (
            <span style={{ fontSize: 12, color: "var(--loki-muted)" }}>after Letta Code is in place</span>
          ) : !showAgent ? (
            <div style={{ display: "grid", gap: 10 }}>
              <Providers providers={providers} onLoad={onLoadProviders} onConnect={onConnect} onDisconnect={onDisconnect} onChanged={onModelsChanged} shortlist />
              <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: "var(--loki-muted)" }}>
                <span>Keys are checked with the provider and kept by Letta on this Mac; loki never sees them again.</span>
                <span style={{ flex: 1 }} />
                <button type="button" onClick={() => setSkipProvider(true)} style={btn()}>
                  {connected ? "next" : "skip for now"}
                </button>
              </div>
            </div>
          ) : (
            <span style={{ fontSize: 12, color: "var(--loki-muted)" }}>{connected ? `${providers!.filter(isConnected).map((p) => p.display_name).join(", ")}` : "none yet — Settings › providers, any time"}</span>
          )}
        </Step>

        <Step n={2} title="your first agent" active={showAgent}>
          {showAgent && (
            <div style={{ display: "grid", gap: 10 }} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLElement).tagName !== "TEXTAREA" && void create()}>
              <Field label="name">
                <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="ira, friday, atlas…" autoComplete="off" data-1p-ignore data-form-type="other" style={input} />
              </Field>
              <Field label="description">
                <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="what this agent is for (optional)" autoComplete="off" data-form-type="other" style={input} />
              </Field>
              <Field label="personality">
                <div role="radiogroup" style={{ display: "grid", gap: 4 }}>
                  {PERSONALITIES.map((p) => (
                    <button key={p.id} type="button" role="radio" aria-checked={personality === p.id} onClick={() => setPersonality(p.id)} style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: 10, textAlign: "left", padding: "6px 10px", border: `1px solid ${personality === p.id ? "var(--loki-accent)" : "var(--loki-border)"}`, borderRadius: 6, background: personality === p.id ? "var(--loki-brass-soft)" : "transparent", color: "var(--loki-fg)", cursor: "pointer", font: "inherit" }}>
                      <span style={{ fontSize: 13.5, color: personality === p.id ? "var(--loki-accent)" : "var(--loki-fg)" }}>{p.label}</span>
                      <span style={{ fontSize: 12, color: "var(--loki-muted)" }}>{p.description}</span>
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="model">
                <input list="loki-welcome-models" value={model} onChange={(e) => setModel(e.target.value)} placeholder={models === null ? "loading the model list…" : models.length ? "the harness default, or pick one" : "no models yet — connect a provider first"} autoComplete="off" data-form-type="other" style={{ ...input, fontFamily: "var(--loki-mono)" }} />
                <datalist id="loki-welcome-models">{(models ?? []).map((m) => <option key={m} value={m} />)}</datalist>
              </Field>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
                {error && <span style={{ fontSize: 12, color: "var(--loki-negative)", fontFamily: "var(--loki-mono)" }}>{error}</span>}
                <span style={{ flex: 1 }} />
                {step === "provider" && (
                  <button type="button" onClick={() => setSkipProvider(false)} style={btn()}>
                    back
                  </button>
                )}
                <button type="button" onClick={() => void create()} disabled={busy || !name.trim()} style={{ ...btn("var(--loki-accent)"), opacity: busy || !name.trim() ? 0.5 : 1 }}>
                  {busy ? "creating…" : "create and open the desk"} <kbd style={kbd}>↵</kbd>
                </button>
              </div>
            </div>
          )}
        </Step>
      </div>
    </div>
  );
}

/** Letta Code is being installed privately (or failed): the log as it comes, retry when it fails. */
function LettaInstall({ status, onRetry }: { status: BootstrapStatus | null; onRetry: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const lines = status?.log ?? [];
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ fontSize: 13.5, color: "var(--loki-fg)", lineHeight: 1.5 }}>
        {status?.error ? "Installing Letta Code did not finish." : status?.installing ? "This Mac has no Letta Code, so loki is installing a private copy under its own folder. Nothing else on the machine is touched." : "Looking for Letta Code…"}
      </div>
      {lines.length > 0 && (
        <pre style={{ margin: 0, maxHeight: 160, overflowY: "auto", padding: "8px 10px", fontSize: 10.5, lineHeight: 1.5, fontFamily: "var(--loki-mono)", color: "var(--loki-muted)", background: "var(--loki-well)", borderRadius: 6, whiteSpace: "pre-wrap" }}>
          {lines.slice(-12).join("\n")}
        </pre>
      )}
      {status?.error && (
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ fontSize: 12, color: "var(--loki-negative)", fontFamily: "var(--loki-mono)" }}>{status.error}</div>
          <div style={{ fontSize: 12, color: "var(--loki-muted)", lineHeight: 1.5 }}>
            Retry below, or install it yourself in a terminal and relaunch loki:
            <code style={{ display: "block", marginTop: 4, fontFamily: "var(--loki-mono)", padding: "6px 10px", background: "var(--loki-well)", borderRadius: 6 }}>npm install -g @letta-ai/letta-code</code>
          </div>
          <button type="button" disabled={busy} onClick={() => { setBusy(true); void onRetry().finally(() => setBusy(false)); }} style={{ ...btn("var(--loki-accent)"), justifySelf: "start", opacity: busy ? 0.5 : 1 }}>
            {busy ? "starting…" : "retry the install"}
          </button>
        </div>
      )}
      {!status?.error && status?.installing && <div style={{ fontSize: 12, color: "var(--loki-muted)" }}>Node 22 comes from nodejs.org if the Mac has none; Letta Code from registry.npmjs.org. A few minutes.</div>}
    </div>
  );
}

const input: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "7px 10px", fontSize: 13.5, background: "var(--loki-well)", border: "1px solid var(--loki-border)", borderRadius: 6, color: "var(--loki-fg)", outline: "none" };

function Step({ n, title, done, active, children }: { n: number; title: string; done?: boolean; active: boolean; children: React.ReactNode }) {
  return (
    <section style={{ display: "grid", gridTemplateColumns: "28px 1fr", gap: 14, opacity: active || done ? 1 : 0.7 }}>
      <span aria-hidden style={{ width: 24, height: 24, borderRadius: 12, display: "grid", placeItems: "center", fontSize: 12, fontFamily: "var(--loki-mono)", border: `1px solid ${done ? "var(--loki-positive)" : active ? "var(--loki-accent)" : "var(--loki-border)"}`, color: done ? "var(--loki-positive)" : active ? "var(--loki-accent)" : "var(--loki-muted)" }}>
        {done ? "✓" : n}
      </span>
      <div style={{ display: "grid", gap: 8 }}>
        <div style={{ fontFamily: "var(--loki-display)", fontSize: 15, color: "var(--loki-fg)" }}>{title}</div>
        {children}
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: 10, alignItems: "start", fontSize: 12 }}>
      <span className="loki-label" style={{ fontSize: 9.5, paddingTop: 9 }}>{label}</span>
      <span style={{ display: "grid", gap: 4, minWidth: 0 }}>{children}</span>
    </label>
  );
}
