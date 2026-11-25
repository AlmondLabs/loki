import { describe, expect, test } from "vitest";
import { CATCH_UP_SHORTCUT, setCatchUpShortcut, trafficLights, waitingMarks, type ShortcutHost } from "../desktop/tray.ts";

function fakeShortcuts(free = true) {
  const registered = new Set<string>();
  const host: ShortcutHost = {
    register: (a) => {
      if (!free) return false;
      registered.add(a);
      return true;
    },
    unregister: (a) => void registered.delete(a),
    isRegistered: (a) => registered.has(a),
  };
  return { host, registered };
}

describe("the Mac's waiting marks", () => {
  test("nothing waiting clears the tray title and the badge", () => {
    expect(waitingMarks(0)).toEqual({ title: "", tooltip: "loki", badge: 0 });
  });

  test("three waiting show on the tray, its tooltip and the dock", () => {
    expect(waitingMarks(3)).toEqual({ title: "3", tooltip: "loki · 3 waiting", badge: 3 });
  });
});

describe("the window buttons and the catch-up shortcut", () => {
  test("the lights answer their left edge, right edge and middle; no lights answer null", () => {
    expect(trafficLights({ x: 20, y: 19 })).toEqual({ left: 20, right: 74, middle: 26 });
    expect(trafficLights(null)).toBeNull();
  });

  test("Option-Space is switched on and off", () => {
    const { host, registered } = fakeShortcuts();
    setCatchUpShortcut(host, true, () => {});
    expect(registered.has(CATCH_UP_SHORTCUT)).toBe(true);
    setCatchUpShortcut(host, false, () => {});
    expect(registered.size).toBe(0);
  });

  test("a shortcut another app holds answers an error the page shows", () => {
    expect(() => setCatchUpShortcut(fakeShortcuts(false).host, true, () => {})).toThrow("Option-Space is taken by another app");
  });
});
