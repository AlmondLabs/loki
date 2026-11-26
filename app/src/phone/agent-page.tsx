import { useEffect, useEffectEvent, useMemo, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MARKDOWN_COMPONENTS } from "../chat/markdown-image";
import type { AttentionItem } from "../../../core/attention/model.ts";

import type { AgentDetails } from "../agents/agents";
import { Diff } from "../agents/changes-page";
import { ago } from "../shared/ago";
import { READING, answered, valueOf, type Fetched } from "../shared/fetched";
import { avatarUrl } from "../workspace/env";

import { useAgentDetails, type PhoneAgentsApi } from "./agents";
import { DeskRow } from "./home";
import { Icon } from "./icons";
import { lastSeen, liveDeskCount, liveDesksLabel, memoryFolders, modelBits, stripFrontmatter, type MemoryFolder } from "./model";
import { navigate } from "./router";
import { Avatar, PhoneRow, RowIcon, RowSection } from "./rows";
import { Button } from "../components";
import { BackButton, Scroll, TopBar } from "./ui";
import type { ChatSummary, MemoryCommit } from "../../../core/frame-types.ts";
import { isMainChat, MAIN_CHAT_ID } from "../../../core/canvas-core.ts";

function useMemoryLog(api: PhoneAgentsApi, agentId: string) {
  const [commits, setCommits] = useState<MemoryCommit[] | null>(null);
  const [openSha, setOpenSha] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, string | null>>({});
  const readLog = useEffectEvent((id: string) => api.log(id, undefined, 10));
  useEffect(() => {
    let live = true;
    void readLog(agentId).then((c) => live && setCommits(c));
    return () => {
      live = false;
    };
  }, [agentId]);
  const showDiff = (sha: string) => {
    if (openSha === sha) return setOpenSha(null);
    setOpenSha(sha);
    if (!(sha in diffs)) void api.diff(agentId, sha).then((t) => setDiffs((x) => ({ ...x, [sha]: t })));
  };
  return { commits, openSha, diffs, showDiff };
}

const foldedByAgent = new Map<string, Record<string, boolean>>();

const mainChat = (agentId: string, prefill: string | null = null) => navigate({ kind: "conversation", agentId, conversationId: MAIN_CHAT_ID, prefill });

export function AgentPage({
  agentId,
  name,
  desks,
  items,
  api,
  banner,
  backLabel = "agents",
  onBack,
}: {
  agentId: string;
  name: string | null;
  desks: ChatSummary[];
  items: AttentionItem[];
  api: PhoneAgentsApi;
  banner?: ReactNode;
  backLabel?: string;
  onBack: () => void;
}) {
  const fetched = useAgentDetails(api, agentId);
  const d = valueOf(fetched);
  const log = useMemoryLog(api, agentId);
  const [folded, setFoldedState] = useState<Record<string, boolean>>(() => foldedByAgent.get(agentId) ?? {});
  // Outside (React): an updater may run twice, so the fold is kept outside it.
  const setFolded = (name: string, closed: boolean) => {
    const next = { ...folded, [name]: closed };
    foldedByAgent.set(agentId, next);
    setFoldedState(next);
  };
  const folders = useMemo(() => memoryFolders(d?.files ?? []), [d]);
  const title = d?.agent.name ?? name ?? "Agent";
  const openFile = (path: string) => navigate({ kind: "file", agentId, path });
  const running = items.some((i) => i.agent_id === agentId && i.status === "running");

  return (
    <div className="loki-phone-page">
      <TopBar left={<BackButton onClick={onBack} label={backLabel} />} title={title} banner={banner} />
      <Scroll memory={`agent:${agentId}`} flush>
        <Hero agentId={agentId} name={title} details={d} desks={desks} running={running} />
        <Conversations agentId={agentId} desks={desks} items={items} />
        {fetched.kind === "reading" && <p className="loki-phone-empty">Reading the agent…</p>}
        {fetched.kind === "unanswered" && (
          <p className="loki-phone-empty">
            This agent has no local record on the Mac (a remote or hidden agent), so its memory and skills are not readable here. Its conversations still work.
          </p>
        )}
        {d && (
          <>
            <MemoryTree folders={folders} folded={folded} onFold={setFolded} onOpen={openFile} />
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

function Hero({
  agentId,
  name,
  details: d,
  desks,
  running,
}: {
  agentId: string;
  name: string;
  details: AgentDetails | null;
  desks: ChatSummary[];
  running: boolean;
}) {
  const live = liveDeskCount(desks, agentId);
  const main = desks.find((x) => x.agent_id === agentId && isMainChat(x.conversation_id));
  const bits = d ? modelBits(d.agent.model, d.agent.model_settings) : [];
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

function Conversations({ agentId, desks, items }: { agentId: string; desks: ChatSummary[]; items: AttentionItem[] }) {
  const mine = desks.filter((x) => x.agent_id === agentId && x.status === "live" && x.conversation_id);
  const marks = new Map(items.filter((i) => i.agent_id === agentId).map((i) => [i.id, i]));
  return (
    <RowSection icon="desk" title="Conversations" count={mine.length}>
      <ul className="loki-phone-list" aria-label="Conversations">
        {mine.map((x) => (
          <DeskRow key={x.scope} desk={x} mark={x.conversation_id ? marks.get(x.conversation_id) : undefined} onActions={null} />
        ))}
      </ul>
      {mine.length === 0 && <p className="loki-phone-empty">No live chats. Message opens its main chat.</p>}
    </RowSection>
  );
}

function MemoryTree({
  folders,
  folded,
  onFold,
  onOpen,
}: {
  folders: MemoryFolder[];
  folded: Record<string, boolean>;
  onFold: (name: string, closed: boolean) => void;
  onOpen: (path: string) => void;
}) {
  return (
    <RowSection icon="folder" title="Memory" count={folders.reduce((n, f) => n + f.files.length, 0)}>
      {folders.map((f) => {
        const closed = folded[f.name];
        return (
          <div key={f.name || "root"}>
            {f.name && (
              <button type="button" className="loki-phone-subhead" aria-expanded={!closed} onClick={() => onFold(f.name, !closed)}>
                <Icon
                  name="chevron-down"
                  size={16}
                  className={closed ? "loki-phone-section-chev loki-phone-section-chev--folded" : "loki-phone-section-chev"}
                />
                <span className="loki-phone-ellipsis">{f.name}</span>
                <span className="loki-phone-section-count">{f.files.length}</span>
              </button>
            )}
            {!closed && (
              <ul className="loki-phone-list" aria-label={f.name || "memory"}>
                {f.files.map((x) => (
                  <PhoneRow
                    key={x.path}
                    lead={<RowIcon name="file" />}
                    title={x.name}
                    time={ago(x.modifiedAt)}
                    label={`${x.path}, changed ${ago(x.modifiedAt)}`}
                    launch={`file:${x.path}`}
                    onOpen={() => onOpen(x.path)}
                  />
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

function Skills({ origin, skills, onOpen }: { origin: "self" | "other"; skills: AgentDetails["skills"]; onOpen: (path: string) => void }) {
  const list = skills.filter((s) => (s.origin ?? "self") === origin);
  if (origin === "other" && list.length === 0) return null;
  return (
    <RowSection icon="skill" title={origin === "self" ? "Skills" : "Installed skills"} count={list.length}>
      <ul className="loki-phone-list" aria-label={origin === "self" ? "Skills" : "Installed skills"}>
        {list.map((s) => (
          <PhoneRow
            key={s.name}
            lead={<RowIcon name="skill" />}
            title={s.name}
            preview={s.description || null}
            launch={`file:${s.path}`}
            onOpen={() => onOpen(s.path)}
          />
        ))}
      </ul>
      {list.length === 0 && <p className="loki-phone-empty">None in memory.</p>}
    </RowSection>
  );
}

function Changes({ log }: { log: ReturnType<typeof useMemoryLog> }) {
  const { commits, openSha, diffs, showDiff } = log;
  return (
    <RowSection icon="history" title="Changes" count={commits?.length ?? null}>
      {commits === null && <p className="loki-phone-empty">Reading the log…</p>}
      {commits?.length === 0 && <p className="loki-phone-empty">No memory commits yet.</p>}
      <ul className="loki-phone-list" aria-label="Changes">
        {(commits ?? []).map((c) => {
          const open = openSha === c.sha;
          const diff = diffs[c.sha];
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
                  {diff === null && <p className="loki-phone-meta">Nothing to show.</p>}
                  {diff && <Diff text={diff} />}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </RowSection>
  );
}

const SHIFTED_HEADINGS = { ...MARKDOWN_COMPONENTS, h1: "h2", h2: "h3", h3: "h4", h4: "h5", h5: "h6" } as const;

export function FilePage({
  agentId,
  path,
  name,
  api,
  banner,
  onBack,
}: {
  agentId: string;
  path: string;
  name: string | null;
  api: PhoneAgentsApi;
  banner?: ReactNode;
  onBack: () => void;
}) {
  const d = valueOf(useAgentDetails(api, agentId));
  const [content, setContent] = useState<Fetched<string>>(READING);
  const [shownFile, setShownFile] = useState({ agentId, path });
  if (shownFile.agentId !== agentId || shownFile.path !== path) {
    setShownFile({ agentId, path });
    setContent(READING);
  }
  const readFile = useEffectEvent((id: string, file: string) => api.read(id, file));
  useEffect(() => {
    let live = true;
    void readFile(agentId, path).then((c) => live && setContent(answered(c)));
    return () => {
      live = false;
    };
  }, [agentId, path]);
  const agentName = d?.agent.name ?? name ?? "the agent";
  const markdown = /\.(md|markdown)$/i.test(path);
  const file = path.split("/").pop() ?? path;
  const dir = path.slice(0, Math.max(0, path.length - file.length - 1));
  return (
    <div className="loki-phone-page">
      <TopBar left={<BackButton onClick={onBack} label={agentName} />} title={file} sub={dir ? <span>{dir}/</span> : undefined} banner={banner} />
      <Scroll>
        <div className="loki-phone-file">
          {content.kind === "reading" && <p className="loki-phone-meta">Reading…</p>}
          {content.kind === "unanswered" && <p className="loki-phone-meta">Nothing to show here (binary, too large, or gone).</p>}
          {content.kind === "read" && markdown && (
            <div className="loki-phone-md loki-phone-body">
              <Markdown remarkPlugins={[remarkGfm]} components={SHIFTED_HEADINGS}>
                {stripFrontmatter(content.value)}
              </Markdown>
            </div>
          )}
          {content.kind === "read" && !markdown && <pre className="loki-phone-file-code">{content.value}</pre>}
        </div>
      </Scroll>
      <div className="loki-phone-file-bar">
        <Button
          size="touch"
          tone="brass"
          block
          onClick={() => mainChat(agentId, `Please update ${path}: `)}
          title="Opens the agent's main chat with the request started"
        >
          Ask {agentName} to update this
        </Button>
      </div>
    </div>
  );
}
