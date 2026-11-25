import { useEffect, useEffectEvent, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { inDesktop, platform, type Platform } from "./env";
import { openDialog } from "../shell/desktop";
import { Button, Field, Row, Sheet } from "../components";
import { osWords } from "../shell/os-words";
import { formatKeys } from "../shell/keymap";
import type { Pushes } from "../../../core/frames.ts";
import { GitBranchIcon } from "lucide-react";
import { Glyph } from "../shared/icons";

export interface FolderApi {
  recent: (home?: string) => Promise<{ byAgent: Partial<Record<string, string[]>>; byConversation: Partial<Record<string, string>> }>;
  complete: (prefix: string, home?: string) => Promise<string[]>;
  check: (path: string, home?: string) => Promise<{ ok: boolean; path: string; branch: string | null; reason?: string }>;
  pick: (defaultPath?: string) => Promise<string | null>;
}

export interface NewChatAgent {
  id: string;
  name: string;
  home_mac?: string | null;
}

interface NewDeskProps {
  onClose: () => void;
  agents: NewChatAgent[];
  macs?: Pushes["peers"] | null;
  defaultAgentId: string | null;
  currentAgentId: string | null;
  currentConversationKey: string | null;
  initialName?: string;
  folders: FolderApi;
  onCreate: (agentId: string, folder: string, name: string, home?: string) => Promise<void>;
  requirements?: (agentId: string, home?: string) => Promise<string[]>;
}

export type BrowseWith = "dialog" | "mod" | null;
export function browseWith(shell: boolean, os: Platform): BrowseWith {
  if (shell) return "dialog";
  return os === "macos" ? "mod" : null;
}

type OpenDialog = (options: { directory: true; multiple: false; defaultPath?: string; title?: string }) => Promise<string | string[] | null>;

export async function dialogPick(defaultPath?: string, open: OpenDialog = openDialog): Promise<string | null> {
  try {
    const picked = await open({ directory: true, multiple: false, defaultPath, title: "Folder for the new chat" });
    const path = Array.isArray(picked) ? picked[0] : picked;
    return path || null;
  } catch (err) {
    console.warn("loki: folder dialog", err);
    return null;
  }
}

export function folderLabel(path: string, os: Platform = platform): string {
  return (
    path
      .split(os === "windows" ? /[\\/]/ : "/")
      .filter(Boolean)
      .pop() ?? path
  );
}

type FolderStatus = { ok: boolean; branch: string | null; reason?: string } | null;
interface FolderOption {
  path: string;
  group: "match" | "mine" | "others";
}
interface FolderSuggestion {
  path: string;
  source: "current" | "recent";
}

export function suggestedFolder(
  recent: Partial<Record<string, string[]>>,
  currentFolder: string | null,
  agentId: string | null,
  currentAgentId: string | null,
): FolderSuggestion | null {
  if (!agentId) return null;
  if (currentFolder && agentId === currentAgentId) return { path: currentFolder, source: "current" };
  const latest = recent[agentId]?.[0];
  return latest ? { path: latest, source: "recent" } : null;
}

function folderOptions(recent: Partial<Record<string, string[]>>, matches: string[], agentId: string | null, folderTouched: boolean): FolderOption[] {
  const mine = agentId ? (recent[agentId] ?? []) : [];
  const others = Object.entries(recent)
    .filter(([a]) => a !== agentId)
    .flatMap(([, l]) => l ?? []);
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

export function useFolderField({
  folders,
  agentId,
  currentAgentId,
  currentConversationKey,
  home,
}: {
  folders: FolderApi;
  agentId: string | null;
  currentAgentId: string | null;
  currentConversationKey: string | null;
  home?: string;
}) {
  const [ownFolder, setOwnFolder] = useState("");
  const [touched, setTouched] = useState(false);
  const [recent, setRecent] = useState<Partial<Record<string, string[]>>>({});
  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [matches, setMatches] = useState<string[]>([]);
  const [checked, setChecked] = useState<{ folder: string; home: string | undefined; status: FolderStatus } | null>(null);
  const [picking, setPicking] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const readRecent = useEffectEvent(() =>
    folders.recent(home).then((r) => ({
      byAgent: r.byAgent,
      current: currentConversationKey ? (r.byConversation[currentConversationKey] ?? null) : null,
    })),
  );
  useEffect(() => {
    let gone = false;
    void readRecent()
      .then((r) => {
        if (gone) return;
        setRecent(r.byAgent);
        setCurrentFolder(r.current);
      })
      .catch(() => {})
      .finally(() => {
        if (!gone) setReady(true);
      });
    return () => {
      gone = true;
    };
  }, [home]);

  const suggestion = touched ? null : suggestedFolder(recent, currentFolder, agentId, currentAgentId);
  const folder = touched ? ownFolder : (suggestion?.path ?? "");
  const source = suggestion?.source ?? null;

  const trimmed = folder.trim();
  const status = checked?.folder === trimmed && checked.home === home ? checked.status : null;
  if (!trimmed && matches.length > 0) setMatches([]);
  const validate = useEffectEvent((f: string) => {
    void folders.check(f, home).then((r) => setChecked({ folder: f, home, status: { ok: r.ok, branch: r.branch, reason: r.reason } }));
    if (touched) void folders.complete(f, home).then(setMatches);
  });
  useEffect(() => {
    if (!trimmed) return;
    const t = setTimeout(() => validate(trimmed), 160);
    return () => clearTimeout(t);
  }, [trimmed, folder, home]);

  const options = useMemo(() => folderOptions(recent, matches, agentId, touched), [recent, matches, agentId, touched]);
  const choose = (path: string) => {
    setOwnFolder(path);
    setTouched(true);
    setListOpen(false);
  };
  const type = (value: string) => {
    setOwnFolder(value);
    setTouched(true);
    setListOpen(true);
  };
  const browser = home ? null : browseWith(inDesktop, platform);
  const browse = async () => {
    setPicking(true);
    const pick = browser === "dialog" ? dialogPick : folders.pick;
    const picked = await pick(folder.trim() || undefined);
    setPicking(false);
    if (picked) choose(picked);
  };
  return { folder, source, touched, currentFolder, ready, status, options, listOpen, setListOpen, inputRef, picking, choose, type, browse, browser };
}

export function useChatHome(agents: NewChatAgent[], agentId: string | null, macs: NewDeskProps["macs"], requirements: NewDeskProps["requirements"]) {
  const [pickHere, setPickHere] = useState(false);
  const agentHome = agentHomeOf(
    agents.find((a) => a.id === agentId),
    macs,
  );
  const remote = agentHome?.reachable && !pickHere ? agentHome : null;
  const [missing, setMissing] = useState<{ key: string; lines: string[] } | null>(null);
  const missingKey = `${agentId ?? ""}@${remote?.mac_id ?? ""}`;
  useEffect(() => {
    if (!agentId || !requirements) return;
    let live = true;
    void requirements(agentId, remote?.mac_id).then((lines) => live && setMissing({ key: missingKey, lines }));
    return () => {
      live = false;
    };
  }, [agentId, remote?.mac_id, requirements, missingKey]);
  const lacks = missing?.key === missingKey ? missing.lines : [];
  const home = remote ? remote.mac_id : agentHome ? macs?.me.mac_id : undefined;
  return { agentHome, remote, pickHere, setPickHere, lacks, home };
}

function agentHomeOf(agent: { home_mac?: string | null } | undefined, macs: Pushes["peers"] | null | undefined): Pushes["peers"]["peers"][number] | undefined {
  if (!agent?.home_mac || !macs || agent.home_mac === macs.me.mac_id) return undefined;
  return macs.peers.find((p) => p.mac_id === agent.home_mac);
}

export function ChangeFolder({
  onClose,
  agentId,
  agentName,
  conversationKey,
  title,
  folders,
  onMove,
}: {
  onClose: () => void;
  agentId: string;
  agentName: string | null;
  conversationKey: string;
  title: string | null;
  folders: FolderApi;
  onMove: (folder: string) => Promise<string | null>;
}) {
  const field = useFolderField({ folders, agentId, currentAgentId: agentId, currentConversationKey: conversationKey });
  const { folder, status, listOpen, setListOpen, currentFolder } = field;
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy: false | "creating" | "picking" = moving ? "creating" : field.picking ? "picking" : false;
  const folderInput = field.inputRef;
  useEffect(() => {
    const t = setTimeout(() => folderInput.current?.select(), 0);
    return () => clearTimeout(t);
  }, [folderInput]);
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
  const sheet = (
    <Sheet
      label="Change folder"
      onClose={onClose}
      width={560}
      top="18vh"
      scroll
      escape={false}
      cardProps={{ onKeyDown: sheetKeys(listOpen, setListOpen, onClose, () => void move()) }}
    >
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--loki-border)" }}>
        <div className="loki-label">Change folder</div>
        <div style={{ fontSize: "var(--text-base)", fontWeight: 700, color: "var(--loki-fg)", marginTop: 4 }}>
          {title ? `Move ${title}` : "Move this chat"}
          {agentName ? ` · ${agentName}` : ""}
        </div>
      </div>
      <div className="grid gap-4" style={{ padding: 16 }}>
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
        <div className="loki-meta loki-meta--wrap">
          {currentFolder ? `Now in ${currentFolder}. ` : ""}The agent is told the folder changed on its next turn.
        </div>
        {error && (
          <div role="alert" className="loki-meta loki-meta--negative loki-meta--wrap">
            {error}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2" style={{ padding: 12, borderTop: "1px solid var(--loki-border)" }}>
        <span className="flex-1" />
        <Button size="sm" kbd={formatKeys("escape")} onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" tone="positive" kbd={formatKeys("enter")} onClick={() => void move()} disabled={!canMove}>
          {moving ? "moving…" : "move"}
        </Button>
      </div>
    </Sheet>
  );
  return typeof document === "undefined" ? sheet : createPortal(sheet, document.body);
}

function sheetKeys(listOpen: boolean, setListOpen: (open: boolean) => void, onClose: () => void, onEnter: () => void) {
  return (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (listOpen) setListOpen(false);
      else onClose();
    } else if (e.key === "Enter" && !listOpen) {
      e.preventDefault();
      onEnter();
    }
  };
}

function FolderVerdict({ status }: { status: FolderStatus }) {
  return (
    <span style={{ fontWeight: 400, color: status ? (status.ok ? "var(--loki-positive)" : "var(--loki-negative)") : "var(--loki-muted)" }}>
      {status ? (
        status.ok ? (
          status.branch ? (
            <>
              <Glyph icon={GitBranchIcon} size={12} inline /> {status.branch}
            </>
          ) : (
            "folder ok"
          )
        ) : (
          status.reason
        )
      ) : (
        ""
      )}
    </span>
  );
}

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
  const [hi, setHi] = useState(-1);
  const listId = useId();
  const shown = listOpen && options.length > 0;
  return (
    <div style={{ position: "relative" }}>
      <div className="loki-label flex justify-between" style={{ marginBottom: 8 }}>
        <span>
          Folder
          {source && (
            <span style={{ fontWeight: 400, marginLeft: 4 }}>· {source === "current" ? "current chat" : `recent for ${agentName ?? "this agent"}`}</span>
          )}
        </span>
        <FolderVerdict status={status} />
      </div>
      <div className="flex gap-2">
        <Field
          ref={inputRef}
          mono
          size="sm"
          value={folder}
          onChange={(e) => {
            onType(e.target.value);
            setHi(0);
          }}
          onFocus={() => {
            setListOpen(true);
            setHi(-1);
          }}
          onBlur={() => setTimeout(() => setListOpen(false), 120)}
          onKeyDown={(e) => {
            if (!shown) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHi((i) => Math.min(options.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHi((i) => Math.max(0, i - 1));
            } else if (hi >= 0 && hi < options.length && e.key === "Enter") {
              e.preventDefault();
              onChoose(options[hi].path);
            } else if (hi >= 0 && hi < options.length && e.key === "Tab") {
              onChoose(options[hi].path);
            }
          }}
          placeholder={osWords().folderExample}
          aria-label="Folder"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={shown}
          aria-controls={shown ? listId : undefined}
          aria-activedescendant={shown && hi >= 0 ? `${listId}-${hi}` : undefined}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={status ? !status.ok : undefined}
        />
        {browser && (
          <Button size="sm" onClick={onBrowse} disabled={busy !== false || !canBrowse} title={`Choose a folder in ${osWords().fileManager}`}>
            {busy === "picking" ? "Choosing…" : !canBrowse ? "Loading…" : "Browse…"}
          </Button>
        )}
      </div>
      {shown && <FolderList id={listId} options={options} hi={hi} onHover={setHi} onChoose={onChoose} agentName={agentName} beside={!!browser} />}
    </div>
  );
}

function FolderList({
  id,
  options,
  hi,
  onHover,
  onChoose,
  agentName,
  beside,
}: {
  id: string;
  options: FolderOption[];
  hi: number;
  onHover: (i: number) => void;
  onChoose: (path: string) => void;
  agentName: string | null;
  beside: boolean;
}) {
  return (
    <div
      id={id}
      role="listbox"
      aria-label="Folders"
      style={{
        position: "absolute",
        left: 0,
        right: beside ? 92 : 0,
        top: "100%",
        marginTop: 4,
        background: "var(--loki-panel)",
        border: "1px solid var(--loki-border)",
        borderRadius: "var(--radius-lg)",
        boxShadow: "var(--loki-shadow-float)",
        maxHeight: 240,
        overflowY: "auto",
        zIndex: 2,
      }}
    >
      {options.map((o, i) => {
        const label = folderLabel(o.path);
        const first = i === 0 || options[i - 1].group !== o.group;
        return (
          <div key={o.path}>
            {first && o.group !== "match" && (
              <div className="loki-label" style={{ padding: "8px 8px 2px" }}>
                {o.group === "mine" ? `${agentName ?? "This agent"}'s recent folders` : "Other agents' folders"}
              </div>
            )}
            <Row
              id={`${id}-${i}`}
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
              <div style={{ fontSize: "var(--text-sm)", color: "var(--loki-fg)" }}>{label}</div>
              <div className="loki-meta loki-mono">{o.path}</div>
            </Row>
          </div>
        );
      })}
    </div>
  );
}
