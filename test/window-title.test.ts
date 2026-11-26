import { describe, expect, test } from "vitest";
import { windowTitle } from "../app/src/shell/use-window-chrome.ts";

const desk = { title: "notes", status: "live", scope: "ira/notes", agentName: "ira" } as const;

describe("the window title", () => {
  test("Flow carries the active lane's name and its count", () => {
    expect(windowTitle(desk, "flow", 1, 0, "Work")).toEqual({ name: "Flow · Work · 1 waiting", document: "Flow · Work · 1 waiting" });
    expect(windowTitle(desk, "flow", 0, 0, "Work").name).toBe("Flow · Work");
  });
  test("a lane its times made due says until when, between the lane and the count", () => {
    expect(windowTitle(desk, "flow", 3, 0, "Comms", "16:30").name).toBe("Flow · Comms · until 16:30 · 3 waiting");
    expect(windowTitle(desk, "flow", 0, 0, "Comms", "4:30 PM").name).toBe("Flow · Comms · until 4:30 PM");
    expect(windowTitle(desk, "flow", 3, 0, "Reading", null).name).toBe("Flow · Reading · 3 waiting");
    expect(windowTitle(desk, "chats", 3, 0, "Comms", "16:30").name).toBe("ira · notes");
  });
  test("Everything reads as before", () => {
    expect(windowTitle(desk, "flow", 3, 0, null).name).toBe("Flow · 3 waiting");
    expect(windowTitle(desk, "flow", 0, 0, null).name).toBe("Flow");
  });
  test("elsewhere the lane's count prefixes the tab title", () => {
    expect(windowTitle(desk, "chats", 1, 0, "Work")).toEqual({ name: "ira · notes", document: "(1) ira · notes" });
    expect(windowTitle(desk, "learn", 0, 2, null)).toEqual({ name: "Learn · 2 due", document: "Learn · 2 due" });
  });
});
