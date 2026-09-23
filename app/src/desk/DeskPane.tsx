import { useEffect, useMemo, useRef, useState } from "react";
import { IconButton, PaneHeader, Popover, Row, Kbd, type Tab } from "../components";
import { Icon } from "../shared/icons";
import { draftKey, useDraft } from "../shared/drafts";
import { dayLabel, unreadBoundary } from "../shared/thread";
import { Conversation } from "../chat/Conversation";
import type { ChatPlacement, ChatWidth } from "../chat/ChatWindow";
import type { ModelEntry } from "../chat/ModelPicker";
import { runAction } from "../shell/keymap";
import type { useAttention } from "../../../core/attention/useAttention.ts";
import { AgentFace } from "./AgentChip";
import { avatarUrl } from "./env";
import { Surface } from "./Surface";
import type { useDesk } from "./useDesk";
import { useDeskChat } from "./useDeskChat";
import { deskConversation, type DeskConversationHandlers } from "./deskConversation";
import { EMPTY_ROUTE, agentState, paneView, routeTick, tickFor, type DeskTab, type FrameRequest, type PaneView, type TickRoute } from "./pane";

const TABS: readonly Tab<DeskTab>[] = [
  { id: "messages", label: "Messages" },
  { id: "desk", label: "Desk" },
];
const panelId = (t: DeskTab) => `loki-desk-panel-${t}`;

export interface DeskPaneProps extends DeskConversationHandlers {
  desk: ReturnType<typeof useDesk>;
  catchUp: ReturnType<typeof useAttention>;
  /** The Desk section is on screen (the pane is kept mounted, hidden, behind the other sections). */
  active: boolean;
  tab: DeskTab;
  onTab: (t: DeskTab) => void;
  /** The inset chat on the Desk tab: open or closed, its width and place (the shell's useChatLayout). */
  chatOpen: boolean;
  onChatOpen: (open: boolean) => void;
  chatWidth: ChatWidth;
  onChatWidth: (w: ChatWidth) => void;
  chatPlacement: ChatPlacement;
  /** The shell's counters (⌘L focus, ⌘F find, ⌘⇧M model, ⌘⇧P mode) and a prefill; each reaches the view that shows. */
  focusChat: number;
  findChat: number;
  modelPickerTick: number;
  modeMenuTick: number;
  chatPrefill: { text: string; tick: number } | null;
  models: ModelEntry[] | null;
  frameRequest: FrameRequest | null;
  notice: (m: string) => void;
}

/** A host counter routed to the view that showed when it was bumped (desk/pane.ts), as React state derived during render. */
function useRouted(value: number, visible: PaneView | null): TickRoute {
  const [route, setRoute] = useState<TickRoute>(() => ({ ...EMPTY_ROUTE, value }));
  const next = routeTick(route, value, visible);
  if (next !== route) setRoute(next);
  return next;
}

/**
 * A desk as a Slack channel (plan 013 U5): the header (the desk's name, the agent with its live state, pin,
 * archive and a menu for the rest), the Messages | Desk tab row, then the tab. Messages is the conversation
 * in Slack's message layout with the composer; Desk is today's sheet with the inset chat. One useDeskChat and
 * one draft feed both. The Messages thread stays mounted under the Desk tab and the other sections, so its
 * scroll survives the round trip, but only the view on screen draws the box, the switchers and the open
 * question or approval.
 */
export function DeskPane(props: DeskPaneProps) {
  const { desk, catchUp, active, tab, onTab, chatOpen, models, notice } = props;
  const { scope, title, agentName, agentId, conversationId, connection, attention } = desk;
  const visible = paneView(active, tab);
  const onMessages = visible === "messages";

  const chat = useDeskChat({ agentId, conversationId, connection, showing: active || chatOpen, catchUp, attention });
  // One draft for both views, keyed by the conversation; before the desk knows its conversation each box keeps its own.
  const key = agentId && conversationId ? draftKey(agentId, conversationId) : null;
  const [draftValue, setDraft] = useDraft(key);
  const draft = useMemo(() => (key ? { value: draftValue, onChange: setDraft } : undefined), [key, draftValue, setDraft]);

  const focus = useRouted(props.focusChat, visible);
  const find = useRouted(props.findChat, visible);
  const model = useRouted(props.modelPickerTick, visible);
  const mode = useRouted(props.modeMenuTick, visible);
  const prefill = useRouted(props.chatPrefill?.tick ?? 0, visible);
  const prefillFor = (v: PaneView) => (props.chatPrefill && tickFor(prefill, v) ? props.chatPrefill : null);

  const { view, actions } = deskConversation(desk, catchUp, chat, props);
  const item = catchUp.items.find((i) => i.runtime.agent_id === agentId && i.runtime.conversation_id === conversationId) ?? null;
  const people = useMemo(() => ({ assistant: { name: agentName ?? "agent", avatar: agentId ? avatarUrl(agentId) : null }, user: { name: "You" } }), [agentName, agentId]);
  const dividerAt = unreadBoundary(view.rows, item?.unread ?? false, item?.seenAt);
  // Thread hands the transcript each field on its own, so only `people` needs a stable identity.
  const layout = { people, dividerAt, dividerDay: dayLabel(item?.lastMessageAt), toolbar: true };

  const summary = desk.desks.list.find((d) => d.scope === scope) ?? null;
  const live = agentState({ status: view.status, approval: view.approval, question: view.question });
  const name = title ?? agentName ?? "Desk";

  return (
    <div className="loki-desk-pane">
      <PaneHeader
        title={name}
        lead={<Icon name="desk" size={18} />}
        aside={
          <span className="loki-desk-pane-agent">
            <AgentFace name={agentName} src={agentId ? avatarUrl(agentId) : null} size={18} />
            <span>{agentName ?? "no agent"}</span>
            {live && (
              <>
                <span className="loki-desk-pane-live" aria-hidden />
                <span>{live}</span>
              </>
            )}
          </span>
        }
        actions={<DeskActions desk={desk} catchUp={catchUp} summary={summary} tab={tab} notice={notice} />}
        tabs={TABS}
        tab={tab}
        onTab={onTab}
        tabsLabel={`${name} views`}
        panelId={panelId}
      />
      <div className="loki-desk-pane-body">
        <div id={panelId("messages")} role="tabpanel" aria-label="Messages" className="loki-desk-pane-panel loki-desk-pane-messages" style={{ visibility: tab === "messages" ? "visible" : "hidden" }} aria-hidden={tab !== "messages"}>
          <Conversation
            key={scope}
            view={view}
            actions={actions}
            models={models}
            agentName={agentName}
            layout={layout}
            draft={draft}
            composer={onMessages}
            dim={false}
            focusTick={tickFor(focus, "messages")}
            findTick={tickFor(find, "messages")}
            modelPickerTick={tickFor(model, "messages")}
            modeMenuTick={tickFor(mode, "messages")}
            prefill={prefillFor("messages")}
          />
        </div>
        <div id={panelId("desk")} role="tabpanel" aria-label="Desk" className="loki-desk-pane-panel" style={{ visibility: tab === "desk" ? "visible" : "hidden" }} aria-hidden={tab !== "desk"}>
          <Surface
            {...props}
            chat={chat}
            active={visible === "inset"}
            draft={draft}
            focusChat={tickFor(focus, "inset")}
            findChat={tickFor(find, "inset")}
            modelPickerTick={tickFor(model, "inset")}
            modeMenuTick={tickFor(mode, "inset")}
            chatPrefill={prefillFor("inset")}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The header's actions: pin / unpin and archive / restore (what the desk tree offers on a row), then a menu
 * for the rest of what the desk does today, each through its keymap action so the key and the menu agree.
 */
function DeskActions({ desk, catchUp, summary, tab, notice }: { desk: ReturnType<typeof useDesk>; catchUp: ReturnType<typeof useAttention>; summary: ReturnType<typeof useDesk>["desks"]["list"][number] | null; tab: DeskTab; notice: (m: string) => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { agentId, conversationId } = desk;
  const canPin = !!summary && !!agentId && !!conversationId && summary.status === "live";
  const canArchive = !!summary && desk.attention.available && !!conversationId && conversationId !== "default" && summary.status !== "deleted";
  const archived = summary?.status === "archived";
  const archive = () => {
    if (!conversationId) return;
    void catchUp.archiveConversation(conversationId, !archived).then((err) => {
      if (err) return notice(`archive: ${err}`);
      notice(`${desk.title ?? desk.scope} ${archived ? "restored" : "archived"}`);
      desk.desks.request();
    });
  };
  const items: Array<{ id: string; label: string; keys: string }> = [
    { id: "chat.find", label: "Find in conversation…", keys: "⌘F" },
    { id: "chat.model", label: "Change model…", keys: "⌘⇧M" },
    { id: "chat.mode", label: "Change permission mode…", keys: "⌘⇧P" },
    ...(tab === "desk"
      ? [
          { id: "desk.arrange", label: "Arrange widgets", keys: "⌘⇧A" },
          { id: "view.fit", label: "Fit all widgets", keys: "⌘0" },
          { id: "chat.toggle", label: "Show / hide chat", keys: "⌘/" },
        ]
      : []),
    { id: "desk.new", label: "New desk…", keys: "⌘N" },
  ];
  return (
    <>
      {canPin && (
        <IconButton size={28} label={summary!.pinned ? "Unpin desk" : "Pin desk"} aria-pressed={!!summary!.pinned} onClick={() => desk.desks.pin(agentId!, conversationId!, !summary!.pinned)}>
          <Icon name="pin" size={16} />
        </IconButton>
      )}
      {canArchive && (
        <IconButton size={28} label={archived ? "Restore desk" : "Archive desk"} onClick={archive}>
          <Icon name="archive" size={16} />
        </IconButton>
      )}
      <span className="loki-desk-pane-menu-anchor">
        <IconButton size={28} label="More desk actions" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
          <Icon name="more" size={16} />
        </IconButton>
        {menuOpen && (
          <DeskMenu
            items={items}
            onPick={(id) => {
              setMenuOpen(false);
              runAction(id);
            }}
            onClose={() => setMenuOpen(false)}
          />
        )}
      </span>
    </>
  );
}

/** The overflow menu: ↑↓ / Enter / Esc, or click; a click outside closes it. */
function DeskMenu({ items, onPick, onClose }: { items: Array<{ id: string; label: string; keys: string }>; onPick: (id: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    // a press outside the menu and its button closes it (the button toggles it itself)
    const away = (e: PointerEvent) => {
      if (!ref.current?.parentElement?.contains(e.target as Node)) closeRef.current();
    };
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, []);
  return (
    <Popover
      ref={ref}
      role="menu"
      aria-label="Desk actions"
      anchor="right"
      width={260}
      // hung from a 28px button: the popover's own cap (its parent's width) would crush it
      style={{ padding: 4, right: 0, maxWidth: "none" }}
      onKeyDown={(e) => {
        const all = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
        const i = all.indexOf(document.activeElement as HTMLElement);
        if (e.key === "ArrowDown") all[Math.min(all.length - 1, i + 1)]?.focus();
        else if (e.key === "ArrowUp") all[Math.max(0, i - 1)]?.focus();
        else if (e.key === "Escape") onClose();
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {items.map((it) => (
        <Row key={it.id} dense role="menuitem" onClick={() => onPick(it.id)} className="loki-desk-pane-menu-item">
          <span>{it.label}</span>
          <Kbd>{it.keys}</Kbd>
        </Row>
      ))}
    </Popover>
  );
}
