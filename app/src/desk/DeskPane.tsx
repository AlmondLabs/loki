import { useEffect, useMemo, useRef, useState, type FocusEvent, type RefObject } from "react";
import { IconButton, PaneHeader, Popover, Row, Kbd, type Tab } from "../components";
import { Icon } from "../shared/icons";
import { draftKey, useDraft } from "../shared/drafts";
import { dayLabel, unreadBoundary } from "../shared/thread";
import { Conversation } from "../chat/Conversation";
import type { ChatPlacement, ChatWidth } from "../chat/ChatWindow";
import type { ModelEntry } from "../chat/ModelPicker";
import { keyFor, registerActions, runAction } from "../shell/keymap";
import type { useAttention } from "../../../core/attention/useAttention.ts";
import { AgentFace } from "./AgentChip";
import { avatarUrl } from "./env";
import { Surface } from "./Surface";
import type { useDesk } from "./useDesk";
import { useDeskChat } from "./useDeskChat";
import { deskConversation, type DeskConversationHandlers } from "./deskConversation";
import { widgetMarks } from "./widgetRows";
import { NO_RENAME_REASON, RenameDesk, renameDesk } from "./RenameDesk";
import { canRename, doneAction } from "../shell/sidebarModel";
import { useViewed } from "../shared/useViewed";
import { keyOf, type AttentionItem } from "../../../core/attention/model.ts";
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
  /** A widget row chosen in the thread: open the Desk tab framed on that widget (useDeskPane's frame). */
  onFrameWidget?: (widgetId: string) => void;
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
  // Viewed, not done: the thread on screen (Messages, or the Desk tab's open chat) looks at each new message once;
  // the New line goes before what came since the look held from before this open.
  const looking = visible === "messages" || (visible === "inset" && chatOpen);
  const heldLook = useViewed(agentId && conversationId ? keyOf(agentId, conversationId) : null, item, looking, attention.markViewed);
  const dividerAt = unreadBoundary(view.rows, item?.unread ?? false, item?.seenAt, heldLook);
  useDoneKey(active, item, catchUp);
  // The desk's widget changes among the messages, by time (R15). The compiler caches the handlers below on the
  // desk and onTab, but not this (view comes from a plain function), so a hook keeps it stable while you type.
  const widgets = useWidgetMarks(view.rows, desk.widgetLog, agentName);
  const { onFrameWidget } = props;
  const frameWidget = onFrameWidget
    ? (widgetId: string) => {
        // A minimised widget comes back to the canvas first, so there is something to frame.
        if (desk.closed.some((w) => w.id === widgetId)) desk.gesture({ kind: "open", id: widgetId });
        onFrameWidget(widgetId);
      }
    : undefined;
  const layout = { people, dividerAt, dividerDay: dayLabel(item?.lastMessageAt), toolbar: true, widgets, onFrameWidget: frameWidget, onShowDesk: () => onTab("desk") };

  const summary = desk.desks.list.find((d) => d.scope === scope) ?? null;
  // Focus across the tab switch (useTabFocus): the pane's root, and what the thread last held.
  const paneRef = useRef<HTMLDivElement>(null);
  const threadFocus = useRef<HTMLElement | null>(null);
  useTabFocus(visible, paneRef, threadFocus);
  const live = agentState({ status: view.status, approval: view.approval, question: view.question });
  const name = title ?? agentName ?? "Desk";

  return (
    <div className="loki-desk-pane" ref={paneRef}>
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
        actions={<DeskActions desk={desk} catchUp={catchUp} item={item} summary={summary} tab={tab} notice={notice} />}
        tabs={TABS}
        tab={tab}
        onTab={onTab}
        tabsLabel={`${name} views`}
        panelId={panelId}
      />
      {/* The showing panel inherits its visibility, never sets "visible": the shell hides the whole pane behind other sections, and a child marked visible would show through them. */}
      <div className="loki-desk-pane-body">
        <div id={panelId("messages")} role="tabpanel" aria-label="Messages" className="loki-desk-pane-panel loki-desk-pane-messages" style={{ visibility: tab === "messages" ? "inherit" : "hidden" }} aria-hidden={tab !== "messages"} onFocus={(e: FocusEvent) => (threadFocus.current = e.target as HTMLElement)}>
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
        <div id={panelId("desk")} role="tabpanel" aria-label="Desk" className="loki-desk-pane-panel" style={{ visibility: tab === "desk" ? "inherit" : "hidden" }} aria-hidden={tab !== "desk"}>
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
 * Focus across the tab switch. Hiding a panel drops the focus it held to the page, so leaving Messages for the
 * Desk tab from a widget row puts it on the selected tab, and coming back with Esc returns it to what it last
 * held in the thread (the widget row, the box). Focus on a tab of the tab row stays where it is.
 */
function useTabFocus(visible: PaneView | null, root: RefObject<HTMLDivElement | null>, last: RefObject<HTMLElement | null>) {
  const prev = useRef(visible);
  useEffect(() => {
    const was = prev.current;
    prev.current = visible;
    const el = root.current;
    if (!el || was === visible) return;
    const active = document.activeElement as HTMLElement | null;
    // The panel just hidden may still hold the focus until the browser moves it off: count that as dropped too.
    const inPanel = (t: DeskTab) => !active || active === document.body || !!document.getElementById(panelId(t))?.contains(active) || active.getAttribute("aria-controls") === panelId(t);
    if (was === "messages" && visible === "inset" && inPanel("messages")) el.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
    else if (was === "inset" && visible === "messages" && inPanel("desk") && last.current?.isConnected) last.current.focus({ preventScroll: true });
  }, [visible, root, last]);
}

/** A line of the header's menu: a keymap action (run through runAction, its key shown), or the rename dialog. */
type MenuItem = { id: string; label: string; keys?: string; disabled?: boolean; title?: string };
const RENAME = "desk.rename";
const DONE = "desk.done";
const UNDONE = "desk.undone";

/** Done by hand, the Inbox's own paths: Mark as done clears it (seen_mark), Mark as not done puts it back (seen_unmark). */
function markDone(catchUp: ReturnType<typeof useAttention>, item: AttentionItem | null, done: boolean) {
  if (!item || doneAction(item) !== (done ? "done" : "undone")) return;
  if (done) catchUp.seen(item);
  else catchUp.unread(item);
}

/** ⌘⇧↵ (desk.done) marks the open desk done while the Desk section shows. Registered once per showing; the item is read through a ref. */
function useDoneKey(active: boolean, item: AttentionItem | null, catchUp: ReturnType<typeof useAttention>) {
  const ref = useRef({ item, catchUp });
  useEffect(() => {
    ref.current = { item, catchUp };
  });
  useEffect(() => {
    if (!active) return;
    return registerActions({ [DONE]: () => markDone(ref.current.catchUp, ref.current.item, true) });
  }, [active]);
}

/**
 * The header's actions: pin / unpin and archive / restore (what the sidebar offers on a row), then a menu:
 * Mark as done or not done first (the Inbox's clear and undo), rename, then the rest of what the desk does today, each through
 * its keymap action so the key and the menu agree.
 */
function DeskActions({ desk, catchUp, item, summary, tab, notice }: { desk: ReturnType<typeof useDesk>; catchUp: ReturnType<typeof useAttention>; item: AttentionItem | null; summary: ReturnType<typeof useDesk>["desks"]["list"][number] | null; tab: DeskTab; notice: (m: string) => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const { agentId, conversationId } = desk;
  const connected = catchUp.status === "open";
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
  const done = doneAction(item);
  const items: MenuItem[] = [
    ...(done === "done" ? [{ id: DONE, label: "Mark as done", keys: keyFor("desk.done") }] : done === "undone" ? [{ id: UNDONE, label: "Mark as not done" }] : []),
    ...(summary && canRename(summary) ? [{ id: RENAME, label: "Rename…", disabled: !connected, title: connected ? undefined : NO_RENAME_REASON }] : []),
    { id: "chat.find", label: "Find in conversation…", keys: keyFor("chat.find") },
    { id: "chat.model", label: "Change model…", keys: keyFor("chat.model") },
    { id: "chat.mode", label: "Change permission mode…", keys: keyFor("chat.mode") },
    ...(tab === "desk"
      ? [
          { id: "desk.arrange", label: "Arrange widgets", keys: keyFor("desk.arrange") },
          { id: "view.fit", label: "Fit all widgets", keys: keyFor("view.fit") },
          { id: "chat.toggle", label: "Show / hide chat", keys: keyFor("chat.toggle") },
        ]
      : []),
    { id: "desk.new", label: "New desk…", keys: keyFor("desk.new") },
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
              if (id === RENAME) setRenaming(true);
              else if (id === DONE || id === UNDONE) markDone(catchUp, item, id === DONE);
              else runAction(id);
            }}
            onClose={() => setMenuOpen(false)}
          />
        )}
      </span>
      {renaming && summary && <RenameDesk name={desk.title ?? summary.title ?? ""} onClose={() => setRenaming(false)} onRename={(name) => renameDesk(desk, catchUp, notice)(summary, name)} />}
    </>
  );
}

/** widgetMarks for the thread, recomputed only when the rows, the log or the agent's name change: the transcript is memoised on it. */
function useWidgetMarks(rows: Parameters<typeof widgetMarks>[0], log: Parameters<typeof widgetMarks>[1], agentName: string | null) {
  return useMemo(() => widgetMarks(rows, log, agentName), [rows, log, agentName]);
}

/** The overflow menu: ↑↓ / Enter / Esc, or click; a click outside closes it. */
function DeskMenu({ items, onPick, onClose }: { items: MenuItem[]; onPick: (id: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    const node = ref.current;
    const anchor = node?.parentElement ?? null;
    node?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    // a press outside the menu and its button closes it (the button toggles it itself)
    const away = (e: PointerEvent) => {
      if (!anchor?.contains(e.target as Node)) closeRef.current();
    };
    // capture phase: the rail, the list column and popovers stop pointerdown from bubbling, and a press there must still close it
    window.addEventListener("pointerdown", away, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      // Esc, or a pick whose action takes no focus of its own: back to the "More desk actions" button.
      const a = document.activeElement;
      if (!a || a === document.body || node?.contains(a)) anchor?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    };
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
        const all = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
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
        <Row key={it.id} dense role="menuitem" disabled={it.disabled} title={it.title} onClick={() => onPick(it.id)} className="loki-desk-pane-menu-item">
          <span>{it.label}</span>
          {it.keys && <Kbd>{it.keys}</Kbd>}
        </Row>
      ))}
    </Popover>
  );
}
