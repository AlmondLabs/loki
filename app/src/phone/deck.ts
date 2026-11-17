import { archivable, type AttentionItem } from "../../../core/attention/model.ts";
import { agentLanes, type Lane } from "../../../core/attention/lanes.ts";
import { idOf, inboxQueue, stampOf } from "../../../core/attention/queue.ts";
import type { CardVia, MoveResult } from "../../../core/attention/use-attention.ts";
import { releaseCommits } from "../kit/let-go";

export type Swipe = "seen" | "later";
export type Move = Swipe | "archive";
export type Via = Move | "approve" | "deny";

export const COMMIT_FRACTION = 0.4;
export const MAX_ROTATION = 8;
export const DRAG_SLOP = 8;
export const UNDO_MS = 6000;
export const FLY_PAST = 80;

export function swipeDecision(dx: number, width: number, velocity: number, opts: { approval: boolean; typed?: boolean }): Swipe | null {
  if (opts.approval || opts.typed) return null;
  if (!Number.isFinite(dx) || !Number.isFinite(width) || width <= 0 || dx === 0) return null;
  const sign = dx > 0 ? 1 : -1;
  const dir: Swipe = sign > 0 ? "seen" : "later";
  return releaseCommits(dx * sign, velocity * 1000 * sign, width * COMMIT_FRACTION, DRAG_SLOP) ? dir : null;
}

export function isHorizontalDrag(dx: number, dy: number): boolean {
  return Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > DRAG_SLOP;
}

export function rotationFor(dx: number, width: number): number {
  if (!(width > 0)) return 0;
  const r = (dx / (width * COMMIT_FRACTION)) * MAX_ROTATION;
  return Math.max(-MAX_ROTATION, Math.min(MAX_ROTATION, r));
}

export function armed(dx: number, width: number): boolean {
  return width > 0 && Math.abs(dx) >= width * COMMIT_FRACTION;
}

export function flingVelocity(from: number, to: number, v: number): number {
  const d = to - from;
  return Math.abs(d) < 1 ? 0 : (v * 1000) / d;
}

export function revealOpacity(dx: number, width: number): number {
  if (!(width > 0)) return 0;
  return Math.max(0, Math.min(1, Math.abs(dx) / (width * COMMIT_FRACTION)));
}

export function refusedOffset(dx: number): number {
  const eased = dx * 0.25;
  return Math.max(-40, Math.min(40, eased));
}

export function stackPose(index: number): { scale: number; offsetY: number; opacity: number } {
  if (index <= 0) return { scale: 1, offsetY: 0, opacity: 1 };
  if (index === 1) return { scale: 0.97, offsetY: 6, opacity: 0.7 };
  return { scale: 0.94, offsetY: 12, opacity: 0.45 };
}

export interface PassSummary {
  seen: number;
  later: number;
  archived: number;
  approved: number;
  denied: number;
}
export const EMPTY_PASS: PassSummary = { seen: 0, later: 0, archived: 0, approved: 0, denied: 0 };

const TALLY_KEY: Record<Via, keyof PassSummary> = { seen: "seen", later: "later", archive: "archived", approve: "approved", deny: "denied" };

export function tally(s: PassSummary, via: Via, delta = 1): PassSummary {
  const key = TALLY_KEY[via];
  return { ...s, [key]: Math.max(0, s[key] + delta) };
}

export function passTotal(s: PassSummary): number {
  return s.seen + s.later + s.archived + s.approved + s.denied;
}

export function summaryLine(s: PassSummary): string {
  const parts: string[] = [];
  if (s.seen) parts.push(`${s.seen} read`);
  if (s.later) parts.push(`${s.later} later`);
  if (s.archived) parts.push(`${s.archived} archived`);
  if (s.approved) parts.push(`${s.approved} approved`);
  if (s.denied) parts.push(`${s.denied} denied`);
  return parts.join(" · ");
}

export type Dismissed = Map<string, string>;

export function dismiss(d: Dismissed, item: AttentionItem): Dismissed {
  const next = new Map(d);
  next.set(idOf(item), stampOf(item));
  return next;
}

export function restore(d: Dismissed, item: AttentionItem): Dismissed {
  const next = new Map(d);
  next.delete(idOf(item));
  return next;
}

export function visibleQueue(queue: AttentionItem[], dismissed: Dismissed): AttentionItem[] {
  return queue.filter((i) => dismissed.get(idOf(i)) !== stampOf(i));
}

export function pruneDismissed(d: Dismissed, items: AttentionItem[]): Dismissed {
  const live = new Map(inboxQueue(items).map((i) => [idOf(i), stampOf(i)]));
  const next: Dismissed = new Map();
  for (const [id, stamp] of d) if (live.get(id) === stamp) next.set(id, stamp);
  return next;
}

export function toFront(queue: AttentionItem[], id: string | null): AttentionItem[] {
  if (!id) return queue;
  const i = queue.findIndex((it) => idOf(it) === id);
  if (i <= 0) return queue;
  return [queue[i], ...queue.slice(0, i), ...queue.slice(i + 1)];
}

export type Role = "top" | "shell" | "leaving";

export function cardsToDraw(visible: AttentionItem[], leaving: AttentionItem | null): Array<{ item: AttentionItem; role: Role; index: number }> {
  return [
    ...(leaving ? [{ item: leaving, role: "leaving" as Role, index: -1 }] : []),
    ...visible
      .slice(0, 3)
      .filter((i) => !leaving || idOf(i) !== idOf(leaving))
      .map((item, index): { item: AttentionItem; role: Role; index: number } => ({ item, role: index === 0 ? "top" : "shell", index })),
  ];
}

export interface DeckState {
  dismissed: Dismissed;
  topId: string | null;
  held: AttentionItem | null;
  pass: PassSummary;
  resting: boolean;
}
export const EMPTY_DECK: DeckState = Object.freeze({ dismissed: new Map(), topId: null, held: null, pass: EMPTY_PASS, resting: false });

export function throughResting(s: DeckState): DeckState {
  return { ...EMPTY_DECK, pass: s.pass, resting: true };
}

export function canCommit(item: AttentionItem, via: Via): boolean {
  if (item.pendingApproval) return via === "approve" || via === "deny";
  return via === "seen" || via === "later" || (via === "archive" && archivable(item));
}

const same = (a: AttentionItem) => (b: AttentionItem) => idOf(a) === idOf(b);

export function deckQueue(items: AttentionItem[], s: DeckState): AttentionItem[] {
  const visible = visibleQueue(inboxQueue(items, s.resting), s.dismissed);
  const held = s.held ? (items.find(same(s.held)) ?? null) : null;
  return toFront(held && !visible.some(same(held)) ? [held, ...visible] : visible, s.topId);
}

export function commitCard(s: DeckState, item: AttentionItem, via: Via): DeckState {
  if (!canCommit(item, via)) return s;
  return { ...s, dismissed: dismiss(s.dismissed, item), topId: null, held: null, pass: tally(s.pass, via) };
}

export function undoCard(s: DeckState, item: AttentionItem, via: Via, wasHeld = false): DeckState {
  return { ...s, dismissed: restore(s.dismissed, item), topId: idOf(item), held: wasHeld ? item : s.held, pass: tally(s.pass, via, -1) };
}

export interface MoveLedger {
  made: (id: string) => number;
  takenBack: (id: string) => void;
  stands: (id: string, move: number) => boolean;
}

export function moveLedger(): MoveLedger {
  const standing = new Map<string, number>();
  let next = 0;
  return {
    made: (id) => {
      next += 1;
      standing.set(id, next);
      return next;
    },
    takenBack: (id) => {
      standing.delete(id);
    },
    stands: (id, move) => standing.get(id) === move,
  };
}

export function holdCard(s: DeckState, item: AttentionItem): DeckState {
  return { ...s, held: item, topId: idOf(item) };
}

export function reconcileDeck(s: DeckState, items: AttentionItem[], all: AttentionItem[] = items): DeckState {
  const pruned = pruneDismissed(s.dismissed, all);
  const dismissed = pruned.size === s.dismissed.size ? s.dismissed : pruned;
  const held = s.held && items.some(same(s.held)) ? s.held : null;
  const next = dismissed === s.dismissed && held === s.held ? s : { ...s, dismissed, held };
  const top = deckQueue(items, next).at(0);
  const topId = top ? idOf(top) : null;
  return topId === next.topId ? next : { ...next, topId };
}

export interface LaneChoice {
  id: string;
  name: string;
}

export function laneChoices(lanes: Lane[] | null, all: AttentionItem[]): LaneChoice[] {
  return [{ id: "", name: "Everything" }, ...(lanes ?? []).map(({ id, name }) => ({ id, name })), ...agentLanes(all).map(({ id, name }) => ({ id, name }))];
}

export function otherLanesLine(count: number): string | null {
  return count > 0 ? `${count} waiting in other lanes` : null;
}

export function cardNotice(item: Pick<AttentionItem, "status" | "agent_name">, chat: "idle" | "thinking" | "streaming"): string | null {
  const who = item.agent_name ?? "The agent";
  if (chat === "streaming") return `${who} is writing`;
  if (chat === "thinking" || item.status === "running") return `${who} is working`;
  if (item.status === "approval") return `${who} needs your approval`;
  if (item.status === "question") return `${who} asked you something`;
  if (item.status === "failed") return `${who}'s last turn failed`;
  return null;
}

export function threadNotice(
  item: Pick<AttentionItem, "status" | "agent_name"> | null | undefined,
  waiting: boolean,
  chat: "idle" | "thinking" | "streaming",
  agentName: string | null,
): string | null {
  if (item && waiting) return cardNotice(item, chat);
  if (chat !== "idle") return cardNotice({ status: "done", agent_name: item?.agent_name ?? agentName }, chat);
  return null;
}

const DONE: Record<Via, string> = { seen: "Marked read", later: "Saved for later", archive: "Archived", approve: "Approved", deny: "Denied" };

export function reviewAnnouncement(via: Via, next: Pick<AttentionItem, "title" | "id"> | undefined, left: number): string {
  if (!next || left <= 0) return `${DONE[via]}. You've been through every chat.`;
  return `${DONE[via]}. Next: ${next.title ?? next.id}.`;
}

export interface CardMoves {
  read: (item: AttentionItem, via?: CardVia) => Promise<MoveResult>;
  later: (item: AttentionItem, via?: CardVia, until?: string) => Promise<MoveResult>;
  archive: (item: AttentionItem, via?: CardVia) => Promise<string | null>;
  undo: (item: AttentionItem) => Promise<string | null>;
}

export interface MoveOutcome {
  error: string | null;
  ask: boolean;
}

const FAILED: Record<Move, string> = { seen: "Not marked read", later: "Not saved for later", archive: "Not archived" };

export async function makeMove(moves: CardMoves, item: AttentionItem, move: Move, how: "swipe" | "tap", until?: string): Promise<MoveOutcome> {
  const said = (err: string | null) => (err ? `${FAILED[move]}: ${err}` : null);
  if (move === "archive") return { error: said(await moves.archive(item, how)), ask: false };
  const r = move === "seen" ? await moves.read(item, how) : await moves.later(item, how, until);
  return { error: said(r.error), ask: r.ask };
}

export async function undoMove(moves: CardMoves, item: AttentionItem): Promise<string | null> {
  const err = await moves.undo(item);
  if (!err) return null;
  return err === "handed off" ? "Handed off, not undone" : `Not undone: ${err}`;
}

export interface ReturnChoice {
  label: string;
  until: string;
}

export const MORNING_HOUR = 8;
export const LATER_TODAY_MS = 3 * 60 * 60_000;

const morning = (now: Date, days: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, MORNING_HOUR, 0, 0, 0);

export function returnChoices(now: Date): ReturnChoice[] {
  const soon = new Date(now.getTime() + LATER_TODAY_MS);
  const today = soon.getDate() === now.getDate() ? [{ label: "Later today", until: soon.toISOString() }] : [];
  const toMonday = (8 - now.getDay()) % 7 || 7;
  return [
    ...today,
    { label: "Tomorrow", until: morning(now, 1).toISOString() },
    { label: "In 3 days", until: morning(now, 3).toISOString() },
    { label: "Next week", until: morning(now, toMonday).toISOString() },
  ];
}

export function dateChoice(day: string, now: Date): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), MORNING_HOUR, 0, 0, 0);
  return Number.isNaN(at.getTime()) || at.getTime() < morning(now, 1).getTime() ? null : at.toISOString();
}
