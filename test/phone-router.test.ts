import { describe, expect, test } from "bun:test";
import { HOME, formatRoute, isOverlay, parseRoute, tabOf, type Route } from "../app/src/phone/router.ts";

/**
 * The phone's hash routes (app/src/phone/router.ts): every route both ways, file paths with slashes
 * and encoded slashes, conversation ids the app-server mints locally, and the fallback to home.
 */

const roundTrip = (r: Route) => expect(parseRoute(formatRoute(r))).toEqual(r);

describe("tabs", () => {
  test("each tab formats and parses", () => {
    for (const tab of ["home", "inbox", "agents", "settings"] as const) {
      expect(formatRoute({ kind: "tab", tab })).toBe(`#/${tab}`);
      roundTrip({ kind: "tab", tab });
    }
  });
  test("an empty or unknown hash is home", () => {
    expect(parseRoute("")).toEqual(HOME);
    expect(parseRoute("#")).toEqual(HOME);
    expect(parseRoute("#/")).toEqual(HOME);
    expect(parseRoute("#/nowhere")).toEqual(HOME);
    expect(parseRoute("#/home/extra")).toEqual(HOME);
    expect(parseRoute("#/c/only-agent")).toEqual(HOME); // a conversation needs both ids
  });
  test("the leading # is optional", () => {
    expect(parseRoute("/inbox")).toEqual({ kind: "tab", tab: "inbox" });
  });
});

describe("agents", () => {
  test("an agent page", () => {
    expect(formatRoute({ kind: "agent", agentId: "agent-abc123" })).toBe("#/agents/agent-abc123");
    roundTrip({ kind: "agent", agentId: "agent-abc123" });
  });
  test("a file: path segments stay readable, each encoded", () => {
    const r: Route = { kind: "file", agentId: "agent-abc123", path: "system/persona.md" };
    expect(formatRoute(r)).toBe("#/agents/agent-abc123/file/system/persona.md");
    roundTrip(r);
  });
  test("deeper paths and spaces", () => {
    const r: Route = { kind: "file", agentId: "a1", path: "reference/notes/my notes.md" };
    expect(formatRoute(r)).toBe("#/agents/a1/file/reference/notes/my%20notes.md");
    roundTrip(r);
  });
  test("a %2F in the address is a slash in the path", () => {
    expect(parseRoute("#/agents/a1/file/system%2Fpersona.md")).toEqual({ kind: "file", agentId: "a1", path: "system/persona.md" });
    expect(parseRoute("#/agents/a1/file/reference%2Fdeep%2Fnote.md")).toEqual({ kind: "file", agentId: "a1", path: "reference/deep/note.md" });
  });
  test("a skill's SKILL.md", () => {
    roundTrip({ kind: "file", agentId: "a1", path: "skills/loki/SKILL.md" });
  });
  test("/file with no path is the agent page; an unknown sub-page too", () => {
    expect(parseRoute("#/agents/a1/file")).toEqual({ kind: "agent", agentId: "a1" });
    expect(parseRoute("#/agents/a1/other")).toEqual({ kind: "agent", agentId: "a1" });
  });
  test("a bad percent sequence does not throw", () => {
    expect(parseRoute("#/agents/a1/file/%E0%A4%A")).toEqual({ kind: "file", agentId: "a1", path: "%E0%A4%A" });
  });
});

describe("conversations", () => {
  test("agent and conversation ids", () => {
    const r: Route = { kind: "conversation", agentId: "agent-9f2c", conversationId: "local-conv-1725700000000-x7k2", prefill: null };
    expect(formatRoute(r)).toBe("#/c/agent-9f2c/local-conv-1725700000000-x7k2");
    roundTrip(r);
  });
  test("the main chat is `default`", () => {
    roundTrip({ kind: "conversation", agentId: "agent-9f2c", conversationId: "default", prefill: null });
  });
  test("a prefill rides in the query and comes back verbatim", () => {
    const r: Route = { kind: "conversation", agentId: "a1", conversationId: "default", prefill: "Please update system/persona.md: " };
    expect(formatRoute(r)).toBe("#/c/a1/default?prefill=Please%20update%20system%2Fpersona.md%3A%20");
    roundTrip(r);
  });
  test("an empty prefill is none", () => {
    expect(parseRoute("#/c/a1/default?prefill=")).toEqual({ kind: "conversation", agentId: "a1", conversationId: "default", prefill: null });
  });
});

describe("tab of / overlay", () => {
  test("pages belong to their tab; a conversation to none", () => {
    expect(tabOf({ kind: "tab", tab: "settings" })).toBe("settings");
    expect(tabOf({ kind: "agent", agentId: "a" })).toBe("agents");
    expect(tabOf({ kind: "file", agentId: "a", path: "x" })).toBe("agents");
    expect(tabOf({ kind: "conversation", agentId: "a", conversationId: "c", prefill: null })).toBeNull();
  });
  test("only the four tabs show the bar", () => {
    expect(isOverlay(HOME)).toBe(false);
    expect(isOverlay({ kind: "agent", agentId: "a" })).toBe(true);
    expect(isOverlay({ kind: "conversation", agentId: "a", conversationId: "c", prefill: null })).toBe(true);
  });
});
