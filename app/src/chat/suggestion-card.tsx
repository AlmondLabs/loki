import { useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Markdown from "react-markdown";
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

/**
 * Suggestions in the chat screen (plan 049, U4): messages an agent in this chat suggests for another chat, never a
 * row in the thread. Since plan 052 they wait behind a chip in the message box, which opens them as cards, newest
 * first, one line each until opened; opened, a card shows the message and send now, save as draft, change chat and
 * reject. The Mac the chat lives on carries out every action; the card shows what it answered.
 */

/** What the cards read and call, all of it useAttention's (the shell's and the phone's `catchUp` fit as they are). */
export interface SuggestionSource {
  conversation: (agentId: string, conversationId: string) => Pick<ChatFace, "suggestions" | "cwd">;
  /** The chats the Inbox lists: the ones a suggestion can go to, and their names. */
  items: readonly ConversationInfo[];
  agents: ReadonlyArray<{ id: string; name: string }>;
  /** The chat list and the agent list have come: before that, a target missing from them is not yet known to be gone. */
  listed: boolean;
  agentsLoaded: boolean;
  suggestions: {
    decide: (rt: Runtime, suggestionId: string, action: SuggestionAction) => Promise<SuggestionOutcome>;
    retarget: (rt: Runtime, suggestionId: string, target: SuggestionTarget) => Promise<SuggestionOutcome>;
  };
}

/** A chat screen's suggestions, as a host hands them to Conversation: where they are read, and which chat they were made in. */
export interface SuggestionsProps {
  source: SuggestionSource;
  rt: Runtime;
  /** Why nothing can be done now (the phone while its Mac is out of reach): the buttons are disabled and this says why. */
  blocked?: string | null;
}

/** GitHub's markdown, as the transcript reads a reply: tables, task lists and strikethrough besides the basics. */
const REMARK_PLUGINS = [remarkGfm];

/** Waiting on the person, or being carried out: the ones the screen shows. */
const isOpen = (s: Suggestion) => s.status === "pending" || s.status === "sending";

/** How many suggestions made in a chat wait on the person: the count the chip and the Inbox card's mark show. */
export function waitingCount(source: Pick<SuggestionSource, "conversation">, rt: Runtime): number {
  return source.conversation(rt.agent_id, rt.conversation_id).suggestions.filter(isOpen).length;
}

/** A host's bump of one chat's suggestions (the Inbox's mark, /suggestions): which chat, and how many times. */
export type ChatTick = { id: string; n: number } | null;

/** The bump after one more for chat `id`; a bump for another chat starts again, so it never opens a later card. */
export const bumpTick = (t: ChatTick, id: string): ChatTick => ({ id, n: (t?.id === id ? t.n : 0) + 1 });

/** The tick a chat's Conversation gets: the bumps made for it, 0 for any other chat. */
export const tickOf = (t: ChatTick, id: string): number => (t?.id === id ? t.n : 0);

/** The words of a control: lowercase on the desktop, sentence case on the phone. */
const say = (touch: boolean, words: string) => (touch ? sentence(words) : words);

/** A folder's last part, as a target line names it. */
const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** A chat as the cards name it: its title, else the agent's main chat, else untitled. */
function chatTitle(c: Pick<ConversationInfo, "id" | "title">, agentName: string): string {
  if (c.title) return c.title;
  return c.id === "default" ? `${agentName}'s main chat` : "untitled chat";
}

/** Where a suggestion goes, as its card says it, and whether that chat can still take it (R16). */
export interface TargetView {
  name: string;
  /** The chat or agent it was for is gone or archived: the card asks for another chat instead of offering send. */
  gone: boolean;
}

/** The refusals that mean the target cannot take the suggestion at all, whatever is pressed (mod/suggestions.ts unfit). */
const GONE = /is (gone|archived): pick another chat$/;

/** A suggestion's target as the card shows it: its name, and whether it is gone (the agent, or the chat once the list came). */
export function targetOf(source: Pick<SuggestionSource, "items" | "agents" | "listed" | "agentsLoaded">, s: Suggestion, touch = false): TargetView {
  const t = s.target;
  const agent = source.agents.find((a) => a.id === t.agent_id);
  const agentGone = source.agentsLoaded && !agent;
  const said = GONE.test(s.reason ?? "");
  if (!("conversation_id" in t)) {
    const agentName = agent?.name ?? "an agent";
    return { name: `${say(touch, "new chat with")} ${agentName} in ${folderName(t.folder)}`, gone: agentGone || said };
  }
  const chat = source.items.find((c) => c.agent_id === t.agent_id && c.id === t.conversation_id);
  const agentName = agent?.name ?? chat?.agent_name ?? "an agent";
  const name = chat ? `${chatTitle(chat, agentName)} · ${agentName}` : `a chat with ${agentName}`;
  return { name, gone: agentGone || (source.listed && !chat) || said };
}

/** One choice in change chat: an existing chat, or a new chat with an agent. */
export interface ChatChoice {
  key: string;
  title: string;
  line: string;
  agentId: string;
  /** Absent for a new chat with the agent. */
  conversationId?: string;
}

/** Rows change chat shows with nothing typed, and at most with a query. */
const RECENT = 5;
const MAX_HITS = 8;

/**
 * Change chat's choices (R4): with nothing typed the latest chats and every agent; typed, the chats and agents that
 * match, ranked by the same matching the ⌘K and phone searches use (shared/search.ts). The chat the suggestion is
 * already for is left out.
 */
export function chatChoices(source: Pick<SuggestionSource, "items" | "agents">, query: string, current: SuggestionTarget | null, touch = false): ChatChoice[] {
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
    hit: { key: `agent:${a.id}`, title: `${say(touch, "new chat with")} ${a.name}`, line: "", agentId: a.id },
    fields: [a.name],
    recency: 0,
  }));
  if (!query.trim()) {
    const latest = [...chats].sort((a, b) => b.recency - a.recency).slice(0, RECENT);
    return [...latest, ...agents].map((e) => e.hit);
  }
  return rankHits(buildSearchIndex([...chats, ...agents]), query).slice(0, MAX_HITS);
}

/** A refusal told after its card has gone: the suggestion's title and what already happened to it. */
export interface Told {
  title: string;
  message: string;
}

/**
 * What a refused action leaves (R17): its reason on the card while the suggestion still waits; a line of its own
 * when the suggestion was already settled elsewhere and its card is going (AE6). Nothing for an action that took.
 */
export function afterAction(s: Suggestion, out: SuggestionOutcome): { note: string } | { told: Told } | null {
  if (out.done || !out.message) return null;
  if (out.suggestion && !isOpen(out.suggestion)) return { told: { title: s.title, message: out.message } };
  return { note: out.message };
}

/**
 * The suggestions with an action in flight, with one added or taken away. Each card's buttons wait on its own answer
 * only: one card's answer arriving never frees another whose request is still out.
 */
export function busyWith(busy: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> {
  const next = new Set(busy);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

/**
 * A key in one of change chat's fields: Enter chooses, Esc goes back, and neither reaches the Inbox's own keys. While
 * a change is in flight Enter does nothing, as the disabled rows and buttons do, so a second Enter sends no second
 * change; Esc still goes back, as cancel and back stay enabled.
 */
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

/** The chip's words: "3 suggestions" on the desktop; the phone's narrower row shows the icon and the count alone. */
export function chipText(count: number, touch: boolean): string {
  if (touch) return count ? String(count) : "";
  return count === 1 ? "1 suggestion" : count ? `${count} suggestions` : "suggestions";
}

/** The chip's props: a chat screen's suggestions, how it is drawn, and the host's tick that opens it (⌘⇧S, the Inbox's mark). */
export type SuggestionChipProps = SuggestionsProps & { touch?: boolean; tick?: number };

/**
 * A chat's suggestions behind a chip in the message box (plan 052): the chip shows only while some wait, and opens
 * the cards in a modal over the window on the desktop and a bottom sheet on the phone (plan 054). The
 * chip stays mounted with the chat, so a refused action's reason and a line told after its card has gone (AE6) keep
 * while the panel is closed; the chip stays for that line until it is dismissed. The last card decided closes it.
 */
export function SuggestionChip({ source, rt, blocked = null, touch = false, tick = 0 }: SuggestionChipProps) {
  const face = source.conversation(rt.agent_id, rt.conversation_id);
  const list = face.suggestions.filter(isOpen).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const [open, setOpen] = useState(false);
  // Which card is open: undefined until the person picks, and then the newest is, so the modal shows a message at once.
  const [openId, setOpenId] = useState<string | null | undefined>(undefined);
  const shownId = openId === undefined ? (list[0]?.id ?? null) : openId;
  const [notes, setNotes] = useState<Partial<Record<string, string>>>({});
  const [told, setTold] = useState<Partial<Record<string, Told>>>({});
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  // A bumped tick opens the panel from the render that sees it, as ⌘⇧M opens the model picker.
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
  const label = say(touch, list.length ? chipText(list.length, false) : "suggestions");
  const shown = chipText(list.length, touch);

  return (
    <>
      <Chip
        className="loki-suggestion-chip"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={say(touch, "suggestions for other chats")}
      >
        <Icon name="suggest" size={touch ? 18 : 14} />
        {shown && <span>{shown}</span>}
      </Chip>
      {open && (
        <SuggestionPanel touch={touch} count={list.length} onClose={() => setOpen(false)}>
          <div className="loki-suggestions" role="region" aria-label={say(touch, "suggestions for other chats")}>
            {settled.map(([id, t]) => (
              <div key={id} className="loki-suggestion loki-suggestion-told" role="status">
                <span className="loki-suggestion-title">{t.title}</span>
                <span className="loki-suggestion-note">{t.message}</span>
                <Button size={touch ? "touch" : "sm"} bare onClick={() => setTold((all) => ({ ...all, [id]: undefined }))}>
                  {say(touch, "dismiss")}
                </Button>
              </div>
            ))}
            {list.map((s) => (
              <SuggestionCard
                key={s.id}
                suggestion={s}
                target={targetOf(source, s, touch)}
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

/**
 * Where the chip's cards open (plan 054): a modal sheet centred over the window on the desktop, a bottom sheet on the
 * phone. The Sheet owns the veil, Escape, the Tab loop and handing focus back to what opened it. A header names it.
 */
function SuggestionPanel({ touch, count, onClose, children }: { touch: boolean; count: number; onClose: () => void; children: ReactNode }) {
  const head = (
    <div className="loki-suggestion-modal-head">
      <span className="loki-suggestion-modal-title">{say(touch, "suggestions")}</span>
      {count > 0 && <Meta>{say(touch, `${count} waiting`)}</Meta>}
      <span style={{ flex: 1 }} />
      {!touch && <Meta>esc closes</Meta>}
      <IconButton size={touch ? 36 : 28} label={say(touch, "close")} onClick={onClose}>
        <Icon name="close" size={touch ? 20 : 16} />
      </IconButton>
    </div>
  );
  if (touch)
    // The Sheet draws itself at the phone shell's root; React still bubbles its events through the Inbox card, which
    // would take a drag in the sheet for a swipe of the card underneath.
    return (
      <div style={{ display: "contents" }} onPointerDown={stopEvent} onPointerMove={stopEvent} onPointerUp={stopEvent} onPointerCancel={stopEvent}>
        <Sheet label="Suggestions" onClose={onClose} placement="bottom" className="loki-phone-sheet loki-suggestion-sheet">
          {head}
          {children}
        </Sheet>
      </div>
    );
  // Drawn at the body, as the rename dialog is: inside the box it would be clipped to the box.
  const sheet = (
    <Sheet label="suggestions" onClose={onClose} width={720} top="8vh" className="loki-suggestion-modal">
      {head}
      {children}
    </Sheet>
  );
  return typeof document === "undefined" ? sheet : createPortal(sheet, document.body);
}

/** What a suggestion's card is given: the suggestion, where it goes, its state on screen and what its buttons do. */
export interface SuggestionCardProps {
  suggestion: Suggestion;
  target: TargetView;
  open: boolean;
  onToggle: () => void;
  /** Why the last action here was refused; else the suggestion's own reason shows. */
  note: string | null;
  busy: boolean;
  blocked: string | null;
  touch: boolean;
  onDecide: (action: SuggestionAction) => void;
  /** Change chat's picker, given the way to close it. */
  picker: (close: () => void) => ReactNode;
}

/** One suggestion's card, with change chat's picker open or closed. */
export function SuggestionCard(props: SuggestionCardProps) {
  const [picking, setPicking] = useState(false);
  return <SuggestionCardView {...props} picking={picking} onPicking={setPicking} />;
}

/**
 * One suggestion: a line with its title and where it goes; opened, the message and what can be done with it. One
 * being sent shows that and nothing to press; one whose chat is gone offers change chat and reject, never send (AE7).
 */
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
  // A target found gone before anything was pressed says so too, in the words the Mac uses when it refuses (R16).
  const reason = note ?? s.reason ?? (target.gone ? say(touch, "the chat this was for is gone or archived: pick another chat") : null);
  const off = busy || sending || !!blocked;
  return (
    <div className="loki-suggestion" data-suggestion={s.id} data-open={open || undefined}>
      <button type="button" className="loki-suggestion-head" aria-expanded={open} onClick={onToggle}>
        <span className="loki-suggestion-kicker">{say(touch, "suggests")}</span>
        <span className="loki-suggestion-title">{s.title}</span>
        <span className="loki-suggestion-target">→ {target.name}</span>
      </button>
      {open && (
        <div className="loki-suggestion-body">
          {/* The message as the transcript draws a reply (plan 054): lists, code and links read as they were written. */}
          <div className="loki-suggestion-text loki-md">
            <Markdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
              {s.text}
            </Markdown>
          </div>
          <SuggestionNotes sending={sending} reason={reason} blocked={blocked} touch={touch} />
          {!sending && !picking && <SuggestionActions gone={target.gone} off={off} touch={touch} onDecide={onDecide} onPicking={onPicking} />}
          {!sending && picking && picker(() => onPicking(false))}
        </div>
      )}
    </div>
  );
}

/** What an opened card says above its buttons: that it is being sent, why the last action was refused, what blocks it. */
function SuggestionNotes({ sending, reason, blocked, touch }: { sending: boolean; reason: string | null; blocked: string | null; touch: boolean }) {
  return (
    <>
      {sending && (
        <div className="loki-suggestion-note" role="status">
          {say(touch, "sending…")}
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

/** An opened card's buttons; a suggestion whose chat is gone can only change chat or be rejected (AE7). */
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
            {say(touch, "send now")}
          </Button>
          <Button size={size} tone="paper" disabled={off} onClick={() => onDecide("draft")} data-action="draft">
            {say(touch, "save as draft")}
          </Button>
        </>
      )}
      <Button size={size} tone={gone ? "brass" : "paper"} disabled={off} onClick={() => onPicking(true)} data-action="change">
        {say(touch, "change chat")}
      </Button>
      <Button size={size} tone="negative" disabled={off} onClick={() => onDecide("reject")} data-action="reject">
        {say(touch, "reject")}
      </Button>
    </div>
  );
}

/**
 * Change chat (R4): a search over the chats and agents, as ⌘K's; a chat is chosen at once, an agent asks for the
 * folder its new chat works in, the folder of the chat the suggestion was made in to start with.
 */
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
  const choices = chatChoices(source, query, suggestion.target, touch);
  const size = touch ? "touch" : "sm";
  const choose = (c: ChatChoice) => {
    if (c.conversationId) onPick({ agent_id: c.agentId, conversation_id: c.conversationId });
    else setAgent({ id: c.agentId, title: c.title });
  };
  // The Inbox's single keys and its Esc are the deck's; inside these fields they are the field's.
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
          aria-label={say(touch, "folder for the new chat")}
          autoComplete="off"
          autoFocus
        />
        <div className="loki-suggestion-actions">
          <Button size={size} tone="positive" disabled={disabled || !folder.trim()} onClick={() => onPick({ agent_id: agent.id, folder: folder.trim() })}>
            {say(touch, "choose")}
          </Button>
          <Button size={size} tone="paper" onClick={() => setAgent(null)}>
            {say(touch, "back")}
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
        placeholder={say(touch, "find a chat or an agent…")}
        aria-label={say(touch, "find a chat or an agent")}
        autoComplete="off"
        autoFocus
      />
      <ul className="loki-suggestion-hits" aria-label={say(touch, "chats and agents")}>
        {choices.map((c) => (
          <li key={c.key}>
            <Row dense={!touch} touch={touch} disabled={disabled} onClick={() => choose(c)} className="loki-suggestion-hit">
              <span className="loki-suggestion-hit-title">{c.title}</span>
              {c.line && <span className="loki-suggestion-hit-line">{c.line}</span>}
            </Row>
          </li>
        ))}
        {!choices.length && <li className="loki-suggestion-note">{say(touch, "no chat or agent by that name")}</li>}
      </ul>
      <div className="loki-suggestion-actions">
        <Button size={size} tone="paper" onClick={onCancel}>
          {say(touch, "cancel")}
        </Button>
      </div>
    </div>
  );
}
