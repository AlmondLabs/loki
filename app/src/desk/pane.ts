import type { Segment } from "../shell/keymap";

/**
 * The desk pane's state, apart from React (plan 013 U5; test/desk-pane.test.ts). A desk is a Slack channel:
 * its Messages tab is the conversation, its Desk tab today's canvas with the inset chat. The tab is kept per
 * desk; every open (the sidebar, the Inbox, Learn, Agents, a new desk) lands on Messages, while a switch
 * that is not an open (⌘[ ⌘], the mod's switch_desk) shows the desk's own tab. Esc on the Desk tab comes back.
 */

export type DeskTab = "messages" | "desk";
/** Which chat view shows: the Messages tab's, the Desk tab's inset, or none (another section is on screen). */
export type PaneView = "messages" | "inset";

export interface PaneState {
  readonly tabs: Readonly<Record<string, DeskTab>>;
}
export const EMPTY_PANE: PaneState = { tabs: {} };

export const tabOf = (s: PaneState, scope: string): DeskTab => s.tabs[scope] ?? "messages";

export function chooseTab(s: PaneState, scope: string, tab: DeskTab): PaneState {
  if (tabOf(s, scope) === tab) return s;
  return { tabs: { ...s.tabs, [scope]: tab } };
}

/** An open from anywhere: Messages, whatever the desk was left on. */
export const openTab = (s: PaneState, scope: string): PaneState => chooseTab(s, scope, "messages");

/** Esc on the Desk tab returns to Messages; null when the key is not the pane's (typing, or already on Messages). */
export function escapeTab(s: PaneState, scope: string, { typing }: { typing: boolean }): PaneState | null {
  if (typing || tabOf(s, scope) !== "desk") return null;
  return chooseTab(s, scope, "messages");
}

/** The Desk tab gives the canvas the window: the list column hides, the rail stays. */
export const sidebarHidden = (segment: Segment, tab: DeskTab): boolean => segment === "desk" && tab === "desk";

export const paneView = (active: boolean, tab: DeskTab): PaneView | null => (!active ? null : tab === "messages" ? "messages" : "inset");

/**
 * Where a chat key goes. Focus, find, model and mode act on whichever view shows; the inset's own keys
 * (show / hide, close, move left / right) mean nothing on Messages, where the conversation is the pane.
 */
export function chatKeyTarget(id: string, tab: DeskTab): PaneView | null {
  if (tab === "desk") return "inset";
  return id === "chat.focus" || id === "chat.find" || id === "chat.model" || id === "chat.mode" ? "messages" : null;
}

/**
 * The host drives a chat with counters it bumps (focus, find, model, mode, a prefill's tick), and a
 * Conversation acts on a counter above 0 when it mounts. A bump belongs to the view that showed when it
 * happened; once another view shows, nobody gets it, so switching tabs never replays an old one.
 */
export interface TickRoute {
  readonly value: number;
  readonly to: PaneView | null;
}
export const EMPTY_ROUTE: TickRoute = { value: 0, to: null };

export function routeTick(r: TickRoute, value: number, visible: PaneView | null): TickRoute {
  if (value !== r.value) return { value, to: visible };
  if (r.to !== null && r.to !== visible) return { value, to: null };
  return r;
}
export const tickFor = (r: TickRoute, view: PaneView): number => (r.to === view ? r.value : 0);

/** A request for the Surface to frame one widget (a widget row in the thread, U8); the nonce makes a repeat new. */
export interface FrameRequest {
  readonly widgetId: string;
  readonly nonce: number;
}
export const nextFrame = (prev: FrameRequest | null, widgetId: string): FrameRequest => ({ widgetId, nonce: (prev?.nonce ?? 0) + 1 });

/** The agent pill's live state in the header: what the conversation is doing, in a word or two; null when idle. */
export function agentState({ status, approval, question }: { status: "idle" | "thinking" | "streaming"; approval: unknown; question: unknown }): string | null {
  return approval ? "needs approval" : question ? "asked you" : status === "streaming" ? "writing" : status === "thinking" ? "working" : null;
}
