import { useEffect, useMemo, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AttentionItem } from "../../../core/attention/model.ts";
import type { MemoryCommit } from "../../../mod/agents.ts";
import { Diff, type AgentDetails } from "../agents/Agents";
import { ago } from "../board/model";
import { avatarUrl } from "../desk/env";
import type { DeskSummary } from "../desk/useDesk";
import { useAgentDetails, type PhoneAgentsApi } from "./Agents";
import { DeskRow } from "./Home";
import { Icon } from "./icons";
import { lastSeen, liveDeskCount, liveDesksLabel, memoryFolders, modelBits, stripFrontmatter, type MemoryFolder } from "./model";
import { navigate } from "./router";
import { Avatar, PhoneRow, RowIcon, RowSection } from "./rows";
import { Button } from "../components";
import { BackButton, Scroll, TopBar } from "./ui";

/**
 * The last ten memory commits and the diff of the one opened. Diffs are fetched once per sha and kept;
 * tapping the open commit closes it.
 */
function useMemoryLog(api: PhoneAgentsApi, agentId: string) {
  const [commits, setCommits] = useState<MemoryCommit[] | null>(null);
  const [openSha, setOpenSha] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, string | null>>({});
  useEffect(() => {
    let live = true;
    void api.log(agentId, undefined, 10).then((c) => live && setCommits(c));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);
  const showDiff = (sha: string) => {
    if (openSha === sha) return setOpenSha(null);
    setOpenSha(sha);
    if (!(sha in diffs)) void api.diff(agentId, sha).then((t) => setDiffs((x) => ({ ...x, [sha]: t })));
  };
  return { commits, openSha, diffs, showDiff };
}

/** Which memory folders are folded, per agent, for the session: a file opened and Back finds the tree as it was left. */
const foldedByAgent = new Map<string, Record<string, boolean>>();

/** Opens the agent's main chat, with `prefill` started in the reply box when given. */
const mainChat = (agentId: string, prefill: string | null = null) => navigate({ kind: "conversation", agentId, conversationId: "default", prefill });

/**
 * One agent, Slack's profile page: the big face, the name, what it is and runs on, a Message button for
 * its main chat; then its sections — the live conversations (each opens its desk), its memory as folders
 * that fold, its skills (its own, then installed ones), and what it learned recently (the last ten memory
 * commits, each opening its diff). A file or skill row opens the file on its own page. Read-only, as before.
 */
export function AgentPage({ agentId, name, desks, items, api, banner, backLabel = "agents", onBack }: { agentId: string; name: string | null; desks: DeskSummary[]; items: AttentionItem[]; api: PhoneAgentsApi; banner?: ReactNode; backLabel?: string; onBack: () => void }) {
  const d = useAgentDetails(api, agentId);
  const log = useMemoryLog(api, agentId);
  const [folded, setFoldedState] = useState<Record<string, boolean>>(() => foldedByAgent.get(agentId) ?? {});
  const setFolded = (name: string, closed: boolean) =>
    setFoldedState((x) => {
      const next = { ...x, [name]: closed };
      foldedByAgent.set(agentId, next);
      return next;
    });
  const folders = useMemo(() => memoryFolders(d?.files ?? []), [d]);
  const title = d?.agent.name ?? name ?? "Agent";
  const openFile = (path: string) => navigate({ kind: "file", agentId, path });
  const running = items.some((i) => i.agentId === agentId && i.status === "running");

  return (
    <div className="loki-phone-page">
      <TopBar left={<BackButton onClick={onBack} label={backLabel} />} title={title} />
      {banner}
      <Scroll memory={`agent:${agentId}`} flush>
        <Hero agentId={agentId} name={title} details={d} desks={desks} running={running} />
        <Conversations agentId={agentId} desks={desks} items={items} />
        {d === undefined && <p className="loki-phone-empty">Reading the agent…</p>}
        {d === null && <p className="loki-phone-empty">This agent has no local record on the Mac (a remote or hidden agent), so its memory and skills are not readable here. Its conversations still work.</p>}
        {d && (
          <>
            <MemoryTree folders={folders} folded={folded} onFold={setFolded} onOpen={openFile} />
            {/* Two lists, as on the desktop: the agent's own skills, then the ones installed from elsewhere. Read-only here; refresh is a desktop action. */}
            {(["self", "other"] as const).map((origin) => (
              <Skills key={origin} origin={origin} skills={d.skills} onOpen={openFile} />
            ))}
            <Changes log={log} />
          </>
        )}
      </Scroll>
    </div>
  );
}

/** The top of the profile: face with presence, name, description, the model line, live desks and the main chat's mode. */
function Hero({ agentId, name, details: d, desks, running }: { agentId: string; name: string; details: AgentDetails | null | undefined; desks: DeskSummary[]; running: boolean }) {
  const live = liveDeskCount(desks, agentId);
  const main = desks.find((x) => x.agentId === agentId && x.conversationId === "default");
  const bits = d ? modelBits(d.agent.model, d.agent.modelSettings ?? {}) : [];
  return (
    <section className="loki-phone-hero" aria-label={`${name}'s profile`}>
      <Avatar name={name} src={avatarUrl(agentId)} size={72} presence={running} />
      <div className="loki-phone-hero-name">{name}</div>
      <div className="loki-phone-hero-state">
        {running ? "Working now" : "Idle"} · {liveDesksLabel(live)}
        {main?.mode ? ` · main chat ${main.mode}` : ""}
      </div>
      {d?.agent.description && <p className="loki-phone-hero-about">{d.agent.description}</p>}
      {d && <div className="loki-phone-meta">{bits.join(" · ") || "The harness default model"}</div>}
      {d?.lastCommit && <div className="loki-phone-meta">Memory changed {lastSeen(d.lastCommit.at)}</div>}
      <div className="loki-phone-hero-actions">
        <Button size="touch" tone="paper" onClick={() => mainChat(agentId)}>
          <Icon name="compose" size={18} />
          Message
        </Button>
      </div>
    </section>
  );
}

/** The agent's live desks, the way Home draws them, each opening its conversation. */
function Conversations({ agentId, desks, items }: { agentId: string; desks: DeskSummary[]; items: AttentionItem[] }) {
  const mine = desks.filter((x) => x.agentId === agentId && x.status === "live" && x.conversationId);
  const marks = new Map(items.filter((i) => i.agentId === agentId).map((i) => [i.id, i]));
  return (
    <RowSection icon="desk" title="Conversations" count={mine.length}>
      <ul className="loki-phone-list" aria-label="conversations">
        {mine.map((x) => (
          <DeskRow key={x.scope} desk={x} mark={marks.get(x.conversationId!)} onActions={null} />
        ))}
      </ul>
      {mine.length === 0 && <p className="loki-phone-empty">No live desks. Message opens its main chat.</p>}
    </RowSection>
  );
}

/** The memory files by folder: a folder's head folds its files; the root's files come last, with no head. */
function MemoryTree({ folders, folded, onFold, onOpen }: { folders: MemoryFolder[]; folded: Record<string, boolean>; onFold: (name: string, closed: boolean) => void; onOpen: (path: string) => void }) {
  return (
    <RowSection icon="folder" title="Memory" count={folders.reduce((n, f) => n + f.files.length, 0)}>
      {folders.map((f) => {
        const closed = folded[f.name] === true;
        return (
          <div key={f.name || "root"}>
            {f.name && (
              <button type="button" className="loki-phone-subhead" aria-expanded={!closed} onClick={() => onFold(f.name, !closed)}>
                <Icon name="chevron-down" size={16} className={closed ? "loki-phone-section-chev loki-phone-section-chev--folded" : "loki-phone-section-chev"} />
                <span className="loki-phone-ellipsis">{f.name}</span>
                <span className="loki-phone-section-count">{f.files.length}</span>
              </button>
            )}
            {!closed && (
              <ul className="loki-phone-list" aria-label={f.name || "memory"}>
                {f.files.map((x) => (
                  <PhoneRow key={x.path} lead={<RowIcon name="file" />} title={x.name} time={ago(x.modifiedAt)} label={`${x.path}, changed ${ago(x.modifiedAt)}`} launch={`file:${x.path}`} onOpen={() => onOpen(x.path)} />
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {folders.length === 0 && <p className="loki-phone-empty">No memory files.</p>}
    </RowSection>
  );
}

/** One skills list: the agent's own ("self"), or the ones installed from elsewhere — that section is left out when empty. */
function Skills({ origin, skills, onOpen }: { origin: "self" | "other"; skills: AgentDetails["skills"]; onOpen: (path: string) => void }) {
  const list = skills.filter((s) => (s.origin ?? "self") === origin);
  if (origin === "other" && list.length === 0) return null;
  return (
    <RowSection icon="skill" title={origin === "self" ? "Skills" : "Installed skills"} count={list.length}>
      <ul className="loki-phone-list" aria-label={origin === "self" ? "skills" : "installed skills"}>
        {list.map((s) => (
          <PhoneRow key={s.name} lead={<RowIcon name="skill" />} title={s.name} preview={s.description || null} launch={`file:${s.path}`} onOpen={() => onOpen(s.path)} />
        ))}
      </ul>
      {list.length === 0 && <p className="loki-phone-empty">None in memory.</p>}
    </RowSection>
  );
}

/** The last memory commits, each a row that opens onto its diff. */
function Changes({ log }: { log: ReturnType<typeof useMemoryLog> }) {
  const { commits, openSha, diffs, showDiff } = log;
  return (
    <RowSection icon="history" title="Changes" count={commits?.length ?? null}>
      {commits === null && <p className="loki-phone-empty">Reading the log…</p>}
      {commits?.length === 0 && <p className="loki-phone-empty">No memory commits yet.</p>}
      <ul className="loki-phone-list" aria-label="changes">
        {(commits ?? []).map((c) => {
          const open = openSha === c.sha;
          return (
            <li key={c.sha} className="loki-phone-change" data-open={open || undefined}>
              <button type="button" className="loki-phone-row loki-phone-change-row" aria-expanded={open} onClick={() => showDiff(c.sha)}>
                <RowIcon name="history" />
                <span className="loki-phone-row-copy">
                  <span className="loki-phone-change-message">{c.message}</span>
                  <span className="loki-phone-row-preview">{c.files.length === 1 ? c.files[0] : `${c.files.length} files`}</span>
                </span>
                <span className="loki-phone-row-time">{ago(c.at)}</span>
              </button>
              {open && (
                <div className="loki-phone-diff">
                  {!(c.sha in diffs) && <p className="loki-phone-meta">Reading the diff…</p>}
                  {diffs[c.sha] === null && <p className="loki-phone-meta">Nothing to show.</p>}
                  {diffs[c.sha] && <Diff text={diffs[c.sha]!} />}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </RowSection>
  );
}

/**
 * One memory file. Markdown renders the way the desktop viewer draws it; anything else is shown as code.
 * The only action is to hand the change to the agent: the button opens its main chat with the request started.
 */
export function FilePage({ agentId, path, name, api, banner, onBack }: { agentId: string; path: string; name: string | null; api: PhoneAgentsApi; banner?: ReactNode; onBack: () => void }) {
  const d = useAgentDetails(api, agentId);
  const [content, setContent] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setContent(undefined);
    void api.read(agentId, path).then((c) => live && setContent(c));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, path]);
  const agentName = d?.agent.name ?? name ?? "the agent";
  const markdown = /\.(md|markdown)$/i.test(path);
  const file = path.split("/").pop() ?? path;
  const dir = path.slice(0, Math.max(0, path.length - file.length - 1));
  return (
    <div className="loki-phone-page">
      <TopBar left={<BackButton onClick={onBack} label={agentName} />} title={file} sub={dir ? <span>{dir}/</span> : undefined} />
      {banner}
      <Scroll>
        <div className="loki-phone-file">
          {content === undefined && <p className="loki-phone-meta">Reading…</p>}
          {content === null && <p className="loki-phone-meta">Nothing to show here (binary, too large, or gone).</p>}
          {typeof content === "string" && markdown && (
            <div className="loki-phone-md loki-phone-body">
              <Markdown remarkPlugins={[remarkGfm]}>{stripFrontmatter(content)}</Markdown>
            </div>
          )}
          {typeof content === "string" && !markdown && <pre className="loki-phone-file-code">{content}</pre>}
        </div>
      </Scroll>
      <div className="loki-phone-file-bar">
        <Button size="touch" tone="brass" block onClick={() => mainChat(agentId, `Please update ${path}: `)} title="Opens the agent's main chat with the request started">
          Ask {agentName} to update this
        </Button>
      </div>
    </div>
  );
}
