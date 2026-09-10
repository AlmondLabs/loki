import { useEffect, useId, useState } from "react";
import type { ConnectProvider } from "../../../packages/core/src/attention/protocol.ts";
import { Button, Chip, Dot, Field, Row } from "../components";
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
        <Field
          size="sm"
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={`filter ${providers.length} providers`}
          aria-label="filter providers"
          autoComplete="off"
          data-1p-ignore
          data-form-type="other"
          style={{ flex: 1 }}
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
        <Button size="sm" onClick={() => setMore(true)} style={{ justifySelf: "start" }}>
          {sorted.length - shown.length} more providers
        </Button>
      )}
    </div>
  );
}

type ConnectFn = Parameters<typeof Providers>[0]["onConnect"];
type DisconnectFn = Parameters<typeof Providers>[0]["onDisconnect"];

/**
 * One row's connect state: the auth method picked, the field values typed, the busy flag and the
 * last error, with connect and disconnect on top. It lives in the row, not the form, so a half-typed
 * key survives folding the row shut.
 */
function useProviderConnect(p: ConnectProvider, onConnect: ConnectFn, onDisconnect: DisconnectFn, onChanged: (() => void) | undefined, onToggle: () => void) {
  const [method, setMethod] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { authMethodId, fields } = fieldsFor(p, method);

  const connect = async () => {
    if (busy || !canConnect(fields, values)) return;
    setBusy(true);
    setError(null);
    try {
      const err = await onConnect(p.id, fieldValues(fields, values), authMethodId ?? undefined);
      if (err) return setError(err);
      setValues({});
      onChanged?.();
      onToggle();
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const err = await onDisconnect(p.id);
      if (err) return setError(err);
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };
  return { authMethodId, fields, setMethod, values, setValues, busy, error, connect, disconnect };
}

type ConnectState = ReturnType<typeof useProviderConnect>;

function ProviderRow({ p, open, onToggle, onConnect, onDisconnect, onChanged }: { p: ConnectProvider; open: boolean; onToggle: () => void; onConnect: ConnectFn; onDisconnect: DisconnectFn; onChanged?: () => void }) {
  const connected = isConnected(p);
  const terminal = needsTerminal(p);
  const state = useProviderConnect(p, onConnect, onDisconnect, onChanged, onToggle);

  return (
    <div style={{ border: `1px solid ${open ? "var(--loki-border)" : "transparent"}`, borderRadius: 8, background: open ? "var(--loki-panel)" : "transparent" }}>
      <Row onClick={onToggle} aria-expanded={open}>
        <Dot aria-hidden color={connected ? "var(--loki-positive)" : "var(--loki-border)"} />
        <span style={{ display: "grid", gap: 1, minWidth: 0, flex: 1 }}>
          <span style={{ fontSize: 13.5 }}>
            {p.display_name}
            {connected && <span className="loki-label" style={{ marginLeft: 8, fontSize: 9.5, color: "var(--loki-positive)" }}>connected</span>}
          </span>
          {p.description && !open && <span style={{ fontSize: 12, color: "var(--loki-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.description}</span>}
        </span>
        <span style={{ fontSize: 10.5, fontFamily: "var(--loki-mono)", color: "var(--loki-muted)" }}>{p.id}</span>
      </Row>
      {open && (
        <div style={{ padding: "2px 10px 10px 24px", display: "grid", gap: 8 }}>
          {p.description && <div style={{ fontSize: 12, color: "var(--loki-muted)" }}>{p.description}</div>}
          {terminal ? <TerminalNote id={p.id} /> : <ConnectForm p={p} connected={connected} state={state} />}
        </div>
      )}
    </div>
  );
}

/** An OAuth provider: the app cannot open the browser flow, so it says which command does. */
function TerminalNote({ id }: { id: string }) {
  return (
    <div style={{ fontSize: 12, color: "var(--loki-fg)", display: "grid", gap: 6 }}>
      <span>This one signs in through the browser. Connect it from a terminal, then come back:</span>
      <code style={{ fontFamily: "var(--loki-mono)", fontSize: 12, padding: "6px 10px", background: "var(--loki-well)", borderRadius: 6, justifySelf: "start" }}>letta connect {id}</code>
    </div>
  );
}

/** The open row's form: a method picker when the provider has more than one, the harness's fields, connect / disconnect, the error. */
function ConnectForm({ p, connected, state }: { p: ConnectProvider; connected: boolean; state: ConnectState }) {
  const { authMethodId, fields, setMethod, values, setValues, busy, error, connect, disconnect } = state;
  /** Each field's input is `${fieldId}-${key}`, so its label can name it. */
  const fieldId = useId();
  return (
    <>
      {p.auth_methods && p.auth_methods.length > 1 && (
        <div role="radiogroup" aria-label="how to sign in" style={{ display: "inline-flex", gap: 4 }}>
          {p.auth_methods.map((m) => (
            <Chip key={m.id} label role="radio" aria-checked={authMethodId === m.id} active={authMethodId === m.id} onClick={() => setMethod(m.id)}>
              {m.label}
            </Chip>
          ))}
        </div>
      )}
      {fields.map((f) => (
        <label key={f.key} htmlFor={`${fieldId}-${f.key}`} style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: 10, alignItems: "center", fontSize: 12 }}>
          <span style={{ color: "var(--loki-muted)" }}>
            {f.label}
            {f.required === false ? <span style={{ opacity: 0.6 }}> · optional</span> : null}
          </span>
          <Field
            id={`${fieldId}-${f.key}`}
            size="sm"
            mono
            type={f.secret ? "password" : "text"}
            value={values[f.key] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            onKeyDown={(e) => e.key === "Enter" && void connect()}
            placeholder={f.placeholder ?? (f.secret ? "pasted here, checked with the provider, then kept by Letta" : "")}
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore
            data-form-type="other"
          />
        </label>
      ))}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Button size="sm" tone="brass" onClick={() => void connect()} disabled={busy || !canConnect(fields, values)}>
          {busy ? "checking…" : connected ? "replace the key" : "connect"}
        </Button>
        {connected && (
          <Button size="sm" onClick={() => void disconnect()} disabled={busy}>
            disconnect
          </Button>
        )}
        {error && <span style={{ fontSize: 12, color: "var(--loki-negative)", fontFamily: "var(--loki-mono)" }}>{error}</span>}
      </div>
    </>
  );
}
