import { useEffect, useMemo, useRef, useState } from "react";
import { AgentFace } from "./AgentChip";
import { avatarUrl } from "./env";
import { Button, Chip, Field, Row, Sheet } from "../ui";

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
  /** The folder of the desk you are on, if known. */
  defaultFolder: string | null;
  initialName?: string;
  folders: FolderApi;
  onCreate: (agentId: string, folder: string, name: string) => Promise<void>;
}

function NewDeskSheet({ onClose, agents, defaultAgentId, defaultFolder, initialName = "", folders, onCreate }: NewDeskProps) {
  const [agentId, setAgentId] = useState<string | null>(defaultAgentId ?? agents[0]?.id ?? null);
  const [folder, setFolder] = useState(defaultFolder ?? "");
  const [folderTouched, setFolderTouched] = useState(false);
  const [name, setName] = useState(initialName);
  const [recent, setRecent] = useState<Record<string, string[]>>({});
  const [matches, setMatches] = useState<string[]>([]);
  const [status, setStatus] = useState<{ ok: boolean; branch: string | null; reason?: string } | null>(null);
  const [busy, setBusy] = useState<false | "creating" | "picking">(false);
  const [error, setError] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const folderRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // Open: every agent's recent folders, and the caret in the first field still to fill.
  useEffect(() => {
    let gone = false;
    void folders.recent().then((r) => {
      if (!gone) setRecent(r.byAgent);
    });
    const t = setTimeout(() => (initialName ? folderRef : nameRef).current?.focus(), 0);
    return () => {
      gone = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The folder follows the agent until you edit it.
  useEffect(() => {
    if (folderTouched || !agentId) return;
    const first = recent[agentId]?.[0];
    if (first) setFolder(first);
    else if (defaultFolder) setFolder(defaultFolder);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, recent]);

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

  const options = useMemo(() => {
    // typed completions first; then this agent's recent folders; then everyone else's
    const mine = agentId ? recent[agentId] ?? [] : [];
    const others = Object.entries(recent).filter(([a]) => a !== agentId).flatMap(([, l]) => l);
    const seen = new Set<string>();
    const list: Array<{ path: string; group: "match" | "mine" | "others" }> = [];
    for (const p of folderTouched ? matches : []) if (!seen.has(p)) (seen.add(p), list.push({ path: p, group: "match" }));
    for (const p of mine) if (!seen.has(p)) (seen.add(p), list.push({ path: p, group: "mine" }));
    for (const p of others) if (!seen.has(p)) (seen.add(p), list.push({ path: p, group: "others" }));
    return list.slice(0, 14);
  }, [recent, matches, agentId, folderTouched]);

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
    const picked = await folders.pick(status?.ok ? folder.trim() : undefined);
    setBusy(false);
    if (picked) {
      setFolder(picked);
      setFolderTouched(true);
      setListOpen(false);
    }
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
        <div className="loki-label">new desk</div>
        <div style={{ fontFamily: "var(--loki-display)", fontSize: 17, color: "var(--loki-fg)", marginTop: 4 }}>a fresh conversation{agentName ? ` with ${agentName}` : ""}</div>
      </div>

      <div style={{ padding: "14px 18px", display: "grid", gap: 14 }}>
        <div>
          <div className="loki-label" style={{ fontSize: 10.5, marginBottom: 6 }}>agent</div>
          <div role="radiogroup" aria-label="agent" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {agents.map((a) => (
              <Chip key={a.id} label role="radio" aria-checked={a.id === agentId} brass={a.id === agentId} onClick={() => setAgentId(a.id)}>
                <AgentFace name={a.name} src={avatarUrl(a.id)} size={14} />
                {a.name}
              </Chip>
            ))}
            {agents.length === 0 && <span style={{ fontSize: 12, color: "var(--loki-muted)" }}>no agents yet — is Desktop running?</span>}
          </div>
        </div>

        <div style={{ position: "relative" }}>
          <div className="loki-label" style={{ fontSize: 10.5, marginBottom: 6, display: "flex", justifyContent: "space-between" }}>
            <span>folder</span>
            <span style={{ textTransform: "none", letterSpacing: 0, fontFamily: "var(--loki-mono)", color: status ? (status.ok ? "var(--loki-positive)" : "var(--loki-negative)") : "var(--loki-muted)" }}>
              {status ? (status.ok ? (status.branch ? `⎇ ${status.branch}` : "folder ok") : status.reason) : ""}
            </span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Field
              ref={folderRef}
              mono
              size="sm"
              value={folder}
              onChange={(e) => {
                setFolder(e.target.value);
                setFolderTouched(true);
                setListOpen(true);
                setHi(0);
              }}
              onFocus={() => setListOpen(true)}
              onBlur={() => setTimeout(() => setListOpen(false), 120)}
              onKeyDown={(e) => {
                if (!listOpen || !options.length) return;
                if (e.key === "ArrowDown") (e.preventDefault(), setHi((i) => Math.min(options.length - 1, i + 1)));
                else if (e.key === "ArrowUp") (e.preventDefault(), setHi((i) => Math.max(0, i - 1)));
                else if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  setFolder(options[hi].path);
                  setFolderTouched(true);
                  setListOpen(false);
                }
              }}
              placeholder="~/Documents/…"
              aria-label="folder"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={status ? !status.ok : undefined}
            />
            <Button size="sm" onClick={() => void browse()} disabled={busy !== false} title="choose a folder in Finder">
              {busy === "picking" ? "choosing…" : "browse…"}
            </Button>
          </div>
          {listOpen && options.length > 0 && (
            <div role="listbox" aria-label="folders" style={{ position: "absolute", left: 0, right: 92, top: "100%", marginTop: 4, background: "var(--loki-panel)", border: "1px solid var(--loki-border)", borderRadius: 8, boxShadow: "var(--loki-shadow-float)", maxHeight: 240, overflowY: "auto", zIndex: 2 }}>
              {options.map((o, i) => {
                const label = o.path.split("/").filter(Boolean).pop() ?? o.path;
                const first = i === 0 || options[i - 1].group !== o.group;
                return (
                  <div key={o.path}>
                    {first && o.group !== "match" && <div className="loki-label" style={{ fontSize: 9.5, padding: "8px 10px 2px" }}>{o.group === "mine" ? `${agentName ?? "this agent"}'s recent folders` : "other agents' folders"}</div>}
                    <Row
                      dense
                      role="option"
                      tabIndex={-1}
                      aria-selected={i === hi}
                      onMouseEnter={() => setHi(i)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setFolder(o.path);
                        setFolderTouched(true);
                        setListOpen(false);
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
          )}
        </div>

        <div>
          <div className="loki-label" style={{ fontSize: 10.5, marginBottom: 6 }}>name <span style={{ textTransform: "none", letterSpacing: 0 }}>· optional, Letta names it from the first exchange otherwise</span></div>
          <Field ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="what this desk is about" aria-label="desk name" autoComplete="off" />
        </div>

        {error && <div style={{ color: "var(--loki-negative)", fontSize: 12, fontFamily: "var(--loki-mono)" }}>{error}</div>}
      </div>

      <div style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid var(--loki-border)", alignItems: "center" }}>
        <span className="loki-label" style={{ fontSize: 10.5 }}>enter start · esc close</span>
        <span style={{ flex: 1 }} />
        <Button size="sm" onClick={onClose}>cancel</Button>
        <Button size="sm" tone="brass" onClick={() => void start()} disabled={!canStart}>
          {busy === "creating" ? "starting…" : "start"}
        </Button>
      </div>
    </Sheet>
  );
}
