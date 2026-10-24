import { useEffect, useEffectEvent, useId, useState } from "react";
import type { ConnectProvider } from "../../../core/attention/protocol.ts";
import { Button, Dot, Field, Row } from "../components";
import { SHORTLIST, canConnect, fieldValues, fieldsFor, isConnected, sortProviders } from "./provider-model";
import { Block, Segmented, Setting } from "./layout";

/**
 * Model providers as rows: connected first, then the usual suspects, then everything the daemon
 * knows behind a filter. A row opens into the daemon's own field list; the key is checked against
 * the provider before it is saved, and never shown again afterwards. A sign-in opens the browser.
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
  const loading = providers === null;
  const load = useEffectEvent(() => void onLoad());
  useEffect(() => {
    if (loading) load();
  }, [loading]);

  if (providers === null) return <div className="loki-meta loki-meta--wrap">asking loki…</div>;
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
        <span className="loki-meta">{connectedCount === 0 ? "none connected" : `${connectedCount} connected`}</span>
      </div>
      <div style={{ display: "grid", gap: 2 }}>
        {shown.map((p) => (
          <ProviderRow
            key={p.id}
            p={p}
            open={open === p.id}
            onToggle={() => setOpen(open === p.id ? null : p.id)}
            onConnect={onConnect}
            onDisconnect={onDisconnect}
            onChanged={onChanged}
          />
        ))}
        {shown.length === 0 && (
          <div className="loki-meta loki-meta--wrap" style={{ padding: "6px 8px" }}>
            nothing matches
          </div>
        )}
      </div>
      {!more && !filter && sorted.length > shown.length && (
        <Button size="sm" onClick={() => setMore(true)} style={{ justifySelf: "start" }}>
          {sorted.length - shown.length} more providers
        </Button>
      )}
    </div>
  );
}

/**
 * Settings › providers (plan 031): the providers you use first, each opening into its key or sign-in; the rest of the
 * daemon's catalogue only after "add a provider", behind a search, the usual ones on top.
 */
export function ProviderSettings({
  providers,
  onLoad,
  onConnect,
  onDisconnect,
  onChanged,
}: {
  providers: ConnectProvider[] | null;
  onLoad: () => Promise<unknown>;
  onConnect: ConnectFn;
  onDisconnect: DisconnectFn;
  onChanged?: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const loading = providers === null;
  const load = useEffectEvent(() => void onLoad());
  useEffect(() => {
    if (loading) load();
  }, [loading]);

  if (providers === null) return <Setting label="Providers" help="asking loki…" />;
  const connected = sortProviders(providers).filter(isConnected);
  const others = sortProviders(providers, filter).filter((p) => !isConnected(p));
  const row = (p: ConnectProvider) => (
    <ProviderRow
      key={p.id}
      p={p}
      open={open === p.id}
      onToggle={() => setOpen(open === p.id ? null : p.id)}
      onConnect={onConnect}
      onDisconnect={onDisconnect}
      onChanged={onChanged}
    />
  );
  return (
    <>
      <Block title="Connected" help="who answers your agents' models. A key is checked with the provider, then kept in this computer's keychain.">
        {connected.length === 0 && <Setting label="None yet" help="Add a provider below to give your agents a model." />}
        {connected.map(row)}
      </Block>
      <Block title="Add a provider">
        {adding ? (
          <div style={{ display: "grid", gap: 6, paddingTop: 10 }}>
            <Field
              size="sm"
              type="search"
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.preventDefault();
                e.stopPropagation();
                if (filter) setFilter("");
                else setAdding(false);
              }}
              placeholder={`search ${providers.length - connected.length} providers`}
              aria-label="search providers"
              autoComplete="off"
              data-1p-ignore
              data-form-type="other"
            />
            <div style={{ display: "grid", gap: 2, maxHeight: 380, overflowY: "auto" }}>
              {others.map(row)}
              {others.length === 0 && (
                <div className="loki-meta loki-meta--wrap" style={{ padding: "6px 8px" }}>
                  nothing matches
                </div>
              )}
            </div>
          </div>
        ) : (
          <Setting
            label={`${providers.length - connected.length} providers`}
            help={providers
              .filter((p) => SHORTLIST.includes(p.id) && !isConnected(p))
              .map((p) => p.display_name)
              .concat("and others")
              .join(", ")}
          >
            <Button tone="positive" onClick={() => setAdding(true)}>
              add a provider
            </Button>
          </Setting>
        )}
      </Block>
    </>
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
  /** A sign-in still waiting for its browser: the address the browser ended on finishes it (the wait in connect sees it). */
  const finish = async (address: string) => {
    if (!address.trim()) return;
    setError(await onConnect(p.id, { redirect_url: address.trim() }, "oauth_code"));
  };
  return { authMethodId, fields, setMethod, values, setValues, busy, error, connect, disconnect, finish };
}

type ConnectState = ReturnType<typeof useProviderConnect>;

function ProviderRow({
  p,
  open,
  onToggle,
  onConnect,
  onDisconnect,
  onChanged,
}: {
  p: ConnectProvider;
  open: boolean;
  onToggle: () => void;
  onConnect: ConnectFn;
  onDisconnect: DisconnectFn;
  onChanged?: () => void;
}) {
  const connected = isConnected(p);
  const state = useProviderConnect(p, onConnect, onDisconnect, onChanged, onToggle);

  return (
    <div
      style={{
        border: `1px solid ${open ? "var(--loki-border)" : "transparent"}`,
        borderRadius: "var(--loki-radius-md)",
        background: open ? "var(--loki-panel)" : "transparent",
      }}
    >
      <Row onClick={onToggle} aria-expanded={open}>
        <Dot aria-hidden color={connected ? "var(--loki-positive)" : "var(--loki-border)"} />
        <span style={{ display: "grid", gap: 1, minWidth: 0, flex: 1 }}>
          <span style={{ fontSize: 13.5, fontWeight: 600 }}>{p.display_name}</span>
          {p.description && !open && <span className="loki-meta">{p.description}</span>}
        </span>
        {connected && (
          <span className="loki-label" style={{ color: "var(--loki-positive)" }}>
            {p.connected.auth_type === "oauth" ? "Signed in" : "API key"}
          </span>
        )}
      </Row>
      {open && (
        <div style={{ padding: "2px 10px 10px 24px", display: "grid", gap: 8 }}>
          {p.description && <div className="loki-meta loki-meta--wrap">{p.description}</div>}
          <ConnectForm p={p} connected={connected} state={state} />
        </div>
      )}
    </div>
  );
}

/** The open row's form: a method picker when the provider has more than one, the daemon's fields, connect / disconnect, the error. */
function ConnectForm({ p, connected, state }: { p: ConnectProvider; connected: boolean; state: ConnectState }) {
  const { authMethodId, fields, setMethod, values, setValues, busy, error, connect, disconnect, finish } = state;
  /** Each field's input is `${fieldId}-${key}`, so its label can name it. */
  const fieldId = useId();
  const [address, setAddress] = useState("");
  const signIn = authMethodId === "oauth" ? p.auth_methods?.find((m) => m.id === "oauth") : undefined;
  return (
    <>
      {p.auth_methods && p.auth_methods.length > 1 && (
        <span>
          <Segmented
            label="how to sign in"
            options={p.auth_methods.map((m) => m.id)}
            value={authMethodId ?? p.auth_methods[0].id}
            onPick={setMethod}
            labels={Object.fromEntries(p.auth_methods.map((m) => [m.id, m.label]))}
          />
        </span>
      )}
      {fields.map((f) => (
        <label
          key={f.key}
          htmlFor={`${fieldId}-${f.key}`}
          style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: 10, alignItems: "center", fontSize: 12 }}
        >
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
            placeholder={f.placeholder ?? (f.secret ? "pasted here, checked with the provider, then kept in the keychain" : "")}
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore
            data-form-type="other"
          />
        </label>
      ))}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Button size="sm" tone="positive" onClick={() => void connect()} disabled={busy || !canConnect(fields, values)}>
          {signIn
            ? busy
              ? "waiting for the browser…"
              : connected
                ? "sign in again"
                : signIn.label
            : busy
              ? "checking…"
              : connected
                ? "replace the key"
                : "connect"}
        </Button>
        {connected && (
          <Button size="sm" tone="negative" onClick={() => void disconnect()} disabled={busy}>
            disconnect
          </Button>
        )}
        {error && <span className="loki-meta loki-meta--negative loki-meta--wrap">{error}</span>}
      </div>
      {signIn && busy && (
        <label htmlFor={`${fieldId}-address`} style={{ display: "grid", gridTemplateColumns: "140px 1fr auto", gap: 10, alignItems: "center", fontSize: 12 }}>
          <span style={{ color: "var(--loki-muted)" }}>browser didn't come back?</span>
          <Field
            id={`${fieldId}-address`}
            size="sm"
            mono
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void finish(address)}
            placeholder="paste the address the browser ended on"
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore
            data-form-type="other"
          />
          <Button size="sm" onClick={() => void finish(address)} disabled={!address.trim()}>
            finish
          </Button>
        </label>
      )}
    </>
  );
}
