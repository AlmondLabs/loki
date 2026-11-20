import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Approvals, kindOf } from "../daemon/approvals.ts";
import { BackgroundTasks } from "../daemon/background.ts";
import { builtinExtensions, builtinKinds } from "../daemon/extensions.ts";
import { Schedules } from "../daemon/schedule.ts";

function builtins() {
  const dir = mkdtempSync(join(tmpdir(), "loki-extensions-"));
  const approvals = new Approvals();
  const extensions = builtinExtensions({
    approvals,
    backendDir: dir,
    background: new BackgroundTasks(() => {}),
    schedules: new Schedules(join(dir, "crons.json"), () => Promise.resolve(null)),
    history: { thread: () => [], compactedSince: () => false },
  });
  return { extensions, dir };
}

describe("the built-in tools", () => {
  test("the permission gate is installed first, and these are the tools every chat has", () => {
    const { extensions, dir } = builtins();
    try {
      expect(extensions[0]?.name).toBe("loki.approvals");
      expect(extensions.find((e) => e.name === "loki.replies")?.sections?.length).toBe(1);
      const names = extensions.flatMap((e) => (e.tools ?? []).map((t) => t.name));
      expect(new Set(names).size).toBe(names.length);
      expect(names.sort()).toEqual(
        [
          "user_ask",
          "background_run",
          "background_watch",
          "bash",
          "edit",
          "find",
          "grep",
          "history_read",
          "history_search",
          "ls",
          "memory_delete",
          "memory_edit",
          "memory_read",
          "memory_write",
          "read",
          "schedule_create",
          "schedule_delete",
          "schedule_list",
          "subagent",
          "web_search",
          "write",
        ].sort(),
      );
      const scriptsOnly = extensions.flatMap((e) => e.tools ?? []).filter((t) => t.callers?.includes("model") === false);
      expect(scriptsOnly.map((t) => t.name).sort()).toEqual(
        ["find", "grep", "history_read", "history_search", "ls", "schedule_create", "schedule_delete", "schedule_list"].sort(),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("every built-in tool declares its kind; none falls back to a command for want of one", () => {
    const { extensions, dir } = builtins();
    try {
      const kinds = builtinKinds(extensions);
      const names = extensions.flatMap((e) => (e.tools ?? []).map((t) => t.name));
      expect(names.filter((n) => !kinds.has(n))).toEqual([]);
      expect(Object.fromEntries([...kinds].filter(([, k]) => k !== "read"))).toEqual({
        background_run: "command",
        bash: "command",
        edit: "edit",
        schedule_create: "command",
        schedule_delete: "command",
        write: "edit",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("every name is snake_case", () => {
    const { extensions, dir } = builtins();
    try {
      const names = extensions.flatMap((e) => (e.tools ?? []).map((t) => t.name));
      expect(names.filter((n) => !/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(n))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a tool that is not loki's: pi-durable's by name, a mod's or MCP's by its annotations, else a command", () => {
    expect(kindOf("write")).toBe("edit");
    expect(kindOf("mcp__github__list_issues", { readOnly: true })).toBe("read");
    expect(kindOf("mcp__github__create_issue")).toBe("command");
  });
});
