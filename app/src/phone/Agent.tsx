import { useEffect, useMemo, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MemoryCommit } from "../../../mod/agents.ts";
import { Diff } from "../agents/Agents";
import { ago } from "../board/model";
import { AgentFace } from "../desk/AgentChip";
import { avatarUrl } from "../desk/env";
import type { DeskSummary } from "../desk/useDesk";
import { Chevron, useAgentDetails, type PhoneAgentsApi } from "./Agents";
import { lastSeen, liveDeskCount, liveDesksLabel, memoryFolders, stripFrontmatter } from "./model";
import { navigate, type Route } from "./router";
import { BackButton, GUTTER, Heading, Meta, Scroll, TopBar, tap } from "./ui";

/**
 * One agent, read-only: who it is (face, name, description, model, the main chat's permission mode),
 * its memory as a tree of folders that fold, its skills, and what it learned recently — the last ten
 * memory commits, each opening its diff. A file row opens the file on its own page.
 */
export function AgentPage({ agentId, name, desks, api, banner, onBack }: { agentId: string; name: string | null; desks: DeskSummary[]; api: PhoneAgentsApi; banner?: ReactNode; onBack: () => void }) {
  const d = useAgentDetails(api, agentId);
  const [commits, setCommits] = useState<MemoryCommit[] | null>(null);
  const [openSha, setOpenSha] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, string | null>>({});
  const [folded, setFolded] = useState<Record<string, boolean>>({});
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
  const folders = useMemo(() => memoryFolders(d?.files ?? []), [d]);
  const live = liveDeskCount(desks, agentId);
  const main = desks.find((x) => x.agentId === agentId && x.conversationId === "default");
  const settings = d?.agent.modelSettings ?? {};
  const bits = [d?.agent.model ?? null, settings.effort ? `effort ${String(settings.effort)}` : null, settings.thinking ? "thinking" : null, settings.context_window_limit ? `${Math.round(Number(settings.context_window_limit) / 1000)}k context` : null].filter(Boolean) as string[];
  const title = d?.agent.name ?? name ?? "agent";
  const file = (path: string): Route => ({ kind: "file", agentId, path });

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <TopBar left={<BackButton onClick={onBack} label="agents" />} title={title} sub={d?.lastCommit ? <span>last change {lastSeen(d.lastCommit.at)}</span> : undefined} />
      {banner}
      <Scroll style={{ display: "grid", gap: 24, alignContent: "start", padding: `18px ${GUTTER.right} 32px ${GUTTER.left}` }}>
        {d === undefined && <div style={{ fontSize: 13.5, color: "var(--loki-muted)" }}>reading the agent…</div>}
        {d === null && <div style={{ fontSize: 13.5, color: "var(--loki-muted)", lineHeight: 1.5 }}>This agent has no local record on the Mac (a remote or hidden agent). Its chats still work from Home.</div>}
        {d && (
          <>
            <section style={{ display: "grid", gridTemplateColumns: "48px 1fr", gap: 14, alignItems: "start" }}>
              <AgentFace name={d.agent.name} src={avatarUrl(agentId)} size={48} />
              <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
                <div style={{ fontFamily: "var(--loki-display)", fontSize: 17, color: "var(--loki-fg)" }}>{d.agent.name}</div>
                {d.agent.description && <div style={{ fontSize: 13.5, lineHeight: 1.45, color: "var(--loki-muted)" }}>{d.agent.description}</div>}
                <Meta style={{ whiteSpace: "normal", marginTop: 2, lineHeight: 1.6 }}>{bits.join(" · ") || "the harness default model"}</Meta>
                <Meta style={{ whiteSpace: "normal" }}>
                  {liveDesksLabel(live)}
                  {main?.mode ? ` · main chat ${main.mode}` : ""}
                </Meta>
              </div>
            </section>

            <section>
              <Heading aside={`${folders.reduce((n, f) => n + f.files.length, 0)}`}>memory</Heading>
              <div style={{ display: "grid", gap: 2 }}>
                {folders.map((f) => {
                  const closed = folded[f.name] === true;
                  return (
                    <div key={f.name || "root"}>
                      {f.name && (
                        <button type="button" onClick={() => setFolded((x) => ({ ...x, [f.name]: !closed }))} aria-expanded={!closed} className="loki-label" style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", minHeight: 36, padding: "4px 4px", border: "none", background: "transparent", color: "var(--loki-muted)", cursor: "pointer", fontSize: 9.5, textAlign: "left", WebkitTapHighlightColor: "transparent" }}>
                          <span aria-hidden style={{ display: "inline-block", transform: closed ? "none" : "rotate(90deg)", transition: "transform 120ms" }}>▸</span>
                          {f.name}
                          <span style={{ marginLeft: "auto", fontFamily: "var(--loki-mono)", letterSpacing: "0.06em", textTransform: "none" }}>{f.files.length}</span>
                        </button>
                      )}
                      {!closed &&
                        f.files.map((x) => (
                          <button key={x.path} type="button" onClick={() => navigate(file(x.path))} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", minHeight: 44, padding: `6px 4px 6px ${f.name ? 22 : 4}px`, border: "none", borderRadius: 8, background: "transparent", color: "var(--loki-fg)", cursor: "pointer", textAlign: "left", WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}>
                            <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontFamily: "var(--loki-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.name}</span>
                            <Meta>{ago(x.modifiedAt)}</Meta>
                            <Chevron />
                          </button>
                        ))}
                    </div>
                  );
                })}
                {folders.length === 0 && <div style={{ fontSize: 12, color: "var(--loki-muted)", padding: "0 4px" }}>no memory files</div>}
              </div>
            </section>

            {/* Two lists, as on the desktop: the agent's own skills, then the ones installed from elsewhere. Read-only here; refresh is a desktop action. */}
            {(["self", "other"] as const).map((origin) => {
              const list = d.skills.filter((s) => (s.origin ?? "self") === origin);
              if (origin === "other" && list.length === 0) return null;
              return (
                <section key={origin}>
                  <Heading aside={list.length ? String(list.length) : undefined}>{origin === "self" ? "skills · self" : "skills · other"}</Heading>
                  {list.length === 0 && <div style={{ fontSize: 12, color: "var(--loki-muted)", padding: "0 4px" }}>none in memory</div>}
                  <div style={{ display: "grid", gap: 2 }}>
                    {list.map((s) => (
                      <button key={s.name} type="button" onClick={() => navigate(file(s.path))} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", minHeight: 44, padding: "8px 4px", border: "none", borderRadius: 8, background: "transparent", color: "var(--loki-fg)", cursor: "pointer", textAlign: "left", WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}>
                        <span style={{ flex: 1, minWidth: 0, display: "grid", gap: 2 }}>
                          <span style={{ fontSize: 13.5, fontFamily: "var(--loki-mono)" }}>{s.name}</span>
                          {s.description && <span style={{ fontSize: 12, color: "var(--loki-muted)", lineHeight: 1.4 }}>{s.description}</span>}
                        </span>
                        <Chevron />
                      </button>
                    ))}
                  </div>
                </section>
              );
            })}

            <section>
              <Heading>learned recently</Heading>
              {commits === null && <div style={{ fontSize: 12, color: "var(--loki-muted)", padding: "0 4px" }}>reading the log…</div>}
              {commits?.length === 0 && <div style={{ fontSize: 12, color: "var(--loki-muted)", padding: "0 4px" }}>no memory commits yet</div>}
              <div style={{ display: "grid", gap: 2 }}>
                {(commits ?? []).map((c) => {
                  const open = openSha === c.sha;
                  return (
                    <div key={c.sha} style={{ borderRadius: 8, background: open ? "var(--loki-panel)" : "transparent", border: `1px solid ${open ? "var(--loki-border)" : "transparent"}` }}>
                      <button type="button" onClick={() => showDiff(c.sha)} aria-expanded={open} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "2px 10px", width: "100%", minHeight: 44, padding: "8px 8px", border: "none", background: "transparent", color: "var(--loki-fg)", cursor: "pointer", textAlign: "left", WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}>
                        <span style={{ fontSize: 13.5, lineHeight: 1.4, overflowWrap: "anywhere" }}>{c.message}</span>
                        <Meta style={{ alignSelf: "start", paddingTop: 3 }}>{lastSeen(c.at)}</Meta>
                        <Meta style={{ gridColumn: "1 / -1" }}>{c.files.length === 1 ? c.files[0] : `${c.files.length} files`}</Meta>
                      </button>
                      {open && (
                        <div style={{ padding: "0 8px 10px", maxHeight: 360, overflow: "auto", WebkitOverflowScrolling: "touch" }}>
                          {!(c.sha in diffs) && <div style={{ fontSize: 12, color: "var(--loki-muted)" }}>reading the diff…</div>}
                          {diffs[c.sha] === null && <div style={{ fontSize: 12, color: "var(--loki-muted)" }}>nothing to show</div>}
                          {diffs[c.sha] && <Diff text={diffs[c.sha]!} />}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          </>
        )}
      </Scroll>
    </div>
  );
}

/**
 * One memory file. Markdown renders the way the desktop viewer draws it; anything else is mono. The
 * only action is to hand the change to the agent: the brass-outlined button opens its main chat with
 * the request started.
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
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <TopBar left={<BackButton onClick={onBack} label={agentName} />} title={file} sub={dir ? <span>{dir}/</span> : undefined} />
      {banner}
      <Scroll style={{ padding: `14px ${GUTTER.right} 32px ${GUTTER.left}` }}>
        {content === undefined && <div style={{ fontSize: 12, color: "var(--loki-muted)" }}>reading…</div>}
        {content === null && <div style={{ fontSize: 12, color: "var(--loki-muted)" }}>nothing to show here (binary, too large, or gone)</div>}
        {typeof content === "string" && markdown && (
          <div className="loki-phone-md" style={{ fontSize: 15, lineHeight: 1.6, color: "var(--loki-fg)", overflowWrap: "anywhere" }}>
            <Markdown remarkPlugins={[remarkGfm]}>{stripFrontmatter(content)}</Markdown>
          </div>
        )}
        {typeof content === "string" && !markdown && <pre style={{ margin: 0, fontFamily: "var(--loki-mono)", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "var(--loki-fg)" }}>{content}</pre>}
      </Scroll>
      <div style={{ flex: "0 0 auto", padding: `10px ${GUTTER.right} calc(10px + env(safe-area-inset-bottom, 0px)) ${GUTTER.left}`, borderTop: "1px solid var(--loki-border)", background: "var(--loki-panel)" }}>
        <button type="button" onClick={() => navigate({ kind: "conversation", agentId, conversationId: "default", prefill: `Please update ${path}: ` })} style={{ ...tap("var(--loki-accent)"), width: "100%", minHeight: 44, borderColor: "var(--loki-accent)" }} title="opens the agent's main chat with the request started">
          ask {agentName} to update this
        </button>
      </div>
    </div>
  );
}
