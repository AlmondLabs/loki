import { useEffect, useEffectEvent, useId, useState } from "react";
import { Button, Chip, Dot, Field, Row, TextArea, sentence } from "../components";
import type { McpServerView, McpView } from "../../../core/frame-types.ts";
import { openExternal } from "../workspace/env";
import { Block, Segmented, Setting } from "./layout";
import { messageOf } from "../../../core/errors.ts";

export interface McpApi {
  get: () => Promise<McpView | string>;
  server: (entry: string, edit: McpEdit | null, rename?: string) => Promise<McpView | string>;
  alwaysLoad: (entry: string, tools: string[]) => Promise<McpView | string>;
  restart: (name: string) => Promise<McpView | string>;
  signOut: (name: string) => Promise<McpView | string>;
  agent: (agentId: string, server: string, on: boolean) => Promise<McpView | string>;
  secret: (name: string, value: string) => Promise<{ ref: string } | string>;
  approvals: { list: () => Promise<string[] | string>; set: (tool: string, on: boolean) => Promise<string[] | string> };
}

export type McpEdit = { command: string; args: string[]; env: Record<string, string>; cwd: string | null } | { url: string; headers: Record<string, string> };

const STATE_TONE: Record<McpServerView["state"], string> = {
  connected: "var(--loki-positive)",
  starting: "var(--loki-accent)",
  down: "var(--loki-negative)",
  signin: "var(--loki-accent)",
};
const KEYCHAIN = /^\$\{keychain:[A-Za-z0-9_.-]+\}$/;

export const tokenLabel = (n: number): string => (n >= 1000 ? `~${Math.round(n / 100) / 10}k tokens` : `~${n} tokens`);

export function parsePairs(text: string, sep: "=" | ":"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf(sep);
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    if (key) out[key] = line.slice(at + 1).trim();
  }
  return out;
}
export const pairsText = (pairs: Record<string, string>, sep: "=" | ":"): string =>
  Object.entries(pairs)
    .map(([k, v]) => `${k}${sep === ":" ? ": " : "="}${v}`)
    .join("\n");

export function Mcp({ api }: { api: McpApi }) {
  const [view, setView] = useState<McpView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<McpServerView | "new" | null>(null);
  const apply = (r: McpView | string) => {
    if (typeof r === "string") return setError(r);
    setError(null);
    setView(r);
  };
  const read = useEffectEvent(() => api.get());
  useEffect(() => {
    let live = true;
    const load = () => void read().then((r) => live && apply(r));
    load();
    const t = setInterval(load, 3000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  if (!view) return <Setting label="Servers" help={error ?? "Asking loki…"} />;
  return (
    <>
      <Block help={'Servers your agents can use, each tool loading only when an agent searches for it unless it is "always loaded".'}>
        {view.problems.map((p) => (
          <div key={p} className="loki-meta loki-meta--negative loki-meta--wrap">
            {p}
          </div>
        ))}
        {error && (
          <div role="alert" className="loki-meta loki-meta--negative loki-meta--wrap">
            {error}
          </div>
        )}
        {view.servers.map((s) => (
          <ServerRow
            key={s.name}
            s={s}
            open={open === s.name}
            onToggle={() => setOpen(open === s.name ? null : s.name)}
            onEdit={() => setEditing(s)}
            api={api}
            apply={apply}
          />
        ))}
        {view.servers.length === 0 && <Setting label="None yet" help="Add one below: GitHub, Linear, a database, anything that speaks MCP." />}
      </Block>
      <Block title={editing && editing !== "new" ? `Edit ${editing.entry}` : "Add a server"}>
        {editing ? (
          <ServerForm
            key={editing === "new" ? "new" : editing.name}
            server={editing === "new" ? null : editing}
            configPath={view.config_path}
            api={api}
            onDone={(r) => {
              if (r) apply(r);
              setEditing(null);
            }}
          />
        ) : (
          <Setting label="Local or remote" help="A command loki starts on this computer, or a server's URL.">
            <Button tone="positive" onClick={() => setEditing("new")}>
              Add Server…
            </Button>
          </Setting>
        )}
      </Block>
    </>
  );
}

function ServerRow({
  s,
  open,
  onToggle,
  onEdit,
  api,
  apply,
}: {
  s: McpServerView;
  open: boolean;
  onToggle: () => void;
  onEdit: () => void;
  api: McpApi;
  apply: (r: McpView | string) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const loaded = s.tools.filter((t) => t.always_load).map((t) => t.name);
  const toggleAlways = (name: string, on: boolean) => void api.alwaysLoad(s.entry, on ? [...loaded, name] : loaded.filter((n) => n !== name)).then(apply);
  return (
    <div className="grid gap-2" style={{ padding: "4px 0" }}>
      <Row
        dense
        selected={open}
        onClick={onToggle}
        aria-expanded={open}
        aria-label={`${s.entry}, ${s.kind} server, ${s.state === "connected" ? `${s.tools.length} tools` : s.state === "signin" ? "needs sign-in" : s.state}`}
        style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", alignItems: "center", gap: 12 }}
      >
        <Dot color={STATE_TONE[s.state]} />
        <span className="min-w-0">
          <strong>{s.entry}</strong>
          {s.purpose && <span className="loki-meta loki-meta--wrap block">{s.purpose}</span>}
        </span>
        <span className="loki-meta">
          {s.state === "connected"
            ? `${s.tools.length} tool${s.tools.length === 1 ? "" : "s"} · ${tokenLabel(s.tokens)} if all loaded`
            : s.state === "signin"
              ? "Needs sign-in"
              : sentence(s.state)}
        </span>
      </Row>
      {open && (
        <div className="grid gap-2" style={{ padding: "4px 8px 8px 24px" }}>
          {s.error && s.state !== "signin" && <div className="loki-meta loki-meta--negative loki-meta--wrap">{s.error}</div>}
          {s.sign_in && <SignIn s={s} signIn={s.sign_in} onSignOut={() => void api.signOut(s.name).then(apply)} />}
          {s.tools.length > 0 && (
            <div role="group" aria-label={`${s.name} tools`} className="grid gap-1">
              {s.tools.map((t) => (
                <label key={t.name} className="grid grid-cols-[auto_1fr_auto] items-start gap-2" style={{ cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={t.always_load}
                    onChange={(e) => toggleAlways(t.name, e.target.checked)}
                    aria-label={`Always load ${t.name}`}
                  />
                  <span className="min-w-0">
                    <span className="loki-mono" style={{ fontSize: "var(--text-xs)" }}>
                      {t.name}
                    </span>
                    {t.read_only && (
                      <Chip static tag style={{ marginLeft: 8 }}>
                        Read-only
                      </Chip>
                    )}
                    {t.destructive && (
                      <Chip static tag style={{ marginLeft: 8 }}>
                        Destructive
                      </Chip>
                    )}
                    {t.description && <span className="loki-meta loki-meta--wrap block">{t.description.split("\n")[0]}</span>}
                  </span>
                  <span className="loki-meta">{tokenLabel(t.tokens)}</span>
                </label>
              ))}
              <span className="loki-meta loki-meta--wrap">Checked: always loaded, skipping the search (keep it to the few used all the time)</span>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void api.restart(s.name).then(apply)}>
              Restart
            </Button>
            <Button size="sm" onClick={onEdit}>
              Edit
            </Button>
            {confirm ? (
              <>
                <Button size="sm" tone="negative" onClick={() => void api.server(s.entry, null).then(apply)}>
                  Remove {s.entry}
                </Button>
                <Button size="sm" onClick={() => setConfirm(false)}>
                  Keep
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={() => setConfirm(true)}>
                Remove…
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SignIn({ s, signIn, onSignOut }: { s: McpServerView; signIn: NonNullable<McpServerView["sign_in"]>; onSignOut: () => void }) {
  const url = signIn.url;
  if (s.state === "signin")
    return (
      <div className="grid gap-2">
        <span className="loki-meta loki-meta--wrap">
          {s.entry} needs you to sign in before its tools can be used. Your browser opens its sign-in page and comes back to loki.
        </span>
        {url ? (
          <Button size="sm" tone="positive" onClick={() => openExternal(url)} className="justify-self-start">
            Sign In to {s.entry}
          </Button>
        ) : (
          <span className="loki-meta loki-meta--wrap">Getting the sign-in page… (restart if it does not come)</span>
        )}
      </div>
    );
  if (signIn.signed_in)
    return (
      <div className="flex items-center gap-2">
        <span className="loki-meta">Signed in</span>
        <Button size="sm" onClick={onSignOut}>
          Sign Out
        </Button>
      </div>
    );
  return null;
}

interface Form {
  kind: "local" | "remote";
  name: string;
  command: string;
  args: string;
  env: string;
  cwd: string;
  url: string;
  headers: string;
}
type SetField = <K extends keyof Form>(key: K, value: Form[K]) => void;

export function formOf(server: McpServerView | null): Form {
  const local = server && "command" in server.config ? server.config : null;
  const remote = server && "url" in server.config ? server.config : null;
  return {
    kind: server?.kind ?? "local",
    name: server?.entry ?? "",
    command: local?.command ?? "",
    args: (local?.args ?? []).join("\n"),
    env: pairsText(local?.env ?? {}, "="),
    cwd: local?.cwd ?? "",
    url: remote?.url ?? "",
    headers: pairsText(remote?.headers ?? {}, ":"),
  };
}

export async function secureValues(pairs: Record<string, string>, prefix: string, secret: McpApi["secret"]): Promise<Record<string, string>> {
  const entries = await Promise.all(
    Object.entries(pairs).map(async ([k, v]): Promise<[string, string]> => {
      if (!v || KEYCHAIN.test(v)) return [k, v];
      const kept = await secret(`${prefix}.${k}`, v);
      if (typeof kept === "string") throw new Error(`Could not keep ${k} in the keychain: ${kept}`);
      return [k, kept.ref];
    }),
  );
  return Object.fromEntries(entries);
}

export async function editOf(form: Form, secure: (pairs: Record<string, string>) => Promise<Record<string, string>>): Promise<McpEdit> {
  if (form.kind === "remote") return { url: form.url.trim(), headers: await secure(parsePairs(form.headers, ":")) };
  return {
    command: form.command.trim(),
    args: form.args
      .split("\n")
      .map((a) => a.trim())
      .filter(Boolean),
    env: await secure(parsePairs(form.env, "=")),
    cwd: form.cwd.trim() || null,
  };
}

function ServerForm({
  server,
  configPath,
  api,
  onDone,
}: {
  server: McpServerView | null;
  configPath: string;
  api: McpApi;
  onDone: (r: McpView | null) => void;
}) {
  const uid = useId();
  const [form, setForm] = useState(() => formOf(server));
  const set: SetField = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const [keychain, setKeychain] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const key = form.name.trim();
    if (!key) return setError("Give the server a name");
    setBusy(true);
    setError(null);
    const secureFn = keychain
      ? (pairs: Record<string, string>) => secureValues(pairs, key, api.secret)
      : (pairs: Record<string, string>) => Promise.resolve(pairs);
    const entryKey = server?.entry ?? key;
    const renameTo = server && key !== server.entry ? key : undefined;
    let r: McpView | string | null = null;
    let failed = false;
    try {
      const edit = await editOf(form, secureFn);
      r = await api.server(entryKey, edit, renameTo);
    } catch (e) {
      failed = true;
      setError(messageOf(e));
    }
    setBusy(false);
    if (!failed) {
      if (typeof r === "string") setError(r);
      else onDone(r);
    }
  };

  return (
    <div className="grid gap-2" style={{ padding: 12, marginTop: 12, border: "1px solid var(--loki-border)", borderRadius: "var(--radius-xl)" }}>
      <label htmlFor={`${uid}-name`} className="loki-label">
        Name
      </label>
      <Field
        id={`${uid}-name`}
        size="sm"
        value={form.name}
        onChange={(e) => set("name", e.target.value)}
        placeholder="github"
        autoComplete="off"
        data-1p-ignore
      />
      <span>
        <Segmented
          label="Kind"
          options={["local", "remote"] as const}
          value={form.kind}
          onPick={(k) => set("kind", k)}
          labels={{ local: "Local (a Command)", remote: "Remote (a URL)" }}
        />
      </span>
      {form.kind === "local" ? <LocalFields uid={uid} form={form} set={set} /> : <RemoteFields uid={uid} form={form} set={set} />}
      <label className="flex items-center gap-2" style={{ cursor: "pointer" }}>
        <input type="checkbox" checked={keychain} onChange={(e) => setKeychain(e.target.checked)} />
        <span className="loki-meta loki-meta--wrap">
          Keep {form.kind === "local" ? "environment" : "header"} values in this computer's keychain; the file names them instead of holding them
        </span>
      </label>
      {error && (
        <div role="alert" className="loki-meta loki-meta--negative loki-meta--wrap">
          {error}
        </div>
      )}
      <div className="flex gap-2">
        <Button size="sm" tone="positive" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => onDone(null)}>
          Cancel
        </Button>
      </div>
      <div className="loki-meta loki-meta--wrap">
        Written to <span className="loki-mono">{configPath}</span>, which loki's daemon follows.
      </div>
    </div>
  );
}

function LocalFields({ uid, form, set }: { uid: string; form: Form; set: SetField }) {
  return (
    <>
      <label htmlFor={`${uid}-cmd`} className="loki-label">
        Command
      </label>
      <Field
        id={`${uid}-cmd`}
        size="sm"
        mono
        value={form.command}
        onChange={(e) => set("command", e.target.value)}
        placeholder="npx"
        autoComplete="off"
        data-1p-ignore
      />
      <label htmlFor={`${uid}-args`} className="loki-label">
        Arguments, one a line
      </label>
      <TextArea
        id={`${uid}-args`}
        mono
        rows={3}
        value={form.args}
        onChange={(e) => set("args", e.target.value)}
        placeholder={"-y\n@modelcontextprotocol/server-github"}
      />
      <label htmlFor={`${uid}-env`} className="loki-label">
        Environment, NAME=value a line
      </label>
      <TextArea id={`${uid}-env`} mono rows={3} value={form.env} onChange={(e) => set("env", e.target.value)} placeholder="GITHUB_PERSONAL_ACCESS_TOKEN=…" />
      <label htmlFor={`${uid}-cwd`} className="loki-label">
        Folder (optional)
      </label>
      <Field id={`${uid}-cwd`} size="sm" mono value={form.cwd} onChange={(e) => set("cwd", e.target.value)} autoComplete="off" data-1p-ignore />
    </>
  );
}

function RemoteFields({ uid, form, set }: { uid: string; form: Form; set: SetField }) {
  return (
    <>
      <label htmlFor={`${uid}-url`} className="loki-label">
        URL
      </label>
      <Field
        id={`${uid}-url`}
        size="sm"
        mono
        value={form.url}
        onChange={(e) => set("url", e.target.value)}
        placeholder="https://mcp.linear.app/mcp"
        autoComplete="off"
        data-1p-ignore
      />
      <label htmlFor={`${uid}-headers`} className="loki-label">
        Headers, Name: value a line
      </label>
      <TextArea
        id={`${uid}-headers`}
        mono
        rows={3}
        value={form.headers}
        onChange={(e) => set("headers", e.target.value)}
        placeholder="Authorization: Bearer …"
      />
    </>
  );
}

export function AlwaysAllowed({ api }: { api: McpApi["approvals"] }) {
  const [tools, setTools] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const apply = (r: string[] | string) => (typeof r === "string" ? setError(r) : (setError(null), setTools(r)));
  const load = useEffectEvent(() => void api.list().then(apply));
  useEffect(() => load(), []);
  if (tools === null) return <Setting label="Tools" help={error ?? "Asking loki…"} />;
  return (
    <>
      {tools.length === 0 && <Setting label="None yet" help={'Answer "Always Allow" on an approval to add its tool here.'} />}
      {tools.map((t) => (
        <Setting key={t} label={t} mono>
          <Button size="sm" onClick={() => void api.set(t, false).then(apply)}>
            Take Back
          </Button>
        </Setting>
      ))}
      {error && (
        <div role="alert" className="loki-meta loki-meta--negative loki-meta--wrap">
          {error}
        </div>
      )}
    </>
  );
}
