import { describe, expect, test } from "vitest";
import { windowTitle } from "../app/src/shell/use-window-chrome.ts";

/** The window title (plan 085, KTD10): Flow names its lane, so the person can tell which lane the dock badge counts. */

const desk = { title: "notes", status: "live", scope: "ira/notes", agentName: "ira" } as const;

describe("the window title", () => {
  test("Flow carries the active lane's name and its count", () => {
    expect(windowTitle(desk, "inbox", 1, 0, "Work")).toEqual({ name: "Flow · Work · 1 waiting", document: "Flow · Work · 1 waiting" });
    expect(windowTitle(desk, "inbox", 0, 0, "Work").name).toBe("Flow · Work");
  });
  test("Everything reads as before", () => {
    expect(windowTitle(desk, "inbox", 3, 0, null).name).toBe("Flow · 3 waiting");
    expect(windowTitle(desk, "inbox", 0, 0, null).name).toBe("Flow");
  });
  test("elsewhere the lane's count prefixes the tab title", () => {
    expect(windowTitle(desk, "desk", 1, 0, "Work")).toEqual({ name: "ira · notes", document: "(1) ira · notes" });
    expect(windowTitle(desk, "learn", 0, 2, null)).toEqual({ name: "Learn · 2 due", document: "Learn · 2 due" });
  });
});
