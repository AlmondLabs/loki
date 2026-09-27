import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { AgentFace } from "./AgentChip";
import { avatarUrl, inTauri, platform, type Platform } from "./env";
import { Button, Chip, Field, Row, Sheet } from "../components";
import { osWords } from "../shell/osWords";

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

/**
 * Which chooser Browse opens: the system's own folder dialog in the app, on every system (KTD9); in a browser
 * tab the mod's chooser, which is macOS-only and opens on the host, so the host's system decides (env.ts `platform`,
 * not the tab's own); on another host none, so Browse is not shown.
 */
export type BrowseWith = "dialog" | "mod" | null;
export function browseWith(tauri: boolean, os: Platform): BrowseWith {
  if (tauri) return "dialog";
  return os === "macos" ? "mod" : null;
}

type OpenDialog = (options: { directory: true; multiple: false; defaultPath?: string; title?: string }) => Promise<string | string[] | null>;

/** The system's folder dialog (tauri-plugin-dialog), opened at the typed folder. Resolves null when cancelled or unavailable. */
export async function dialogPick(defaultPath?: string, open: OpenDialog = async (options) => (await import("@tauri-apps/plugin-dialog")).open(options)): Promise<string | null> {
  try {
    const picked = await open({ directory: true, multiple: false, defaultPath, title: "Folder for the new chat" });
    const path = Array.isArray(picked) ? picked[0] : picked;
    return path || null;
  } catch (err) {
    console.warn("loki: folder dialog", err);
    return null;
  }
}

/** A folder's name for the list: its last segment (Windows paths split on backslashes as well). */
export function folderLabel(path: string, os: Platform = platform): string {
  return path.split(os === "windows" ? /[\\/]/ : "/").filter(Boolean).pop() ?? path;
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

/**
 * A folder field's state, shared by New chat and Change folder: the field follows context until you edit it (the
 * chat you are on for its own agent, else the agent's latest folder), is checked and completed as you type, lists
 * recent folders, and Browse opens the system's chooser. Each dialog keeps its own busy state beside `picking`.
 */
export function useFolderField({ folders, agentId, currentAgentId, currentConversationKey }: { folders: FolderApi; agentId: string | null; currentAgentId: string | null; currentConversationKey: string | null }) {
  const [folder, setFolder] = useState("");
  const [source, setSource] = useState<FolderSuggestion["source"] | null>(null);
  const [touched, setTouched] = useState(false);
  const [recent, setRecent] = useState<Record<string, string[]>>({});
  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [matches, setMatches] = useState<string[]>([]);
  const [status, setStatus] = useState<FolderStatus>(null);
  const [picking, setPicking] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Open: every agent's recent folders, and the folder of the chat this opened from.
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
        if (!gone) setReady(true);
      });
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The folder follows context until you edit it: the current chat first, then this agent's latest.
  useEffect(() => {
    if (touched) return;
    const suggestion = suggestedFolder(recent, currentFolder, agentId, currentAgentId);
    setFolder(suggestion?.path ?? "");
    setSource(suggestion?.source ?? null);
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
      if (touched) void folders.complete(f).then(setMatches);
    }, 160);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder]);

  const options = useMemo(() => folderOptions(recent, matches, agentId, touched), [recent, matches, agentId, touched]);
  /** A folder chosen from the list (or the chooser) is yours: it stops following the agent and the list closes. */
  const choose = (path: string) => {
    setFolder(path);
    setSource(null);
    setTouched(true);
    setListOpen(false);
  };
  const type = (value: string) => {
    setFolder(value);
    setSource(null);
    setTouched(true);
    setListOpen(true);
  };
  const browser = browseWith(inTauri, platform);
  const browse = async () => {
    setPicking(true);
    // The native picker validates this path itself. Passing it immediately avoids a race where a
    // quick Browse click beat the debounced status check and macOS opened an unrelated old folder.
    const pick = browser === "dialog" ? dialogPick : folders.pick;
    const picked = await pick(folder.trim() || undefined);
    setPicking(false);
    if (picked) choose(picked);
  };
  return { folder, source, touched, currentFolder, ready, status, options, listOpen, setListOpen, inputRef, picking, choose, type, browse, browser };
}

function NewDeskSheet({ onClose, agents, defaultAgentId, currentAgentId, currentConversationKey, initialName = "", folders, onCreate }: NewDeskProps) {
  const [agentId, setAgentId] = useState<string | null>(defaultAgentId ?? agents[0]?.id ?? null);
  const [name, setName] = useState(initialName);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useFolderField({ folders, agentId, currentAgentId, currentConversationKey });
  const { folder, status, listOpen, setListOpen } = field;
  const busy: false | "creating" | "picking" = creating ? "creating" : field.picking ? "picking" : false;
  const nameRef = useRef<HTMLInputElement>(null);

  // Open: the caret in the first field still to fill.
  useEffect(() => {
    const t = setTimeout(() => (initialName ? field.inputRef : nameRef).current?.focus(), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canStart = !!agentId && !!folder.trim() && status?.ok === true && !busy;
  const start = async () => {
    if (!canStart || !agentId) return;
    setCreating(true);
    setError(null);
    try {
      await onCreate(agentId, folder.trim(), name.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCreating(false);
    }
  };

  const agentName = agents.find((a) => a.id === agentId)?.name ?? null;

  return (
    // Escape is the card's: it closes the folder list first, then the sheet.
    <Sheet
      label="new chat"
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
        <div className="loki-label">New chat</div>
        <div style={{ fontSize: 17, fontWeight: 700, color: "var(--loki-fg)", marginTop: 4 }}>A fresh conversation{agentName ? ` with ${agentName}` : ""}</div>
      </div>

      <div style={{ padding: "14px 18px", display: "grid", gap: 14 }}>
        <AgentChips agents={agents} agentId={agentId} onPick={setAgentId} />

        <FolderPicker
          inputRef={field.inputRef}
          folder={folder}
          onType={field.type}
          onChoose={field.choose}
          status={status}
          options={field.options}
          listOpen={listOpen}
          setListOpen={setListOpen}
          busy={busy}
          onBrowse={() => void field.browse()}
          agentName={agentName}
          source={field.source}
          canBrowse={field.ready || field.touched}
          browser={field.browser}
        />

        <div>
          <div className="loki-label" style={{ marginBottom: 6 }}>Name <span style={{ fontWeight: 400 }}>· optional, Letta names it from the first exchange otherwise</span></div>
          <Field ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="what this chat is about" aria-label="chat name" autoComplete="off" />
        </div>

        {error && <div style={{ color: "var(--loki-negative)", fontSize: 12 }}>{error}</div>}
      </div>

      <NewDeskFooter canStart={canStart} busy={busy} onClose={onClose} onStart={() => void start()} />
    </Sheet>
  );
}

/**
 * "Change folder": move a chat to another folder. The field starts on the chat's folder, with the same list,
 * completion and Browse as New chat; Move is off until it names another folder that exists. Letta Code tells the
 * agent on its next turn that the working directory changed.
 */
export function ChangeFolder({ onClose, agentId, agentName, conversationKey, title, folders, onMove }: { onClose: () => void; agentId: string; agentName: string | null; conversationKey: string; title: string | null; folders: FolderApi; onMove: (folder: string) => Promise<string | null> }) {
  const field = useFolderField({ folders, agentId, currentAgentId: agentId, currentConversationKey: conversationKey });
  const { folder, status, listOpen, setListOpen, currentFolder } = field;
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy: false | "creating" | "picking" = moving ? "creating" : field.picking ? "picking" : false;
  useEffect(() => {
    const t = setTimeout(() => field.inputRef.current?.select(), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const target = folder.trim();
  const canMove = !!target && target !== currentFolder && status?.ok === true && !busy;
  const move = async () => {
    if (!canMove) return;
    setMoving(true);
    setError(null);
    const err = await onMove(target);
    if (err) {
      setError(err);
      setMoving(false);
    } else onClose();
  };
  return (
    <Sheet
      label="change folder"
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
            void move();
          }
        },
      }}
    >
      <div style={{ padding: "14px 18px 12px", borderBottom: "1px solid var(--loki-border)" }}>
        <div className="loki-label">Change folder</div>
        <div style={{ fontSize: 17, fontWeight: 700, color: "var(--loki-fg)", marginTop: 4 }}>{title ? `Move ${title}` : "Move this chat"}{agentName ? ` · ${agentName}` : ""}</div>
      </div>
      <div style={{ padding: "14px 18px", display: "grid", gap: 14 }}>
        <FolderPicker
          inputRef={field.inputRef}
          folder={folder}
          onType={field.type}
          onChoose={field.choose}
          status={status}
          options={field.options}
          listOpen={listOpen}
          setListOpen={setListOpen}
          busy={busy}
          onBrowse={() => void field.browse()}
          agentName={agentName}
          source={field.source}
          canBrowse={field.ready || field.touched}
          browser={field.browser}
        />
        <div className="loki-meta loki-meta--wrap">{currentFolder ? `Now in ${currentFolder}. ` : ""}The agent is told the folder changed on its next turn.</div>
        {error && <div style={{ color: "var(--loki-negative)", fontSize: 12 }}>{error}</div>}
      </div>
      <div style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid var(--loki-border)", alignItems: "center" }}>
        <span className="loki-label">Enter move · esc close</span>
        <span style={{ flex: 1 }} />
        <Button size="sm" onClick={onClose}>cancel</Button>
        <Button size="sm" tone="positive" onClick={() => void move()} disabled={!canMove}>
          {moving ? "moving…" : "move"}
        </Button>
      </div>
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
        {agents.length === 0 && <span className="loki-meta loki-meta--wrap">no agents yet — is Desktop running?</span>}
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
 * The folder field with its Browse button (where there is a chooser) and the completion list under it. The list's highlight
 * lives here; the parent keeps whether the list is open, since the sheet's Escape closes it first.
 */
export function FolderPicker({
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
  browser,
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
  browser: BrowseWith;
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
          placeholder={osWords().folderExample}
          aria-label="folder"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={status ? !status.ok : undefined}
        />
        {browser && (
          <Button size="sm" onClick={onBrowse} disabled={busy !== false || !canBrowse} title={`choose a folder in ${osWords().fileManager}`}>
            {busy === "picking" ? "choosing…" : !canBrowse ? "loading…" : "browse…"}
          </Button>
        )}
      </div>
      {listOpen && options.length > 0 && <FolderList options={options} hi={hi} onHover={setHi} onChoose={onChoose} agentName={agentName} beside={!!browser} />}
    </div>
  );
}

/** The completion list: grouped rows, a heading where a group starts (typed matches need none). */
function FolderList({ options, hi, onHover, onChoose, agentName, beside }: { options: FolderOption[]; hi: number; onHover: (i: number) => void; onChoose: (path: string) => void; agentName: string | null; beside: boolean }) {
  return (
    <div role="listbox" aria-label="folders" style={{ position: "absolute", left: 0, right: beside ? 92 : 0, top: "100%", marginTop: 4, background: "var(--loki-panel)", border: "1px solid var(--loki-border)", borderRadius: "var(--loki-radius-md)", boxShadow: "var(--loki-shadow-float)", maxHeight: 240, overflowY: "auto", zIndex: 2 }}>
      {options.map((o, i) => {
        const label = folderLabel(o.path);
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
              <div className="loki-meta" style={{ fontFamily: "var(--loki-mono)" }}>{o.path}</div>
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
