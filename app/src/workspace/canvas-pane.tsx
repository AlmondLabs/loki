import { LinkHeader } from "../chat/link-header";
import { workersTabStatus } from "../chat/workers-header";
import { WorkersPanel } from "./workers-pane";
import type { SubagentView } from "../../../core/subagents.ts";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type FocusEvent,
  type RefObject,
} from "react";
import { useHeightVar } from "../shared/use-height-var";
import { lastInput, prefersReducedMotion } from "../kit/motion";
import { IconButton, PaneHeader, type Tab } from "../components";
import { Icon } from "../shared/icons";
import { draftKey, useDraft } from "../shared/drafts";
import { dayLabel, unreadBoundary } from "../shared/thread";
import { Conversation } from "../chat/conversation";
import { OpenWorker, OpenChat, type MessageLayout, type TranscriptRow } from "../chat/transcript";
import type { ChatPlacement, ChatWidth } from "../chat/chat-window";
import type { ModelEntry } from "../chat/model-picker";
import { keyFor, registerActions, runAction, specFor } from "../shell/keymap";
import { popUpMenu, under, NATIVE_MENUS, type MenuEntry } from "../shell/native-menu";
import { DrawnMenu } from "../shell/menu-items";
import { useThreadRows, type useAttention } from "../../../core/attention/use-attention.ts";
import { AgentFace } from "./agent-chip";
import { avatarUrl } from "./env";
import { Surface } from "./surface";
import type { useWorkspace } from "./use-workspace";
import { useWorkspaceChat } from "./use-workspace-chat";
import { readCachedThread, writeCachedThread } from "./boot-cache";
import { deskConversation, saveLabels, type DeskConversationHandlers } from "./workspace-conversation";
import { LabelChips, LabelsDialog } from "../chat/labels";
import { useInlineWidgets } from "../chat/use-inline-widgets";
import { doneAction } from "../shell/sidebar-model";
import { useViewed } from "../shared/use-viewed";
import { keyOf, type AttentionItem } from "../../../core/attention/model.ts";
import { ToolbarGroup, ToolbarTitle } from "../item/toolbar";
import { ArchiveIcon, LayoutGridIcon, MailOpenIcon, Maximize2Icon, PanelRightIcon, TagIcon, type LucideIcon } from "lucide-react";
import { chatItem } from "../item/item-view";
import { EMPTY_ROUTE, agentState, paneView, routeTick, tickFor, type CanvasTab, type FrameRequest, type PaneView, type TickRoute } from "./pane";
import { isMainChat } from "../../../core/canvas-core.ts";

export const paneTabs = (subagents: readonly SubagentView[] | null | undefined): ReadonlyArray<Tab<CanvasTab>> => [
  { id: "messages", label: "Messages" },
  ...(subagents && subagents.length > 0 ? [{ id: "workers" as const, label: "Workers", count: subagents.length, status: workersTabStatus(subagents) }] : []),
  { id: "canvas", label: "Canvas" },
];
const panelId = (t: CanvasTab) => `loki-desk-panel-${t}`;
const NO_ROWS: TranscriptRow[] = [];
const NO_SUBAGENTS: SubagentView[] = [];

export interface DeskPaneProps extends DeskConversationHandlers {
  desk: ReturnType<typeof useWorkspace>;
  catchUp: ReturnType<typeof useAttention>;
  active: boolean;
  tab: CanvasTab;
  onTab: (t: CanvasTab) => void;
  selectedWorker?: string | null;
  onSelectWorker?: (chatId: string) => void;
  chatOpen: boolean;
  onChatOpen: (open: boolean) => void;
  chatWidth: ChatWidth;
  onChatWidth: (w: ChatWidth) => void;
  chatPlacement: ChatPlacement;
  focusChat: number;
  findChat: number;
  decideChat: { n: number; behavior: "allow" | "deny" };
  modelPickerTick: number;
  modeMenuTick: number;
  suggestionsTick: number;
  chatPrefill: { text: string; tick: number } | null;
  models: ModelEntry[] | null;
  frameRequest: FrameRequest | null;
  onFrameWidget?: (widgetId: string) => void;
  onShowLabel?: (name: string) => void;
  onOpenChat: (agentId: string, conversationId: string) => void;
}

function useRouted(value: number, visible: PaneView | null, chat: string): TickRoute {
  const [route, setRoute] = useState<TickRoute>(() => ({ ...EMPTY_ROUTE, value, chat }));
  const next = routeTick(route, value, visible, chat);
  if (next !== route) setRoute(next);
  return next;
}

export function CanvasPane(props: DeskPaneProps) {
  const { desk, catchUp, active, tab, onTab, chatOpen, models, onSelectWorker } = props;
  const { scope, title, agentName, agentId, conversationId, attention } = desk;
  const visible = paneView(active, tab);
  const onMessages = visible === "messages";

  const chat = useWorkspaceChat({ agentId, conversationId, showing: active || chatOpen, catchUp });
  const key = agentId && conversationId ? draftKey(agentId, conversationId) : null;
  const [draftValue, setDraft] = useDraft(key);
  const draft = useMemo(() => (key ? { value: draftValue, onChange: setDraft } : undefined), [key, draftValue, setDraft]);

  const focus = useRouted(props.focusChat, visible, scope);
  const find = useRouted(props.findChat, visible, scope);
  const model = useRouted(props.modelPickerTick, visible, scope);
  const mode = useRouted(props.modeMenuTick, visible, scope);
  const suggest = useRouted(props.suggestionsTick, visible, scope);
  const prefill = useRouted(props.chatPrefill?.tick ?? 0, visible, scope);
  const prefillFor = (v: PaneView) => (props.chatPrefill && tickFor(prefill, v) ? props.chatPrefill : null);

  const [labeling, setLabeling] = useState(false);
  const [deskMounted, setDeskMounted] = useState(tab === "canvas");
  if (tab === "canvas" && !deskMounted) setDeskMounted(true);
  const openWorker = useCallback(
    (workerChat?: string) => {
      if (workerChat) onSelectWorker?.(workerChat);
      onTab("workers");
    },
    [onSelectWorker, onTab],
  );
  const row = desk.desks.list.find((d) => d.scope === scope);
  const chatLabels = row?.labels ?? [];
  const purpose = row?.purpose ?? null;
  const runtime = agentId && conversationId ? { agent_id: agentId, conversation_id: conversationId } : null;
  const { view, actions } = deskConversation(desk, catchUp, chat, { ...props, onOpenLabels: runtime ? () => setLabeling(true) : undefined }, undefined);
  const decided = useRef(props.decideChat.n);
  const approve = useEffectEvent((behavior: "allow" | "deny") => {
    if (view.approval) actions.onApprove?.(behavior);
  });
  useEffect(() => {
    if (props.decideChat.n === decided.current) return;
    decided.current = props.decideChat.n;
    if (visible === "messages") approve(props.decideChat.behavior);
  }, [props.decideChat, visible]);
  const item = catchUp.items.find((i) => i.runtime.agent_id === agentId && i.runtime.conversation_id === conversationId) ?? null;
  const people = useMemo(
    () => ({ assistant: { name: agentName ?? "agent", avatar: agentId ? avatarUrl(agentId) : null }, user: { name: "You" } }),
    [agentName, agentId],
  );
  const looking = visible === "messages" || (visible === "inset" && chatOpen);
  const heldLook = useViewed(agentId && conversationId ? keyOf(agentId, conversationId) : null, item, looking, attention.markViewed);
  useDoneKey(active, item, catchUp);
  const { onFrameWidget } = props;
  const frameWidget = onFrameWidget
    ? (widgetId: string) => {
        if (desk.closed.some((w) => w.id === widgetId)) desk.gesture({ kind: "open", id: widgetId });
        onFrameWidget(widgetId);
      }
    : undefined;

  const paneRef = useRef<HTMLDivElement>(null);
  const header = useCallback(() => paneRef.current?.querySelector<HTMLElement>(":scope > .loki-pane-header") ?? null, []);
  useHeightVar(header, "--loki-header-height");
  const threadFocus = useRef<HTMLElement | null>(null);
  useTabFocus(visible, paneRef, threadFocus);
  useSwitchFade(paneRef, scope);
  const live = agentState({ status: view.status, approval: view.approval, question: view.question });
  const name = title ?? agentName ?? "Chat";
  const links = view.links?.length ? (
    <span className="loki-chat-strips">
      <LinkHeader links={view.links} onClose={actions.onCloseLink ? (id) => void actions.onCloseLink?.(id) : undefined} />
    </span>
  ) : null;
  const itemView = item ? chatItem({ item, live: null, turns: [] }) : null;
  const toolbar = itemView && item;
  const itemLine = toolbar ? <ToolbarTitle title={itemView.header.title} facts={itemView.header.properties} extra={links} titleAs="h1" /> : undefined;
  const toolbarItems = toolbar ? (
    <>
      {tab === "canvas" && <DeskActions />}
      <ToolbarGroup
        label="Chat actions"
        moves={[
          ...(runtime ? [{ label: "Label", icon: <TagIcon aria-hidden />, title: "Label (/label)", run: () => setLabeling(true) }] : []),
          ...(item.unread
            ? [{ label: "Mark as Read", icon: <MailOpenIcon aria-hidden />, title: `Mark as Read (${keyFor(DONE)})`, run: () => markDone(catchUp, item) }]
            : []),
          {
            label: "Archive",
            icon: <ArchiveIcon aria-hidden />,
            title: isMainChat(item.id) ? "A main chat cannot be archived" : "Archive",
            disabled: isMainChat(item.id),
            run: () => void catchUp.archive(item, "click"),
          },
        ]}
      />
    </>
  ) : undefined;

  const subagents = view.subagents ?? NO_SUBAGENTS;
  return (
    <OpenWorker.Provider value={openWorker}>
      <div className="loki-canvas-pane" ref={paneRef}>
        <PaneHeader
          title={name}
          subtitle={purpose}
          lead={<Icon name="desk" size={18} />}
          aside={
            <span className="loki-canvas-pane-agent">
              <AgentFace name={agentName} src={agentId ? avatarUrl(agentId) : null} size={18} />
              <span>{agentName ?? "no agent"}</span>
              {live && (
                <>
                  <span className="loki-canvas-pane-live" aria-hidden />
                  <span>{live}</span>
                </>
              )}
              {runtime && (
                <span className="loki-canvas-pane-labels">
                  <LabelChips labels={chatLabels} list={catchUp.labels.list} onPick={props.onShowLabel} />
                  <button type="button" className="loki-canvas-pane-label-add" onClick={() => setLabeling(true)} title="Label this chat (/label)">
                    {chatLabels.length ? "Edit Labels" : "Add Label"}
                  </button>
                </span>
              )}
              {links}
            </span>
          }
          actions={tab === "canvas" ? <DeskActions /> : undefined}
          line={itemLine}
          trailing={toolbarItems}
          tabs={paneTabs(subagents)}
          tab={tab}
          onTab={onTab}
          tabsLabel={`${name} views`}
          panelId={panelId}
        />
        <OpenChat.Provider value={props.onOpenChat}>
          <div className="loki-canvas-pane-body">
            <div
              id={panelId("messages")}
              role="tabpanel"
              aria-label="Messages"
              className="loki-canvas-pane-panel loki-canvas-pane-messages"
              style={{ visibility: tab === "messages" ? "inherit" : "hidden" }}
              aria-hidden={tab !== "messages"}
              onFocus={(e: FocusEvent) => (threadFocus.current = e.target as HTMLElement)}
            >
              <DeskMessages
                key={scope}
                desk={desk}
                catchUp={catchUp}
                item={item}
                heldLook={heldLook}
                people={people}
                onFrameWidget={frameWidget}
                onShowCanvas={() => onTab("canvas")}
                view={view}
                actions={actions}
                models={models}
                draft={draft}
                composer={onMessages}
                dim={false}
                focusTick={tickFor(focus, "messages")}
                findTick={tickFor(find, "messages")}
                modelPickerTick={tickFor(model, "messages")}
                modeMenuTick={tickFor(mode, "messages")}
                suggestionsTick={tickFor(suggest, "messages")}
                prefill={prefillFor("messages")}
                suggestions={runtime ? { source: catchUp, rt: runtime } : null}
              />
            </div>
            {subagents.length > 0 && agentId && (
              <div
                id={panelId("workers")}
                role="tabpanel"
                aria-label="Workers"
                className="loki-canvas-pane-panel loki-canvas-pane-messages"
                style={{ visibility: tab === "workers" ? "inherit" : "hidden" }}
                aria-hidden={tab !== "workers"}
              >
                {tab === "workers" && (
                  <WorkersPanel
                    catchUp={catchUp}
                    agentId={agentId}
                    agentName={agentName}
                    subagents={subagents}
                    selectedChat={props.selectedWorker ?? null}
                    onSelectChat={(chatId) => props.onSelectWorker?.(chatId)}
                    desk={desk}
                    models={{
                      entries: models,
                      onLoad: props.onLoadModels,
                      onPick: props.onPickModel,
                    }}
                    focusTick={tickFor(focus, "workers")}
                    findTick={tickFor(find, "workers")}
                    modelPickerTick={tickFor(model, "workers")}
                  />
                )}
              </div>
            )}
            <div
              id={panelId("canvas")}
              role="tabpanel"
              aria-label="Canvas"
              className="loki-canvas-pane-panel"
              style={{ visibility: tab === "canvas" ? "inherit" : "hidden" }}
              aria-hidden={tab !== "canvas"}
            >
              {deskMounted && (
                <Surface
                  {...props}
                  chat={chat}
                  active={visible === "inset"}
                  draft={draft}
                  focusChat={tickFor(focus, "inset")}
                  findChat={tickFor(find, "inset")}
                  modelPickerTick={tickFor(model, "inset")}
                  modeMenuTick={tickFor(mode, "inset")}
                  suggestionsTick={tickFor(suggest, "inset")}
                  chatPrefill={prefillFor("inset")}
                />
              )}
            </div>
          </div>
        </OpenChat.Provider>
        {labeling && runtime && (
          <LabelsDialog
            title={name}
            current={chatLabels}
            list={catchUp.labels.list}
            onChange={(next) => saveLabels(desk, catchUp, runtime, next)}
            onClose={() => setLabeling(false)}
          />
        )}
      </div>
    </OpenWorker.Provider>
  );
}

function DeskMessages({
  desk,
  catchUp,
  item,
  heldLook,
  people,
  onFrameWidget,
  onShowCanvas,
  view,
  ...conversation
}: Omit<ComponentProps<typeof Conversation>, "layout" | "agentName"> & {
  desk: ReturnType<typeof useWorkspace>;
  catchUp: ReturnType<typeof useAttention>;
  item: AttentionItem | null;
  heldLook: string | null;
  people: MessageLayout["people"];
  onFrameWidget: ((widgetId: string) => void) | undefined;
  onShowCanvas: () => void;
}) {
  const { agentId, conversationId, agentName } = desk;
  const liveRows = useThreadRows(catchUp, agentId, conversationId);
  const cachedRows = useMemo(
    () => (liveRows === undefined && agentId && conversationId ? readCachedThread(agentId, conversationId) : null),
    [liveRows, agentId, conversationId],
  );
  const rows = liveRows ?? cachedRows ?? undefined;
  useEffect(() => {
    if (liveRows && liveRows.length > 0 && agentId && conversationId) writeCachedThread(agentId, conversationId, liveRows);
  }, [liveRows, agentId, conversationId]);
  const list = rows ?? NO_ROWS;
  const dividerAt = unreadBoundary(list, item?.unread ?? false, item?.seenAt, heldLook);
  const { widgets, inline } = useInlineWidgets(desk, desk.scope, list, agentName, { onOpen: onFrameWidget });
  const layout = { people, dividerAt, dividerDay: dayLabel(item?.last_message_at), widgets, inline, onFrameWidget, onShowCanvas };
  return (
    <Conversation
      {...conversation}
      view={{ ...view, rows }}
      agentName={agentName}
      layout={layout}
      usualModels={agentId ? desk.models.usual[agentId] : undefined}
    />
  );
}

const TAB_OF: Record<PaneView, CanvasTab> = { messages: "messages", workers: "workers", inset: "canvas" };

function useTabFocus(visible: PaneView | null, root: RefObject<HTMLDivElement | null>, last: RefObject<HTMLElement | null>) {
  const prev = useRef(visible);
  useEffect(() => {
    const was = prev.current;
    prev.current = visible;
    const el = root.current;
    if (!el || was === visible) return;
    const active = document.activeElement as HTMLElement | null;
    if (!was || !visible) return;
    const left = TAB_OF[was];
    const focusLeftWith =
      !active ||
      active === document.body ||
      !!document.getElementById(panelId(left))?.contains(active) ||
      active.getAttribute("aria-controls") === panelId(left);
    if (!focusLeftWith) return;
    if (visible !== "messages") el.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
    else if (last.current?.isConnected) last.current.focus({ preventScroll: true });
  }, [visible, root, last]);
}

const DONE = "chat.done";

function markDone(catchUp: ReturnType<typeof useAttention>, item: AttentionItem | null) {
  if (item && doneAction(item) === "done") catchUp.seen(item);
}

function useDoneKey(active: boolean, item: AttentionItem | null, catchUp: ReturnType<typeof useAttention>) {
  const ref = useRef({ item, catchUp });
  useEffect(() => {
    ref.current = { item, catchUp };
  });
  useEffect(() => {
    if (!active) return;
    return registerActions({ [DONE]: () => markDone(ref.current.catchUp, ref.current.item) });
  }, [active]);
}

function DeskActions() {
  const [menuOpen, setMenuOpen] = useState(false);
  const native = NATIVE_MENUS;
  const action = (id: string, label: string, icon: LucideIcon): MenuEntry => ({ type: "item", id, label, icon, keys: specFor(id), run: () => runAction(id) });
  const entries: MenuEntry[] = [
    action("canvas.arrange", "Arrange Widgets", LayoutGridIcon),
    action("view.fit", "Fit All Widgets", Maximize2Icon),
    { type: "separator" },
    action("chat.toggle", "Show / Hide Chat", PanelRightIcon),
  ];
  if (native)
    return (
      <span className="loki-canvas-pane-menu-anchor">
        <IconButton
          size={28}
          label="More Chat Actions"
          aria-haspopup="menu"
          onClick={(e) => void popUpMenu(entries, under(e.currentTarget)).catch((err: unknown) => console.warn("loki: pane menu", err))}
        >
          <Icon name="more" size={16} />
        </IconButton>
      </span>
    );
  return (
    <span className="loki-canvas-pane-menu-anchor">
      <DrawnMenu
        label="Chat actions"
        entries={entries}
        open={menuOpen}
        onOpenChange={setMenuOpen}
        trigger={
          <IconButton size={28} label="More Chat Actions">
            <Icon name="more" size={16} />
          </IconButton>
        }
      />
    </span>
  );
}

function useSwitchFade(paneRef: RefObject<HTMLDivElement | null>, scope: string) {
  const shown = useRef(scope);
  useLayoutEffect(() => {
    if (shown.current === scope) return;
    shown.current = scope;
    const el = paneRef.current;
    if (!el || typeof el.animate !== "function" || lastInput() === "key" || prefersReducedMotion()) return;
    el.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 160, easing: "ease-out" });
  }, [paneRef, scope]);
}
