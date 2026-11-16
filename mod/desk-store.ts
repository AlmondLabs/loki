import type { DeskState, Gesture, Scope } from "../core/desk-core.ts";
import {
  SHARED_SCOPE,
  applyGesture,
  applyMeasure,
  arrangeLayout,
  clearOverlay,
  emptyDesk,
  ensureLayout,
  forgetWidget,
  occupiedRects,
  reveal,
} from "../core/desk-core.ts";
import type { Size } from "../core/desk-core.ts";
import { Listeners } from "../core/listeners.ts";

export type StoreListener = (scope: Scope, state: DeskState) => void;

export class DeskStore {
  private desks = new Map<Scope, DeskState>();
  private listeners = new Listeners<Parameters<StoreListener>>();

  get(scope: Scope): DeskState {
    return this.desks.get(scope) ?? emptyDesk(scope);
  }

  scopes(): Scope[] {
    return [...this.desks.keys()];
  }

  load(state: DeskState): void {
    this.desks.set(state.scope, state);
  }

  gesture(scope: Scope, g: Gesture): DeskState {
    return this.commit(scope, applyGesture(this.get(scope), g));
  }

  private obstacles(scope: Scope) {
    if (scope === SHARED_SCOPE) return [...this.desks.values()].flatMap(occupiedRects);
    return [...occupiedRects(this.get(scope)), ...occupiedRects(this.get(SHARED_SCOPE))];
  }

  seen(scope: Scope, id: string): DeskState {
    return this.commit(scope, ensureLayout(this.get(scope), id, this.obstacles(scope)));
  }

  forget(scope: Scope, id: string): DeskState {
    return this.commit(scope, forgetWidget(this.get(scope), id));
  }

  measure(scope: Scope, id: string, size: Size): DeskState {
    return this.commit(scope, applyMeasure(this.get(scope), id, size));
  }

  arrange(scope: Scope): DeskState {
    const fixed = scope === SHARED_SCOPE ? [] : occupiedRects(this.get(SHARED_SCOPE));
    return this.commit(scope, arrangeLayout(this.get(scope), fixed));
  }

  fileChanged(scope: Scope, id: string): DeskState {
    return this.commit(scope, reveal(clearOverlay(this.get(scope), id), id));
  }

  subscribe(fn: StoreListener): () => void {
    return this.listeners.add(fn);
  }

  private commit(scope: Scope, next: DeskState): DeskState {
    const prev = this.desks.get(scope);
    if (prev === next) return next;
    this.desks.set(scope, next);
    this.listeners.emit(scope, next);
    return next;
  }
}
