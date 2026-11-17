import { useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Markdown from "react-markdown";
import { formatKeys } from "../shell/keymap";
import remarkGfm from "remark-gfm";
import type { Runtime } from "../../../core/attention/protocol.ts";
import type { ConversationInfo } from "../../../core/attention/model.ts";
import type { ChatFace } from "../../../core/attention/use-attention.ts";
import type { SuggestionOutcome } from "../../../core/attention/chat-store.ts";
import type { SuggestionAction } from "../../../core/frames.ts";
import type { Suggestion, SuggestionTarget } from "../../../core/frame-types.ts";
import { Button, Chip, Field, IconButton, Meta, Row, Sheet, sentence } from "../components";
import { Icon } from "../shared/icons";
import { MARKDOWN_COMPONENTS } from "./markdown-image";
import { buildSearchIndex, rankHits, type Indexed } from "../shared/search";
import { isMainChat } from "../../../core/desk-core.ts";

export interface SuggestionSource {
  conversation: (agentId: string, conversationId: string) => Pick<ChatFace, "suggestions" | "cwd">;
  items: readonly ConversationInfo[];
  agents: ReadonlyArray<{ id: string; name: string }>;
  listed: boolean;
  agentsLoaded: boolean;
  suggestions: {
    decide: (rt: Runtime, suggestionId: string, action: SuggestionAction) => Promise<SuggestionOutcome>;
    retarget: (rt: Runtime, suggestionId: string, target: SuggestionTarget) => Promise<SuggestionOutcome>;
  };
}

export interface SuggestionsProps {
  source: SuggestionSource;
  rt: Runtime;
  blocked?: string | null;
}

const REMARK_PLUGINS = [remarkGfm];

const isOpen = (s: Suggestion) => s.status === "pending" || s.status === "sending";

export function waitingCount(source: Pick<SuggestionSource, "conversation">, rt: Runtime): number {
  return source.conversation(rt.agent_id, rt.conversation_id).suggestions.filter(isOpen).length;
}

export type ChatTick = { id: string; n: number } | null;

export const bumpTick = (t: ChatTick, id: string): ChatTick => ({ id, n: (t?.id === id ? t.n : 0) + 1 });

export const tickOf = (t: ChatTick, id: string): number => (t?.id === id ? t.n : 0);

const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

function chatTitle(c: Pick<ConversationInfo, "id" | "title">, agentName: string): string {
  if (c.title) return c.title;
  return isMainChat(c.id) ? `${agentName}'s main chat` : "untitled chat";
}

export interface TargetView {
  name: string;
  gone: boolean;
}

const GONE = /is (gone|archived): pick another chat$/;

export function targetOf(source: Pick<SuggestionSource, "items" | "agents" | "listed" | "agentsLoaded">, s: Suggestion): TargetView {
  const t = s.target;
  const agent = source.agents.find((a) => a.id === t.agent_id);
  const agentGone = source.agentsLoaded && !agent;
  const said = GONE.test(s.reason ?? "");
  if (!("conversation_id" in t)) {
    const agentName = agent?.name ?? "an agent";
    return { name: `New chat with ${agentName} in ${folderName(t.folder)}`, gone: agentGone || said };
  }
  const chat = source.items.find((c) => c.agent_id === t.agent_id && c.id === t.conversation_id);
  const agentName = agent?.name ?? chat?.agent_name ?? "an agent";
  const name = chat ? `${chatTitle(chat, agentName)} · ${agentName}` : `a chat with ${agentName}`;
  return { name, gone: agentGone || (source.listed && !chat) || said };
}

export interface ChatChoice {
  key: string;
  title: string;
  line: string;
  agentId: string;
  conversationId?: string;
}

const RECENT = 5;
const MAX_HITS = 8;

export function chatChoices(source: Pick<SuggestionSource, "items" | "agents">, query: string, current: SuggestionTarget | null): ChatChoice[] {
  const agentNames = new Map(source.agents.map((a) => [a.id, a.name]));
  const isCurrent = (c: ConversationInfo) => !!current && "conversation_id" in current && current.agent_id === c.agent_id && current.conversation_id === c.id;
  const chats = source.items
    .filter((c) => !isCurrent(c))
    .map((c): Indexed<ChatChoice> => {
      const agentName = agentNames.get(c.agent_id) ?? c.agent_name ?? "agent";
      const title = chatTitle(c, agentName);
      const at = c.last_message_at ? Date.parse(c.last_message_at) : NaN;
      return {
        hit: { key: `chat:${c.agent_id}/${c.id}`, title, line: agentName, agentId: c.agent_id, conversationId: c.id },
        fields: [title, agentName],
        recency: Number.isFinite(at) ? at : 0,
      };
    });
  const agents = source.agents.map((a): Indexed<ChatChoice> => ({
    hit: { key: `agent:${a.id}`, title: `New chat with ${a.name}`, line: "", agentId: a.id },
    fields: [a.name],
    recency: 0,
  }));
  if (!query.trim()) {
    const latest = [...chats].sort((a, b) => b.recency - a.recency).slice(0, RECENT);
    return [...latest, ...agents].map((e) => e.hit);
  }
  return rankHits(buildSearchIndex([...chats, ...agents]), query).slice(0, MAX_HITS);
}

export interface Told {
  title: string;
  message: string;
}

export function afterAction(s: Suggestion, out: SuggestionOutcome): { note: string } | { told: Told } | null {
  if (out.done || !out.message) return null;
  if (out.suggestion && !isOpen(out.suggestion)) return { told: { title: s.title, message: out.message } };
  return { note: out.message };
}

export function busyWith(busy: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> {
  const next = new Set(busy);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

export function pickerKey(e: Pick<KeyboardEvent, "key" | "preventDefault" | "stopPropagation">, disabled: boolean, enter: () => void, escape: () => void) {
  e.stopPropagation();
  if (e.key === "Enter") {
    e.preventDefault();
    if (!disabled) enter();
  } else if (e.key === "Escape") {
    e.preventDefault();
    escape();
  }
}

export function chipText(count: number, touch: boolean): string {
  if (touch) return count ? String(count) : "";
  return count === 1 ? "1 suggestion" : count ? `${count} suggestions` : "suggestions";
}

export type SuggestionChipProps = SuggestionsProps & { touch?: boolean; tick?: number };

export function SuggestionChip({ source, rt, blocked = null, touch = false, tick = 0 }: SuggestionChipProps) {
  const face = source.conversation(rt.agent_id, rt.conversation_id);
  const list = face.suggestions.filter(isOpen).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const [open, setOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null | undefined>(undefined);
  const shownId = openId === undefined ? (list[0]?.id ?? null) : openId;
  const [notes, setNotes] = useState<Partial<Record<string, string>>>({});
  const [told, setTold] = useState<Partial<Record<string, Told>>>({});
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [seenTick, setSeenTick] = useState(0);
  if (tick !== seenTick) {
    setSeenTick(tick);
    if (tick > 0) setOpen(true);
  }
  const shownIds = new Set(list.map((s) => s.id));
  const settled = Object.entries(told).filter((e): e is [string, Told] => !!e[1] && !shownIds.has(e[0]));
  if (!list.length && !settled.length) return null;

  const outcome = (s: Suggestion, out: SuggestionOutcome) => {
    setBusy((b) => busyWith(b, s.id, false));
    const left = afterAction(s, out);
    if (!left) return;
    if ("told" in left) setTold((t) => ({ ...t, [s.id]: left.told }));
    else setNotes((n) => ({ ...n, [s.id]: left.note }));
  };
  const begin = (s: Suggestion) => {
    setBusy((b) => busyWith(b, s.id, true));
    setNotes((n) => ({ ...n, [s.id]: undefined }));
  };
  const decide = (s: Suggestion, action: SuggestionAction) => {
    begin(s);
    void source.suggestions.decide(rt, s.id, action).then((out) => outcome(s, out));
  };
  const retarget = (s: Suggestion, target: SuggestionTarget): Promise<boolean> => {
    begin(s);
    return source.suggestions.retarget(rt, s.id, target).then((out) => {
      outcome(s, out);
      return out.done;
    });
  };
  const folder = face.cwd ?? source.items.find((c) => c.agent_id === rt.agent_id && c.id === rt.conversation_id)?.cwd ?? null;
  const label = sentence(list.length ? chipText(list.length, false) : "suggestions");
  const shown = chipText(list.length, touch);

  return (
    <>
      <Chip
        className="loki-suggestion-chip"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title="Suggestions for other chats"
      >
        <Icon name="suggest" size={touch ? 18 : 14} />
        {shown && <span>{shown}</span>}
      </Chip>
      {open && (
        <SuggestionPanel touch={touch} count={list.length} onClose={() => setOpen(false)}>
          <div className="loki-suggestions" role="region" aria-label="Suggestions for other chats">
            {settled.map(([id, t]) => (
              <div key={id} className="loki-suggestion loki-suggestion-told" role="status">
                <span className="loki-suggestion-title">{t.title}</span>
                <span className="loki-suggestion-note">{t.message}</span>
                <Button size={touch ? "touch" : "sm"} bare onClick={() => setTold((all) => ({ ...all, [id]: undefined }))}>
                  Dismiss
                </Button>
              </div>
            ))}
            {list.map((s) => (
              <SuggestionCard
                key={s.id}
                suggestion={s}
                target={targetOf(source, s)}
                open={shownId === s.id}
                onToggle={() => setOpenId(shownId === s.id ? null : s.id)}
                note={notes[s.id] ?? null}
                busy={busy.has(s.id)}
                blocked={blocked}
                touch={touch}
                onDecide={(action) => decide(s, action)}
                picker={(close) => (
                  <ChatPicker
                    source={source}
                    suggestion={s}
                    folder={folder}
                    touch={touch}
                    disabled={!!blocked || busy.has(s.id)}
                    onPick={(target) => void retarget(s, target).then((done) => done && close())}
                    onCancel={close}
                  />
                )}
              />
            ))}
          </div>
        </SuggestionPanel>
      )}
    </>
  );
}

const stopEvent = (e: { stopPropagation: () => void }) => e.stopPropagation();

function SuggestionPanel({ touch, count, onClose, children }: { touch: boolean; count: number; onClose: () => void; children: ReactNode }) {
  const head = (
    <div className="loki-suggestion-modal-head">
      <span className="loki-suggestion-modal-title">Suggestions</span>
      {count > 0 && <Meta>{`${count} waiting`}</Meta>}
      <span className="flex-1" />
      <IconButton size={touch ? 36 : 28} label="Close" title={touch ? undefined : `Close (${formatKeys("escape")})`} onClick={onClose}>
        <Icon name="close" size={touch ? 20 : 16} />
      </IconButton>
    </div>
  );
  if (touch)
    // The Sheet draws itself at the phone shell's root; React still bubbles its events through the Inbox card, which
    // would take a drag in the sheet for a swipe of the card underneath.
    return (
      <div className="contents" onPointerDown={stopEvent} onPointerMove={stopEvent} onPointerUp={stopEvent} onPointerCancel={stopEvent}>
        <Sheet label="Suggestions" onClose={onClose} placement="bottom" className="loki-phone-sheet loki-suggestion-sheet">
          {head}
          {children}
        </Sheet>
      </div>
    );
  const sheet = (
    <Sheet label="Suggestions" onClose={onClose} width={720} top="8vh" className="loki-suggestion-modal">
      {head}
      {children}
    </Sheet>
  );
  return typeof document === "undefined" ? sheet : createPortal(sheet, document.body);
}

export interface SuggestionCardProps {
  suggestion: Suggestion;
  target: TargetView;
  open: boolean;
  onToggle: () => void;
  note: string | null;
  busy: boolean;
  blocked: string | null;
  touch: boolean;
  onDecide: (action: SuggestionAction) => void;
  picker: (close: () => void) => ReactNode;
}

export function SuggestionCard(props: SuggestionCardProps) {
  const [picking, setPicking] = useState(false);
  return <SuggestionCardView {...props} picking={picking} onPicking={setPicking} />;
}

export function SuggestionCardView({
  suggestion: s,
  target,
  open,
  onToggle,
  note,
  busy,
  blocked,
  touch,
  onDecide,
  picker,
  picking,
  onPicking,
}: SuggestionCardProps & { picking: boolean; onPicking: (picking: boolean) => void }) {
  const sending = s.status === "sending";
  const reason = note ?? s.reason ?? (target.gone ? "The chat this was for is gone or archived: pick another chat" : null);
  const off = busy || sending || !!blocked;
  return (
    <div className="loki-suggestion" data-suggestion={s.id} data-open={open || undefined}>
      <button type="button" className="loki-suggestion-head" aria-expanded={open} onClick={onToggle}>
        <span className="loki-suggestion-kicker">Suggests</span>
        <span className="loki-suggestion-title">{s.title}</span>
        <span className="loki-suggestion-target">→ {target.name}</span>
      </button>
      {open && (
        <div className="loki-suggestion-body">
          <div className="loki-suggestion-text loki-md">
            <Markdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
              {s.text}
            </Markdown>
          </div>
          <SuggestionNotes sending={sending} reason={reason} blocked={blocked} />
          {!sending && !picking && <SuggestionActions gone={target.gone} off={off} touch={touch} onDecide={onDecide} onPicking={onPicking} />}
          {!sending && picking && picker(() => onPicking(false))}
        </div>
      )}
    </div>
  );
}

function SuggestionNotes({ sending, reason, blocked }: { sending: boolean; reason: string | null; blocked: string | null }) {
  return (
    <>
      {sending && (
        <div className="loki-suggestion-note" role="status">
          Sending…
        </div>
      )}
      {!sending && reason && (
        <div className="loki-suggestion-note" data-refused role="alert">
          {reason}
        </div>
      )}
      {blocked && <div className="loki-suggestion-note">{blocked}</div>}
    </>
  );
}

function SuggestionActions({
  gone,
  off,
  touch,
  onDecide,
  onPicking,
}: {
  gone: boolean;
  off: boolean;
  touch: boolean;
  onDecide: (action: SuggestionAction) => void;
  onPicking: (picking: boolean) => void;
}) {
  const size = touch ? "touch" : "sm";
  return (
    <div className="loki-suggestion-actions">
      {!gone && (
        <>
          <Button size={size} tone="positive" disabled={off} onClick={() => onDecide("send")} data-action="send">
            Send Now
          </Button>
          <Button size={size} tone="paper" disabled={off} onClick={() => onDecide("draft")} data-action="draft">
            Save as Draft
          </Button>
        </>
      )}
      <Button size={size} tone={gone ? "brass" : "paper"} disabled={off} onClick={() => onPicking(true)} data-action="change">
        Change Chat…
      </Button>
      <Button size={size} tone="negative" disabled={off} onClick={() => onDecide("reject")} data-action="reject">
        Reject
      </Button>
    </div>
  );
}

function ChatPicker({
  source,
  suggestion,
  folder: sourceFolder,
  touch,
  disabled,
  onPick,
  onCancel,
}: {
  source: SuggestionSource;
  suggestion: Suggestion;
  folder: string | null;
  touch: boolean;
  disabled: boolean;
  onPick: (target: SuggestionTarget) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [agent, setAgent] = useState<{ id: string; title: string } | null>(null);
  const [folder, setFolder] = useState(sourceFolder ?? "");
  const choices = chatChoices(source, query, suggestion.target);
  const size = touch ? "touch" : "sm";
  const choose = (c: ChatChoice) => {
    if (c.conversationId) onPick({ agent_id: c.agentId, conversation_id: c.conversationId });
    else setAgent({ id: c.agentId, title: c.title });
  };
  const keys = (e: KeyboardEvent, enter: () => void, escape: () => void) => pickerKey(e, disabled, enter, escape);

  if (agent)
    return (
      <div className="loki-suggestion-picker">
        <div className="loki-suggestion-note">{agent.title}, in the folder</div>
        <Field
          size={size}
          mono
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          onKeyDown={(e) =>
            keys(
              e,
              () => folder.trim() && onPick({ agent_id: agent.id, folder: folder.trim() }),
              () => setAgent(null),
            )
          }
          aria-label="Folder for the new chat"
          autoComplete="off"
          autoFocus
        />
        <div className="loki-suggestion-actions">
          <Button size={size} tone="positive" disabled={disabled || !folder.trim()} onClick={() => onPick({ agent_id: agent.id, folder: folder.trim() })}>
            Choose
          </Button>
          <Button size={size} tone="paper" onClick={() => setAgent(null)}>
            Back
          </Button>
        </div>
      </div>
    );

  return (
    <div className="loki-suggestion-picker">
      <Field
        size={size}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => keys(e, () => choices[0] && choose(choices[0]), onCancel)}
        placeholder="Find a chat or an agent…"
        aria-label="Find a chat or an agent"
        autoComplete="off"
        autoFocus
      />
      <ul className="loki-suggestion-hits" aria-label="Chats and agents">
        {choices.map((c) => (
          <li key={c.key}>
            <Row dense={!touch} touch={touch} disabled={disabled} onClick={() => choose(c)} className="loki-suggestion-hit">
              <span className="loki-truncate">{c.title}</span>
              {c.line && <span className="loki-suggestion-hit-line">{c.line}</span>}
            </Row>
          </li>
        ))}
        {!choices.length && <li className="loki-suggestion-note">No chat or agent by that name</li>}
      </ul>
      <div className="loki-suggestion-actions">
        <Button size={size} tone="paper" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
