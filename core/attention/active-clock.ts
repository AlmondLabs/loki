export interface ActiveClock {
  now(): number;
  running(): boolean;
  set(active: boolean): void;
}

export function createActiveClock(wall: () => number = Date.now, active = true): ActiveClock {
  let total = 0;
  let since: number | null = active ? wall() : null;
  return {
    now: () => total + (since === null ? 0 : wall() - since),
    running: () => since !== null,
    set(on) {
      if (on && since === null) since = wall();
      else if (!on && since !== null) {
        total += wall() - since;
        since = null;
      }
    },
  };
}

export type Activity = (set: (active: boolean) => void) => () => void;
