export const CATCH_UP_SHORTCUT = "Alt+Space";
export const TRAFFIC_LIGHTS_AT = { x: 20, y: 19 };

const LIGHT = 14;
const LIGHT_GAP = 6;

export interface WaitingMarks {
  title: string;
  tooltip: string;
  badge: number;
}

export function waitingMarks(count: number): WaitingMarks {
  return count > 0 ? { title: String(count), tooltip: `loki · ${count} waiting`, badge: count } : { title: "", tooltip: "loki", badge: 0 };
}

/** Where the Mac's window buttons sit, as `traffic_lights` answers the page: the close button's left edge, the zoom button's right edge, and their middle, in points from the window's top-left corner. */
export function trafficLights(at: { x: number; y: number } | null): { left: number; right: number; middle: number } | null {
  if (!at) return null;
  return { left: at.x, right: at.x + 3 * LIGHT + 2 * LIGHT_GAP, middle: at.y + LIGHT / 2 };
}

export interface ShortcutHost {
  register: (accelerator: string, callback: () => void) => boolean;
  unregister: (accelerator: string) => void;
  isRegistered: (accelerator: string) => boolean;
}

export function setCatchUpShortcut(host: ShortcutHost, enabled: boolean, catchUp: () => void): void {
  if (host.isRegistered(CATCH_UP_SHORTCUT)) host.unregister(CATCH_UP_SHORTCUT);
  if (enabled && !host.register(CATCH_UP_SHORTCUT, catchUp)) throw new Error("Option-Space is taken by another app");
}
