import { useEffect, useState } from "react";
import type { ConnectProvider } from "../../../packages/core/src/attention/protocol.ts";
import { btn } from "../chat/ui";
import { SHORTLIST, canConnect, fieldValues, fieldsFor, isConnected, needsTerminal, sortProviders } from "./provider-model";

/**
 * Model providers as rows: connected first, then the usual suspects, then everything the harness
 * knows behind a filter. A row opens into the harness's own field list; the key is checked against
 * the provider before it is saved, and never shown again afterwards. OAuth entries connect in the
 * terminal, the app just says how.
 */
export function Providers({
  providers,
  onLoad,
  onConnect,
  onDisconnect,
  onChanged,
  shortlist = false,
}: {
  providers: ConnectProvider[] | null;
  onLoad: () => Promise<unknown>;
  onConnect: (providerId: string, fields: Record<string, string>, authMethodId?: string) => Promise<string | null>;
  onDisconnect: (providerId: string) => Promise<string | null>;
  /** After a connect or disconnect: the model list is stale. */
  onChanged?: () => void;
  /** Welcome: the shortlist open, the rest behind "more". */
  shortlist?: boolean;
}) {
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [more, setMore] = useState(!shortlist);
  useEffect(() => {
    if (providers === null) void onLoad();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers === null]);

  if (providers === null) return <div style={{ fontSize: 12, color: "var(--loki-muted)" }}>asking the harness…</div>;
  const sorted = sortProviders(providers, filter);
  const shown = more || filter ? sorted : sorted.filter((p) => isConnected(p) || SHORTLIST.includes(p.id));
  const connectedCount = providers.filter(isConnected).length;

  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={`filter ${providers.length} providers`}
          aria-label="filter providers"
          autoComplete="off"
          data-1p-ignore
          data-form-type="other"
          style={{ flex: 1, padding: "6px 10px", fontSize: 12, background: "var(--loki-well)", border: "1px solid var(--loki-border)", borderRadius: 6, color: "var(--loki-fg)", outline: "none" }}
        />
        <span style={{ fontSize: 12, color: "var(--loki-muted)", whiteSpace: "nowrap" }}>{connectedCount === 0 ? "none connected" : `${connectedCount} connected`}</span>
      </div>
      <div style={{ display: "grid", gap: 2 }}>
        {shown.map((p) => (
          <ProviderRow key={p.id} p={p} open={open === p.id} onToggle={() => setOpen(open === p.id ? null : p.id)} onConnect={onConnect} onDisconnect={onDisconnect} onChanged={onChanged} />
        ))}
        {shown.length === 0 && <div style={{ fontSize: 12, color: "var(--loki-muted)", padding: "6px 8px" }}>nothing matches</div>}
      </div>
      {!more && !filter && sorted.length > shown.length && (
        <button type="button" onClick={() => setMore(true)} style={{ ...btn(), justifySelf: "start" }}>
          {sorted.length - shown.length} more providers
        </button>
      )}
    </div>
  );
}

function ProviderRow({ p, open, onToggle, onConnect, onDisconnect, onChanged }: { p: ConnectProvider; open: boolean; onToggle: () => void; onConnect: Parameters<typeof Providers>[0]["onConnect"]; onDisconnect: Parameters<typeof Providers>[0]["onDisconnect"]; onChanged?: () => void }) {
  const connected = isConnected(p);
  const terminal = needsTerminal(p);
  const [method, setMethod] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { authMethodId, fields } = fieldsFor(p, method);

  const connect = async () => {
    if (busy || !canConnect(fields, values)) return;
    setBusy(true);
    setError(null);
    const err = await onConnect(p.id, fieldValues(fields, values), authMethodId ?? undefined);
    setBusy(false);
    if (err) return setError(err);
    setValues({});
    onChanged?.();
    onToggle();
  };
  const disconnect = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const err = await onDisconnect(p.id);
    setBusy(false);
    if (err) return setError(err);
    onChanged?.();
  };

  return (
    <div style={{ border: `1px solid ${open ? "var(--loki-border)" : "transparent"}`, borderRadius: 8, background: open ? "var(--loki-panel)" : "transparent" }}>
      <button type="button" onClick={onToggle} aria-expanded={open} style={{ display: "grid", gridTemplateColumns: "8px 1fr auto", gap: 10, alignItems: "center", width: "100%", textAlign: "left", padding: "7px 10px", border: "none", background: "transparent", color: "var(--loki-fg)", cursor: "pointer", font: "inherit", borderRadius: 8 }}>
        <span aria-hidden style={{ width: 6, height: 6, borderRadius: 3, background: connected ? "var(--loki-positive)" : "var(--loki-border)" }} />
        <span style={{ display: "grid", gap: 1, minWidth: 0 }}>
          <span style={{ fontSize: 13.5 }}>
            {p.display_name}
            {connected && <span className="loki-label" style={{ marginLeft: 8, fontSize: 9.5, color: "var(--loki-positive)" }}>connected</span>}
          </span>
          {p.description && !open && <span style={{ fontSize: 12, color: "var(--loki-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.description}</span>}
        </span>
        <span style={{ fontSize: 10.5, fontFamily: "var(--loki-mono)", color: "var(--loki-muted)" }}>{p.id}</span>
      </button>
      {open && (
        <div style={{ padding: "2px 10px 10px 24px", display: "grid", gap: 8 }}>
          {p.description && <div style={{ fontSize: 12, color: "var(--loki-muted)" }}>{p.description}</div>}
          {terminal ? (
            <div style={{ fontSize: 12, color: "var(--loki-fg)", display: "grid", gap: 6 }}>
              <span>This one signs in through the browser. Connect it from a terminal, then come back:</span>
              <code style={{ fontFamily: "var(--loki-mono)", fontSize: 12, padding: "6px 10px", background: "var(--loki-well)", borderRadius: 6, justifySelf: "start" }}>letta connect {p.id}</code>
            </div>
          ) : (
            <>
              {p.auth_methods && p.auth_methods.length > 1 && (
                <div role="radiogroup" aria-label="how to sign in" style={{ display: "inline-flex", gap: 4 }}>
                  {p.auth_methods.map((m) => (
                    <button key={m.id} type="button" role="radio" aria-checked={authMethodId === m.id} onClick={() => setMethod(m.id)} className="loki-label" style={{ padding: "4px 8px", fontSize: 9.5, border: `1px solid ${authMethodId === m.id ? "var(--loki-accent)" : "var(--loki-border)"}`, background: authMethodId === m.id ? "var(--loki-brass-soft)" : "transparent", color: authMethodId === m.id ? "var(--loki-accent)" : "var(--loki-muted)", cursor: "pointer" }}>
                      {m.label}
                    </button>
                  ))}
                </div>
              )}
              {fields.map((f) => (
                <label key={f.key} style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: 10, alignItems: "center", fontSize: 12 }}>
                  <span style={{ color: "var(--loki-muted)" }}>
                    {f.label}
                    {f.required === false ? <span style={{ opacity: 0.6 }}> · optional</span> : null}
                  </span>
                  <input
                    type={f.secret ? "password" : "text"}
                    value={values[f.key] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                    onKeyDown={(e) => e.key === "Enter" && void connect()}
                    placeholder={f.placeholder ?? (f.secret ? "pasted here, checked with the provider, then kept by Letta" : "")}
                    autoComplete="off"
                    spellCheck={false}
                    data-1p-ignore
                    data-form-type="other"
                    style={{ padding: "6px 10px", fontSize: 12, fontFamily: "var(--loki-mono)", background: "var(--loki-well)", border: "1px solid var(--loki-border)", borderRadius: 6, color: "var(--loki-fg)", outline: "none" }}
                  />
                </label>
              ))}
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button type="button" onClick={() => void connect()} disabled={busy || !canConnect(fields, values)} style={{ ...btn("var(--loki-accent)"), opacity: busy || !canConnect(fields, values) ? 0.5 : 1 }}>
                  {busy ? "checking…" : connected ? "replace the key" : "connect"}
                </button>
                {connected && (
                  <button type="button" onClick={() => void disconnect()} disabled={busy} style={btn()}>
                    disconnect
                  </button>
                )}
                {error && <span style={{ fontSize: 12, color: "var(--loki-negative)", fontFamily: "var(--loki-mono)" }}>{error}</span>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
