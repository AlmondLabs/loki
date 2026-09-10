import type { DeskState, Gesture, Scope } from "../core/desk-core.ts";
import { SHARED_SCOPE, applyGesture, applyMeasure, arrangeLayout, clearOverlay, emptyDesk, ensureLayout, forgetWidget, occupiedRects, reveal } from "../core/desk-core.ts";
import type { Size } from "../core/desk-core.ts";

export type StoreListener = (scope: Scope, state: DeskState) => void;

/**
 * Server-owned desk state, one entry per scope. Holds only what gestures
 * produce: geometry and data overrides. Widget content lives in files.
 */
export class DeskStore {
  private desks = new Map<Scope, DeskState>();
  private listeners = new Set<StoreListener>();

  get(scope: Scope): DeskState {
    return this.desks.get(scope) ?? emptyDesk(scope);
  }

  scopes(): Scope[] {
    return [...this.desks.keys()];
  }

  /** Install a loaded snapshot without notifying. */
  load(state: DeskState): void {
    this.desks.set(state.scope, state);
  }

  gesture(scope: Scope, g: Gesture): DeskState {
    return this.commit(scope, applyGesture(this.get(scope), g));
  }

  /**
   * Everything a new widget must avoid. A conversation desk shows its own widgets
   * plus the shared ones. A shared widget appears on every desk, so it must
   * avoid every desk's widgets.
   */
  private obstacles(scope: Scope) {
    if (scope === SHARED_SCOPE) return [...this.desks.values()].flatMap(occupiedRects);
    return [...occupiedRects(this.get(scope)), ...occupiedRects(this.get(SHARED_SCOPE))];
  }

  /** A widget file appeared: give it the first free spot on the desk. */
  seen(scope: Scope, id: string): DeskState {
    return this.commit(scope, ensureLayout(this.get(scope), id, this.obstacles(scope)));
  }

  /** A widget file was deleted: drop its geometry and overrides. */
  forget(scope: Scope, id: string): DeskState {
    return this.commit(scope, forgetWidget(this.get(scope), id));
  }

  /** The tab measured a widget's rendered size. */
  measure(scope: Scope, id: string, size: Size): DeskState {
    return this.commit(scope, applyMeasure(this.get(scope), id, size));
  }

  /** Tidy a desk's own widgets into a packed grid around the shared ones. */
  arrange(scope: Scope): DeskState {
    const fixed = scope === SHARED_SCOPE ? [] : occupiedRects(this.get(SHARED_SCOPE));
    return this.commit(scope, arrangeLayout(this.get(scope), fixed));
  }

  /** A widget file changed: the agent's write is the latest intent. */
  fileChanged(scope: Scope, id: string): DeskState {
    return this.commit(scope, reveal(clearOverlay(this.get(scope), id), id));
  }

  subscribe(fn: StoreListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private commit(scope: Scope, next: DeskState): DeskState {
    const prev = this.desks.get(scope);
    if (prev === next) return next;
    this.desks.set(scope, next);
    for (const fn of this.listeners) fn(scope, next);
    return next;
  }
}
