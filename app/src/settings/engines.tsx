import { useEffect, useEffectEvent, useId, useState } from "react";
import { Button, Dot, Field, TextArea, sentence } from "../components";
import { Block, Setting } from "./layout";
import type { EnginesView, EngineView } from "../../../core/frame-types.ts";

export interface EnginesApi {
  get: () => Promise<EnginesView | string>;
  set: (engine: {
    id: string;
    name: string;
    command: string;
    args: string[];
    env?: Record<string, string>;
    auth_method?: string;
    login?: string;
  }) => Promise<EnginesView | string>;
  remove: (id: string) => Promise<EnginesView | string>;
  check: (id: string) => Promise<EnginesView | string>;
}

const TONE: Record<EngineView["status"], string> = {
  ready: "var(--loki-positive)",
  started: "var(--loki-positive)",
  unknown: "var(--loki-muted)",
  not_found: "var(--loki-negative)",
  signed_out: "var(--loki-accent)",
  failed: "var(--loki-negative)",
};

const WORDS: Record<EngineView["status"], string> = {
  ready: "ready",
  started: "starts",
  unknown: "not tried yet",
  not_found: "not found",
  signed_out: "needs signing in",
  failed: "failed",
};

export const engineId = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export function Engines({ api }: { api: EnginesApi }) {
  const [view, setView] = useState<EnginesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EngineView | "new" | null>(null);
  const [trying, setTrying] = useState<string | null>(null);
  const apply = (r: EnginesView | string) => {
    if (typeof r === "string") return setError(r);
    setError(null);
    setView(r);
  };
  const read = useEffectEvent(() => api.get());
  useEffect(() => {
    let live = true;
    void read().then((r) => live && apply(r));
    return () => {
      live = false;
    };
  }, []);
  const tryOne = async (id: string) => {
    setTrying(id);
    apply(await api.check(id));
    setTrying(null);
  };

  if (!view) return <Setting label="Engines" help={error ?? "Asking loki…"} />;
  return (
    <>
      <Block help="What a chat can run on besides loki's own models, chosen in the model picker before its first message.">
        {error && (
          <div role="alert" className="loki-meta loki-meta--negative loki-meta--wrap">
            {error}
          </div>
        )}
        {view.engines.map((e) => (
          <EngineRow
            key={e.id}
            e={e}
            trying={trying}
            onTry={() => void tryOne(e.id)}
            onEdit={() => setEditing(e)}
            onRemove={() => void api.remove(e.id).then(apply)}
          />
        ))}
      </Block>
      <Block title={editing && editing !== "new" ? `Edit ${editing.name}` : "Add an engine"}>
        {editing ? (
          <EngineForm
            key={editing === "new" ? "new" : editing.id}
            engine={editing === "new" ? null : editing}
            existingIds={view.engines.map((e) => e.id)}
            configPath={view.config_path}
            api={api}
            onDone={(r) => {
              if (r) apply(r);
              setEditing(null);
            }}
          />
        ) : (
          <Setting label="Any agent that speaks ACP" help="Added by the command that starts it, such as Gemini CLI or Codex.">
            <Button tone="positive" onClick={() => setEditing("new")}>
              Add Engine…
            </Button>
          </Setting>
        )}
      </Block>
    </>
  );
}

function EngineRow({
  e,
  trying,
  onTry,
  onEdit,
  onRemove,
}: {
  e: EngineView;
  trying: string | null;
  onTry: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const [details, setDetails] = useState(false);
  const bad = e.status === "failed" || e.status === "not_found";
  return (
    <div role="group" aria-label={`${e.name}, ${WORDS[e.status]}`}>
      <Setting
        label={e.name}
        help={
          <>
            <Dot color={TONE[e.status]} style={{ marginRight: 4, verticalAlign: "middle" }} />
            {sentence(WORDS[e.status])}
            {e.builtin ? (e.changed ? ", started your way" : ", built in") : ""}.
            {e.detail && <span className={`loki-meta--wrap${bad ? " loki-meta--negative" : ""} block`}>{e.detail}</span>}
          </>
        }
      >
        <Button size="sm" bare onClick={() => setDetails(!details)} aria-expanded={details}>
          Details
        </Button>
        <Button size="sm" onClick={onTry} disabled={trying !== null} aria-label={trying === e.id ? `Starting ${e.name}…` : `Try ${e.name}`}>
          {trying === e.id ? "Starting…" : "Try"}
        </Button>
        <Button size="sm" onClick={onEdit} aria-label={`Edit ${e.name}`}>
          Edit
        </Button>
        {(!e.builtin || e.changed) && (
          <Button
            size="sm"
            tone="negative"
            onClick={onRemove}
            aria-label={e.builtin ? `Reset ${e.name}` : `Remove ${e.name}`}
            title={e.builtin ? `Start ${e.name} as loki ships it` : undefined}
          >
            {e.builtin ? "Reset" : "Remove"}
          </Button>
        )}
      </Setting>
      {details && (
        <div className="loki-meta loki-meta--wrap loki-mono grid gap-1" style={{ paddingBottom: 12, overflowWrap: "anywhere" }}>
          <div>{[e.command, ...e.args].join(" ")}</div>
          {e.login && <div>Sign-in: {e.login}</div>}
          {e.auth_method && <div>Auth method: {e.auth_method}</div>}
          {e.env && Object.keys(e.env).length > 0 && <div>Environment: {Object.keys(e.env).join(", ")}</div>}
        </div>
      )}
    </div>
  );
}

function parseEnvLines(raw: string): Record<string, string> | string {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n").map((l) => l.trim())) {
    if (!line) continue;
    const eq = line.indexOf("=");
    const key = eq > 0 ? line.slice(0, eq).trim() : "";
    if (!key) return "Write each environment entry as NAME=value";
    out[key] = line.slice(eq + 1);
  }
  return out;
}

function EngineForm({
  engine,
  existingIds,
  configPath,
  api,
  onDone,
}: {
  engine: EngineView | null;
  existingIds: string[];
  configPath: string;
  api: EnginesApi;
  onDone: (r: EnginesView | null) => void;
}) {
  const uid = useId();
  const [name, setName] = useState(engine?.name ?? "");
  const [command, setCommand] = useState(engine?.command ?? "");
  const [args, setArgs] = useState(() => (engine?.args ?? []).join("\n"));
  const [envText, setEnvText] = useState(() =>
    Object.entries(engine?.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  const [login, setLogin] = useState(engine?.login ?? "");
  const [authMethod, setAuthMethod] = useState(engine?.auth_method ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const id = engine?.id ?? engineId(name);
    if (!id) return setError("Give the agent a name");
    if (!engine && existingIds.includes(id)) return setError(`An engine named ${id} already exists`);
    if (!command.trim()) return setError("Say which command starts it");
    const env = parseEnvLines(envText);
    if (typeof env === "string") return setError(env);
    setBusy(true);
    try {
      const r = await api.set({
        id,
        name: name.trim(),
        command: command.trim(),
        args: args
          .split("\n")
          .map((a) => a.trim())
          .filter(Boolean),
        env,
        auth_method: authMethod.trim(),
        login: login.trim(),
      });
      if (typeof r === "string") setError(r);
      else onDone(r);
    } catch (e) {
      setBusy(false);
      throw e;
    }
    setBusy(false);
  };
  return (
    <div className="grid gap-2" style={{ padding: 12, marginTop: 12, border: "1px solid var(--loki-border)", borderRadius: "var(--radius-xl)" }}>
      <label htmlFor={`${uid}-name`} className="loki-label">
        Name
      </label>
      <Field id={`${uid}-name`} size="sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="Gemini CLI" />
      <label htmlFor={`${uid}-command`} className="loki-label">
        Command
      </label>
      <Field id={`${uid}-command`} size="sm" mono value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" spellCheck={false} />
      <label htmlFor={`${uid}-args`} className="loki-label">
        Arguments, one per line
      </label>
      <TextArea
        id={`${uid}-args`}
        size="sm"
        mono
        rows={3}
        value={args}
        onChange={(e) => setArgs(e.target.value)}
        placeholder={"-y\n@google/gemini-cli\n--experimental-acp"}
        spellCheck={false}
      />
      <label htmlFor={`${uid}-env`} className="loki-label">
        Environment variables, one KEY=value per line
      </label>
      <TextArea
        id={`${uid}-env`}
        size="sm"
        mono
        rows={2}
        value={envText}
        onChange={(e) => setEnvText(e.target.value)}
        placeholder="KEY=value"
        spellCheck={false}
      />
      <label htmlFor={`${uid}-login`} className="loki-label">
        Sign-in command
      </label>
      <Field
        id={`${uid}-login`}
        size="sm"
        mono
        value={login}
        onChange={(e) => setLogin(e.target.value)}
        placeholder="Command to run in a terminal"
        spellCheck={false}
      />
      <label htmlFor={`${uid}-auth`} className="loki-label">
        Sign-in method
      </label>
      <Field
        id={`${uid}-auth`}
        size="sm"
        mono
        value={authMethod}
        onChange={(e) => setAuthMethod(e.target.value)}
        placeholder="Method id when the agent asks"
        spellCheck={false}
      />
      {error && (
        <div role="alert" className="loki-meta loki-meta--negative loki-meta--wrap">
          {error}
        </div>
      )}
      <div className="flex gap-2">
        <Button size="sm" tone="positive" onClick={() => void save()} disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" onClick={() => onDone(null)}>
          Cancel
        </Button>
      </div>
      <div className="loki-meta loki-meta--wrap">
        Kept in <span className="loki-mono">{configPath}</span>.
      </div>
    </div>
  );
}
