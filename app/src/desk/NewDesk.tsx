import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { AgentFace } from "./AgentChip";
import { avatarUrl } from "./env";
import { Button, Chip, Field, Row, Sheet } from "../components";

export interface FolderApi {
  recent: () => Promise<{ byAgent: Record<string, string[]>; byConversation: Record<string, string> }>;
  complete: (prefix: string) => Promise<string[]>;
  check: (path: string) => Promise<{ ok: boolean; path: string; branch: string | null; reason?: string }>;
  pick: (defaultPath?: string) => Promise<string | null>;
}

/**
 * "New desk": a fresh conversation under an agent, in a folder. Agent first,
 * folder second (defaults follow the agent), name optional. Enter starts.
 */
export function NewDesk({ open, ...props }: NewDeskProps & { open: boolean }) {
  // Closed: nothing mounted, so each opening starts from the desk you are on (agent, folder, name).
  if (!open) return null;
  return <NewDeskSheet {...props} />;
}

interface NewDeskProps {
  onClose: () => void;
  agents: Array<{ id: string; name: string }>;
  defaultAgentId: string | null;
  /** The desk this dialog opened from; its exact folder wins over recency for that same agent. */
  currentAgentId: string | null;
  currentConversationKey: string | null;
  initialName?: string;
  folders: FolderApi;
  onCreate: (agentId: string, folder: string, name: string) => Promise<void>;
}

type FolderStatus = { ok: boolean; branch: string | null; reason?: string } | null;
type FolderOption = { path: string; group: "match" | "mine" | "others" };
type FolderSuggestion = { path: string; source: "current" | "recent" };

/** The predictable hierarchy for an untouched folder field. */
export function suggestedFolder(recent: Record<string, string[]>, currentFolder: string | null, agentId: string | null, currentAgentId: string | null): FolderSuggestion | null {
  if (!agentId) return null;
  if (currentFolder && agentId === currentAgentId) return { path: currentFolder, source: "current" };
  const latest = recent[agentId]?.[0];
  return latest ? { path: latest, source: "recent" } : null;
}

/** The folder list's rows: typed completions first; then this agent's recent folders; then everyone else's. */
function folderOptions(recent: Record<string, string[]>, matches: string[], agentId: string | null, folderTouched: boolean): FolderOption[] {
  const mine = agentId ? recent[agentId] ?? [] : [];
  const others = Object.entries(recent).filter(([a]) => a !== agentId).flatMap(([, l]) => l);
  const seen = new Set<string>();
  const list: FolderOption[] = [];
  const take = (paths: string[], group: FolderOption["group"]) => {
    for (const p of paths) {
      if (seen.has(p)) continue;
      seen.add(p);
      list.push({ path: p, group });
    }
  };
  take(folderTouched ? matches : [], "match");
  take(mine, "mine");
  take(others, "others");
  return list.slice(0, 14);
}

function NewDeskSheet({ onClose, agents, defaultAgentId, currentAgentId, currentConversationKey, initialName = "", folders, onCreate }: NewDeskProps) {
  const [agentId, setAgentId] = useState<string | null>(defaultAgentId ?? agents[0]?.id ?? null);
  const [folder, setFolder] = useState("");
  const [folderSource, setFolderSource] = useState<FolderSuggestion["source"] | null>(null);
  const [folderTouched, setFolderTouched] = useState(false);
  const [name, setName] = useState(initialName);
  const [recent, setRecent] = useState<Record<string, string[]>>({});
  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  const [foldersReady, setFoldersReady] = useState(false);
  const [matches, setMatches] = useState<string[]>([]);
  const [status, setStatus] = useState<FolderStatus>(null);
  const [busy, setBusy] = useState<false | "creating" | "picking">(false);
  const [error, setError] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const folderRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // Open: every agent's recent folders, and the caret in the first field still to fill.
  useEffect(() => {
    let gone = false;
    void folders
      .recent()
      .then((r) => {
        if (gone) return;
        setRecent(r.byAgent);
        setCurrentFolder(currentConversationKey ? r.byConversation[currentConversationKey] ?? null : null);
      })
      .catch(() => {}) // no recent folders to offer; Browse still works
      .finally(() => {
        if (!gone) setFoldersReady(true);
      });
    const t = setTimeout(() => (initialName ? folderRef : nameRef).current?.focus(), 0);
    return () => {
      gone = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The folder follows context until you edit it: the current desk first, then this agent's latest.
  useEffect(() => {
    if (folderTouched) return;
    const suggestion = suggestedFolder(recent, currentFolder, agentId, currentAgentId);
    setFolder(suggestion?.path ?? "");
    setFolderSource(suggestion?.source ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, recent, currentFolder]);

  // Validate (and complete) as you type, debounced.
  useEffect(() => {
    const f = folder.trim();
    if (!f) {
      setStatus(null);
      setMatches([]);
      return;
    }
    const t = setTimeout(() => {
      void folders.check(f).then((r) => setStatus({ ok: r.ok, branch: r.branch, reason: r.reason }));
      if (folderTouched) void folders.complete(f).then(setMatches);
    }, 160);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder]);

  const options = useMemo(() => folderOptions(recent, matches, agentId, folderTouched), [recent, matches, agentId, folderTouched]);

  const canStart = !!agentId && !!folder.trim() && status?.ok === true && !busy;
  const start = async () => {
    if (!canStart || !agentId) return;
    setBusy("creating");
    setError(null);
    try {
      await onCreate(agentId, folder.trim(), name.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  const browse = async () => {
    setBusy("picking");
    // The native picker validates this path itself. Passing it immediately avoids a race where a
    // quick Browse click beat the debounced status check and macOS opened an unrelated old folder.
    const picked = await folders.pick(folder.trim() || undefined);
    setBusy(false);
    if (picked) {
      setFolder(picked);
      setFolderSource(null);
      setFolderTouched(true);
      setListOpen(false);
    }
  };
  /** A folder chosen from the list (or Finder) is yours: it stops following the agent and the list closes. */
  const chooseFolder = (path: string) => {
    setFolder(path);
    setFolderSource(null);
    setFolderTouched(true);
    setListOpen(false);
  };

  const agentName = agents.find((a) => a.id === agentId)?.name ?? null;

  return (
    // Escape is the card's: it closes the folder list first, then the sheet.
    <Sheet
      label="new desk"
      onClose={onClose}
      width={560}
      top="72px"
      escape={false}
      cardProps={{
        onKeyDown: (e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            if (listOpen) setListOpen(false);
            else onClose();
          } else if (e.key === "Enter" && !listOpen) {
            e.preventDefault();
            void start();
          }
        },
      }}
    >
      <div style={{ padding: "14px 18px 12px", borderBottom: "1px solid var(--loki-border)" }}>
        <div className="loki-label">New desk</div>
        <div style={{ fontSize: 17, fontWeight: 700, color: "var(--loki-fg)", marginTop: 4 }}>A fresh conversation{agentName ? ` with ${agentName}` : ""}</div>
      </div>

      <div style={{ padding: "14px 18px", display: "grid", gap: 14 }}>
        <AgentChips agents={agents} agentId={agentId} onPick={setAgentId} />

        <FolderPicker
          inputRef={folderRef}
          folder={folder}
          onType={(value) => {
            setFolder(value);
            setFolderSource(null);
            setFolderTouched(true);
            setListOpen(true);
          }}
          onChoose={chooseFolder}
          status={status}
          options={options}
          listOpen={listOpen}
          setListOpen={setListOpen}
          busy={busy}
          onBrowse={() => void browse()}
          agentName={agentName}
          source={folderSource}
          canBrowse={foldersReady || folderTouched}
        />

        <div>
          <div className="loki-label" style={{ marginBottom: 6 }}>Name <span style={{ fontWeight: 400 }}>· optional, Letta names it from the first exchange otherwise</span></div>
          <Field ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="what this desk is about" aria-label="desk name" autoComplete="off" />
        </div>

        {error && <div style={{ color: "var(--loki-negative)", fontSize: 12 }}>{error}</div>}
      </div>

      <NewDeskFooter canStart={canStart} busy={busy} onClose={onClose} onStart={() => void start()} />
    </Sheet>
  );
}

/** The agent row: one radio chip per agent, the chosen one pressed (active). */
function AgentChips({ agents, agentId, onPick }: { agents: NewDeskProps["agents"]; agentId: string | null; onPick: (id: string) => void }) {
  return (
    <div>
      <div className="loki-label" style={{ marginBottom: 6 }}>Agent</div>
      <div role="radiogroup" aria-label="agent" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {agents.map((a) => (
          <Chip key={a.id} label role="radio" aria-checked={a.id === agentId} active={a.id === agentId} onClick={() => onPick(a.id)}>
            <AgentFace name={a.name} src={avatarUrl(a.id)} size={14} />
            {a.name}
          </Chip>
        ))}
        {agents.length === 0 && <span style={{ fontSize: 12, color: "var(--loki-muted)" }}>no agents yet — is Desktop running?</span>}
      </div>
    </div>
  );
}

/** The folder's verdict beside its label: the branch when it is a repo, "folder ok" otherwise, the reason when it is not. */
function FolderVerdict({ status }: { status: FolderStatus }) {
  return (
    <span style={{ fontWeight: 400, color: status ? (status.ok ? "var(--loki-positive)" : "var(--loki-negative)") : "var(--loki-muted)" }}>
      {status ? (status.ok ? (status.branch ? `⎇ ${status.branch}` : "folder ok") : status.reason) : ""}
    </span>
  );
}

/**
 * The folder field with its Finder button and the completion list under it. The list's highlight
 * lives here; the parent keeps whether the list is open, since the sheet's Escape closes it first.
 */
function FolderPicker({
  inputRef,
  folder,
  onType,
  onChoose,
  status,
  options,
  listOpen,
  setListOpen,
  busy,
  onBrowse,
  agentName,
  source,
  canBrowse,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  folder: string;
  onType: (value: string) => void;
  onChoose: (path: string) => void;
  status: FolderStatus;
  options: FolderOption[];
  listOpen: boolean;
  setListOpen: (open: boolean) => void;
  busy: false | "creating" | "picking";
  onBrowse: () => void;
  agentName: string | null;
  source: FolderSuggestion["source"] | null;
  canBrowse: boolean;
}) {
  const [hi, setHi] = useState(0);
  return (
    <div style={{ position: "relative" }}>
      <div className="loki-label" style={{ marginBottom: 6, display: "flex", justifyContent: "space-between" }}>
        <span>
          Folder
          {source && <span style={{ fontWeight: 400, marginLeft: 6 }}>· {source === "current" ? "current desk" : `recent for ${agentName ?? "this agent"}`}</span>}
        </span>
        <FolderVerdict status={status} />
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Field
          ref={inputRef}
          mono
          size="sm"
          value={folder}
          onChange={(e) => {
            onType(e.target.value);
            setHi(0);
          }}
          onFocus={() => setListOpen(true)}
          onBlur={() => setTimeout(() => setListOpen(false), 120)}
          onKeyDown={(e) => {
            if (!listOpen || !options.length) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHi((i) => Math.min(options.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHi((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              onChoose(options[hi].path);
            }
          }}
          placeholder="~/Documents/…"
          aria-label="folder"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={status ? !status.ok : undefined}
        />
        <Button size="sm" onClick={onBrowse} disabled={busy !== false || !canBrowse} title="choose a folder in Finder">
          {busy === "picking" ? "choosing…" : !canBrowse ? "loading…" : "browse…"}
        </Button>
      </div>
      {listOpen && options.length > 0 && <FolderList options={options} hi={hi} onHover={setHi} onChoose={onChoose} agentName={agentName} />}
    </div>
  );
}

/** The completion list: grouped rows, a heading where a group starts (typed matches need none). */
function FolderList({ options, hi, onHover, onChoose, agentName }: { options: FolderOption[]; hi: number; onHover: (i: number) => void; onChoose: (path: string) => void; agentName: string | null }) {
  return (
    <div role="listbox" aria-label="folders" style={{ position: "absolute", left: 0, right: 92, top: "100%", marginTop: 4, background: "var(--loki-panel)", border: "1px solid var(--loki-border)", borderRadius: 8, boxShadow: "var(--loki-shadow-float)", maxHeight: 240, overflowY: "auto", zIndex: 2 }}>
      {options.map((o, i) => {
        const label = o.path.split("/").filter(Boolean).pop() ?? o.path;
        const first = i === 0 || options[i - 1].group !== o.group;
        return (
          <div key={o.path}>
            {first && o.group !== "match" && <div className="loki-label" style={{ padding: "8px 10px 2px" }}>{o.group === "mine" ? `${agentName ?? "This agent"}'s recent folders` : "Other agents' folders"}</div>}
            <Row
              dense
              role="option"
              tabIndex={-1}
              aria-selected={i === hi}
              onMouseEnter={() => onHover(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                onChoose(o.path);
              }}
              style={{ display: "grid", gap: 0 }}
            >
              <div style={{ fontSize: 13.5, color: "var(--loki-fg)" }}>{label}</div>
              <div style={{ fontSize: 10.5, color: "var(--loki-muted)", fontFamily: "var(--loki-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.path}</div>
            </Row>
          </div>
        );
      })}
    </div>
  );
}

function NewDeskFooter({ canStart, busy, onClose, onStart }: { canStart: boolean; busy: false | "creating" | "picking"; onClose: () => void; onStart: () => void }) {
  return (
    <div style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid var(--loki-border)", alignItems: "center" }}>
      <span className="loki-label">Enter start · esc close</span>
      <span style={{ flex: 1 }} />
      <Button size="sm" onClick={onClose}>cancel</Button>
      <Button size="sm" tone="positive" onClick={onStart} disabled={!canStart}>
        {busy === "creating" ? "starting…" : "start"}
      </Button>
    </div>
  );
}
