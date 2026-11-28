export type CanvasTab = "messages" | "workers";
export type PaneView = "messages" | "workers";

export interface PaneState {
  readonly tabs: Readonly<Record<string, CanvasTab>>;
}
export const EMPTY_PANE: PaneState = { tabs: {} };

export const tabOf = (s: PaneState, scope: string): CanvasTab => s.tabs[scope] ?? "messages";

export function chooseTab(s: PaneState, scope: string, tab: CanvasTab): PaneState {
  if (tabOf(s, scope) === tab) return s;
  return { tabs: { ...s.tabs, [scope]: tab } };
}

export const openTab = (s: PaneState, scope: string): PaneState => chooseTab(s, scope, "messages");

export const shownTab = (tab: CanvasTab, hasWorkers: boolean): CanvasTab => (tab === "workers" && !hasWorkers ? "messages" : tab);

export function escapeTab(s: PaneState, scope: string, shown: CanvasTab, { typing }: { typing: boolean }): PaneState | null {
  if (typing || shown === "messages") return null;
  return chooseTab(s, scope, "messages");
}

const VIEW: Record<CanvasTab, PaneView> = { messages: "messages", workers: "workers" };

export const paneView = (active: boolean, tab: CanvasTab): PaneView | null => (active ? VIEW[tab] : null);

const WORKER_KEYS = new Set(["chat.focus", "chat.find", "chat.model"]);
const MESSAGES_KEYS = new Set([...WORKER_KEYS, "chat.mode", "chat.suggestions"]);

export function chatKeyTarget(id: string, tab: CanvasTab): PaneView | null {
  if (tab === "workers") return WORKER_KEYS.has(id) ? "workers" : null;
  return MESSAGES_KEYS.has(id) ? "messages" : null;
}

export interface TickRoute {
  readonly value: number;
  readonly to: PaneView | null;
  readonly chat: string | null;
}
export const EMPTY_ROUTE: TickRoute = { value: 0, to: null, chat: null };

export function routeTick(r: TickRoute, value: number, visible: PaneView | null, chat: string | null): TickRoute {
  if (value !== r.value) return { value, to: visible, chat };
  if (r.to !== null && (r.to !== visible || r.chat !== chat)) return { value, to: null, chat };
  return r;
}
export const tickFor = (r: TickRoute, view: PaneView): number => (r.to === view ? r.value : 0);

export function agentState({ status, approval, question }: { status: "idle" | "thinking" | "streaming"; approval: unknown; question: unknown }): string | null {
  return approval ? "needs approval" : question ? "asked you" : status === "streaming" ? "writing" : status === "thinking" ? "working" : null;
}

interface WorkerRef {
  chat_id: string;
  status: string;
}

export function activeWorkerChat(subagents: readonly WorkerRef[], selectedChat: string | null): string | null {
  const hit = selectedChat ? subagents.find((s) => s.chat_id === selectedChat) : undefined;
  return (hit ?? subagents.find((s) => s.status === "running") ?? subagents.at(0))?.chat_id ?? null;
}

export function stepWorkerChat(subagents: readonly WorkerRef[], selectedChat: string | null, delta: -1 | 1): string | null {
  if (subagents.length === 0) return null;
  const current = activeWorkerChat(subagents, selectedChat);
  const index = current ? subagents.findIndex((s) => s.chat_id === current) : 0;
  const next = (index + delta + subagents.length) % subagents.length;
  return subagents[next]?.chat_id ?? null;
}
