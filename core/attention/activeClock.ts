/**
 * A clock that runs only while loki is in front of you (the app says when: its window visible and focused). An Inbox card's dwell
 * (inbox_card_shown → inbox_card_decided) is read off it, so a card left on screen while you were away does not
 * count the hours you were gone.
 */
export interface ActiveClock {
  /** Milliseconds of active time so far. */
  now(): number;
  /** Whether the clock is running. */
  running(): boolean;
  /** The window went to the back, was hidden, or came forward again. */
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

/** Reports the window coming forward (true) or going away (false), calling back at once with the state now; returns the unsubscribe. The app supplies it (app/src/shared/pageActivity.ts). */
export type Activity = (set: (active: boolean) => void) => () => void;
