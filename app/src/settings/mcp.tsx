import { useEffect, useEffectEvent, useId, useState } from "react";
import { Button, Chip, Dot, Field, Row, TextArea } from "../components";
import type { McpServerView, McpView } from "../../../core/frame-types.ts";
import { openExternal } from "../desk/env";

/** What Settings › MCP asks of the daemon; each call resolves to the servers as they now are, or an error message. */
export interface McpApi {
  get: () => Promise<McpView | string>;
  server: (entry: string, edit: McpEdit | null, rename?: string) => Promise<McpView | string>;
  alwaysLoad: (entry: string, tools: string[]) => Promise<McpView | string>;
  restart: (name: string) => Promise<McpView | string>;
  /** Forget a remote server's OAuth sign-in; it then asks for one again. */
  signOut: (name: string) => Promise<McpView | string>;
  agent: (agentId: string, server: string, on: boolean) => Promise<McpView | string>;
  /** The `${keychain:…}` reference to write in place of the value, or an error message. */
  secret: (name: string, value: string) => Promise<{ ref: string } | string>;
  approvals: { list: () => Promise<string[] | string>; set: (tool: string, on: boolean) => Promise<string[] | string> };
}

/**
 * A server's entry as the MCP page writes it to ~/.loki/mcp.json: a local server's command, arguments, environment and
 * folder, or a remote server's URL and headers.
 */
export type McpEdit = { command: string; args: string[]; env: Record<string, string>; cwd: string | null } | { url: string; headers: Record<string, string> };

const STATE_TONE: Record<McpServerView["state"], string> = {
  connected: "var(--loki-positive)",
  starting: "var(--loki-accent)",
  down: "var(--loki-negative)",
  signin: "var(--loki-accent)",
};
const KEYCHAIN = /^\$\{keychain:[A-Za-z0-9_.-]+\}$/;

/** "about 9k tokens": a cost as the list shows it. */
export const tokenLabel = (n: number): string => (n >= 1000 ? `~${Math.round(n / 100) / 10}k tokens` : `~${n} tokens`);

/** `KEY=value` lines (env) or `Name: value` lines (headers) as a map, and back. */
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
/** A map as `KEY=value` lines (env) or `Name: value` lines (headers), the reverse of `parsePairs`. */
export const pairsText = (pairs: Record<string, string>, sep: "=" | ":"): string =>
  Object.entries(pairs)
    .map(([k, v]) => `${k}${sep === ":" ? ": " : "="}${v}`)
    .join("\n");

/**
 * Settings › MCP: the servers in ~/.loki/mcp.json, each with its state, its tools and what loading them all would
 * cost. A server's tools wait behind the agent's search; the ones checked "always loaded" skip it. Add, edit, restart
 * and remove write the file the daemon follows. Values can be kept in the keychain, and the file names them instead.
 */
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
  // The list follows the servers while the page shows: a server connecting or going down changes it.
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

  if (!view) return <div className="loki-meta loki-meta--wrap">{error ?? "asking loki…"}</div>;
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div className="loki-meta loki-meta--wrap">
        Agents see each server and its tools' names; a tool's full definition is loaded only when the agent searches for it, unless it is checked "always
        loaded". The file is <span style={{ fontFamily: "var(--loki-mono)" }}>{view.configPath}</span>.
      </div>
      {view.problems.map((p) => (
        <div key={p} className="loki-meta loki-meta--negative loki-meta--wrap">
          {p}
        </div>
      ))}
      {error && <div className="loki-meta loki-meta--negative loki-meta--wrap">{error}</div>}
      <div style={{ display: "grid", gap: 2 }}>
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
        {view.servers.length === 0 && (
          <div className="loki-meta loki-meta--wrap" style={{ padding: "6px 8px" }}>
            no servers yet
          </div>
        )}
      </div>
      {editing ? (
        <ServerForm
          key={editing === "new" ? "new" : editing.name}
          server={editing === "new" ? null : editing}
          api={api}
          onDone={(r) => {
            if (r) apply(r);
            setEditing(null);
          }}
        />
      ) : (
        <Button size="sm" tone="brass" onClick={() => setEditing("new")} style={{ justifySelf: "start" }}>
          + add a server
        </Button>
      )}
    </div>
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
  const loaded = s.tools.filter((t) => t.alwaysLoad).map((t) => t.name);
  const toggleAlways = (name: string, on: boolean) => void api.alwaysLoad(s.entry, on ? [...loaded, name] : loaded.filter((n) => n !== name)).then(apply);
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <Row
        dense
        selected={open}
        onClick={onToggle}
        aria-expanded={open}
        aria-label={`${s.entry}, ${s.kind} server, ${s.state === "connected" ? `${s.tools.length} tools` : s.state === "signin" ? "needs sign-in" : s.state}`}
        style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", alignItems: "center", gap: 10 }}
      >
        <Dot color={STATE_TONE[s.state]} />
        <span style={{ minWidth: 0 }}>
          <strong>{s.entry}</strong>
          <span className="loki-meta" style={{ marginLeft: 8 }}>
            {s.kind}
          </span>
          {s.purpose && (
            <span className="loki-meta loki-meta--wrap" style={{ display: "block" }}>
              {s.purpose}
            </span>
          )}
        </span>
        <span className="loki-meta">
          {s.state === "connected"
            ? `${s.tools.length} tool${s.tools.length === 1 ? "" : "s"} · ${tokenLabel(s.tokens)} if all loaded`
            : s.state === "signin"
              ? "needs sign-in"
              : s.state}
        </span>
      </Row>
      {open && (
        <div style={{ display: "grid", gap: 8, padding: "4px 8px 10px 28px" }}>
          {s.error && s.state !== "signin" && <div className="loki-meta loki-meta--negative loki-meta--wrap">{s.error}</div>}
          {s.signIn && <SignIn s={s} signIn={s.signIn} onSignOut={() => void api.signOut(s.name).then(apply)} />}
          {s.tools.length > 0 && (
            <div role="group" aria-label={`${s.name} tools`} style={{ display: "grid", gap: 4 }}>
              {s.tools.map((t) => (
                <label key={t.name} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 8, alignItems: "start", cursor: "pointer" }}>
                  <input type="checkbox" checked={t.alwaysLoad} onChange={(e) => toggleAlways(t.name, e.target.checked)} aria-label={`always load ${t.name}`} />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ fontFamily: "var(--loki-mono)", fontSize: 12 }}>{t.name}</span>
                    {t.readOnly && (
                      <Chip static tag style={{ marginLeft: 6 }}>
                        read-only
                      </Chip>
                    )}
                    {t.destructive && (
                      <Chip static tag style={{ marginLeft: 6 }}>
                        destructive
                      </Chip>
                    )}
                    {t.description && (
                      <span className="loki-meta loki-meta--wrap" style={{ display: "block" }}>
                        {t.description.split("\n")[0]}
                      </span>
                    )}
                  </span>
                  <span className="loki-meta">{tokenLabel(t.tokens)}</span>
                </label>
              ))}
              <span className="loki-meta loki-meta--wrap">checked: always loaded, skipping the search (keep it to the few used all the time)</span>
            </div>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button size="sm" tone="paper" onClick={() => void api.restart(s.name).then(apply)}>
              restart
            </Button>
            <Button size="sm" tone="paper" onClick={onEdit}>
              edit
            </Button>
            {confirm ? (
              <>
                <Button size="sm" tone="negative" onClick={() => void api.server(s.entry, null).then(apply)}>
                  remove {s.entry}
                </Button>
                <Button size="sm" onClick={() => setConfirm(false)}>
                  keep it
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={() => setConfirm(true)}>
                remove
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * A remote server's OAuth sign-in: "sign in" opens its authorization page in the browser, which comes back to loki
 * and connects the server; "sign out" forgets the tokens. A page that went stale is made again by restart.
 */
function SignIn({ s, signIn, onSignOut }: { s: McpServerView; signIn: NonNullable<McpServerView["signIn"]>; onSignOut: () => void }) {
  const url = signIn.url;
  if (s.state === "signin")
    return (
      <div style={{ display: "grid", gap: 6 }}>
        <span className="loki-meta loki-meta--wrap">
          {s.entry} needs you to sign in before its tools can be used. Your browser opens its sign-in page and comes back to loki.
        </span>
        {url ? (
          <Button size="sm" tone="positive" onClick={() => openExternal(url)} style={{ justifySelf: "start" }}>
            sign in to {s.entry}
          </Button>
        ) : (
          <span className="loki-meta loki-meta--wrap">getting the sign-in page… (restart if it does not come)</span>
        )}
      </div>
    );
  if (signIn.signedIn)
    return (
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span className="loki-meta">signed in</span>
        <Button size="sm" onClick={onSignOut}>
          sign out
        </Button>
      </div>
    );
  return null;
}

/** The add/edit form's fields, as text; `kind` picks which half is saved. */
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

/** A server's config as the form's text (a new server: an empty local one). */
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

/**
 * Each value not already a keychain reference is stored in the keychain (all at once: they do not depend on each
 * other), and the reference takes its place; a value that cannot be stored stops the save, saying which.
 */
export async function secureValues(pairs: Record<string, string>, prefix: string, secret: McpApi["secret"]): Promise<Record<string, string>> {
  const entries = await Promise.all(
    Object.entries(pairs).map(async ([k, v]): Promise<[string, string]> => {
      if (!v || KEYCHAIN.test(v)) return [k, v];
      const kept = await secret(`${prefix}.${k}`, v);
      if (typeof kept === "string") throw new Error(`could not keep ${k} in the keychain: ${kept}`);
      return [k, kept.ref];
    }),
  );
  return Object.fromEntries(entries);
}

/** The form as the edit Settings sends; `secure` turns values into keychain references when asked. */
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

/** Add or edit one server: local (a command loki starts) or remote (a URL), its env or headers as lines. */
function ServerForm({ server, api, onDone }: { server: McpServerView | null; api: McpApi; onDone: (r: McpView | null) => void }) {
  const uid = useId();
  const [form, setForm] = useState(() => formOf(server));
  const set: SetField = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const [keychain, setKeychain] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const key = form.name.trim();
    if (!key) return setError("give the server a name");
    setBusy(true);
    setError(null);
    try {
      const edit = await editOf(form, (pairs) => (keychain ? secureValues(pairs, key, api.secret) : Promise.resolve(pairs)));
      const r = await api.server(server?.entry ?? key, edit, server && key !== server.entry ? key : undefined);
      if (typeof r === "string") setError(r);
      else onDone(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 8, padding: 12, border: "1px solid var(--loki-border)", borderRadius: "var(--loki-radius-lg)" }}>
      <strong>{server ? `Edit ${server.entry}` : "Add a server"}</strong>
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
      <div role="group" aria-label="Kind" style={{ display: "flex", gap: 4 }}>
        <Chip active={form.kind === "local"} aria-pressed={form.kind === "local"} onClick={() => set("kind", "local")}>
          local (a command)
        </Chip>
        <Chip active={form.kind === "remote"} aria-pressed={form.kind === "remote"} onClick={() => set("kind", "remote")}>
          remote (a URL)
        </Chip>
      </div>
      {form.kind === "local" ? <LocalFields uid={uid} form={form} set={set} /> : <RemoteFields uid={uid} form={form} set={set} />}
      <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
        <input type="checkbox" checked={keychain} onChange={(e) => setKeychain(e.target.checked)} />
        <span className="loki-meta loki-meta--wrap">
          keep {form.kind === "local" ? "environment" : "header"} values in this computer's keychain; the file names them instead of holding them
        </span>
      </label>
      {error && <div className="loki-meta loki-meta--negative loki-meta--wrap">{error}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <Button size="sm" tone="positive" disabled={busy} onClick={() => void save()}>
          {busy ? "saving…" : "save"}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => onDone(null)}>
          cancel
        </Button>
      </div>
    </div>
  );
}

/** A local server's fields: the command, its arguments, its environment and folder. */
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

/** A remote server's fields: its URL and headers. */
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

/** Settings › Chat: the tools answered "always allow", to take back one by one. */
export function AlwaysAllowed({ api }: { api: McpApi["approvals"] }) {
  const [tools, setTools] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const apply = (r: string[] | string) => (typeof r === "string" ? setError(r) : (setError(null), setTools(r)));
  const load = useEffectEvent(() => void api.list().then(apply));
  useEffect(() => load(), []);
  if (tools === null) return <div className="loki-meta loki-meta--wrap">{error ?? "asking loki…"}</div>;
  return (
    <div style={{ display: "grid", gap: 4 }}>
      {tools.length === 0 && <div className="loki-meta loki-meta--wrap">none: answer "always allow" on an approval to add one</div>}
      {tools.map((t) => (
        <div key={t} style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontFamily: "var(--loki-mono)", fontSize: 12, flex: 1, overflowWrap: "anywhere" }}>{t}</span>
          <Button size="sm" onClick={() => void api.set(t, false).then(apply)}>
            take back
          </Button>
        </div>
      ))}
      {error && <div className="loki-meta loki-meta--negative loki-meta--wrap">{error}</div>}
    </div>
  );
}
