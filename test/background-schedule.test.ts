import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundTasks, shell } from "../daemon/background.ts";
import { dueBetween, matches, parseCron, Schedules } from "../daemon/schedule.ts";
import { extractHarnessEvents } from "../core/harness.ts";

describe("background tasks", () => {
  test("a task's output is read in pieces, and its end sends one notice the thread shows as an event", async () => {
    const notices: Array<{ chatId: string; text: string }> = [];
    const tasks = new BackgroundTasks((_a, chatId, text) => notices.push({ chatId, text }));
    const id = tasks.start("agent-a", "c", tmpdir(), "echo first; sleep 0.2; echo second");
    expect(await tasks.wait(id, "agent-a", "first", 2000)).toContain("first");
    const rest = await tasks.wait(id, "agent-a", undefined, 3000);
    expect(rest).toContain("[exited with 0]");
    expect(rest).toContain("second");
    expect(rest).not.toContain("first");
    await new Promise((r) => setTimeout(r, 50));
    expect(notices).toHaveLength(1);
    expect(notices[0].chatId).toBe("c");
    const [event] = extractHarnessEvents(notices[0].text);
    expect(event.text).toBe(`background task ${id} completed`);
  });

  test("a task takes input, can be stopped, and another agent cannot reach it", async () => {
    const notices: string[] = [];
    const tasks = new BackgroundTasks((_a, _c, text) => notices.push(text));
    // `sleep` stays a child of the shell in every shell (the echo after it keeps zsh from exec'ing it) and holds the
    // output open: a stop must end it too, not only the shell.
    const id = tasks.start("agent-a", "c", tmpdir(), "read line; echo got $line; sleep 30; echo after");
    tasks.write(id, "agent-a", "hello\n");
    expect(await tasks.wait(id, "agent-a", "got hello", 2000)).toContain("got hello");
    expect(() => tasks.output(id, "agent-b")).toThrow("no background task");
    tasks.stop(id, "agent-a");
    expect(await tasks.wait(id, "agent-a", undefined, 3000)).toContain("[stopped (SIGTERM)]");
    await new Promise((r) => setTimeout(r, 50));
    expect(notices[0]).toContain("<status>stopped (SIGTERM)</status>");
  });
});

describe("a task's shell", () => {
  test("the person's own, else /bin/sh; on Windows Git Bash where Git for Windows puts it, else bash.exe on PATH", () => {
    expect(shell({ SHELL: "/bin/zsh" }, "darwin")).toBe("/bin/zsh");
    expect(shell({}, "linux")).toBe("/bin/sh");
    const gitBash = join("C:\\Program Files", "Git", "bin", "bash.exe");
    expect(shell({ ProgramFiles: "C:\\Program Files" }, "win32", (p) => p === gitBash)).toBe(gitBash);
    expect(shell({ ProgramFiles: "C:\\Program Files", SHELL: "/usr/bin/bash" }, "win32", () => false)).toBe("bash.exe");
  });
});

describe("cron", () => {
  test("fields, ranges, steps and lists; day-of-month or day-of-week when both are given", () => {
    const f = parseCron("*/15 9-17 * * 1-5");
    expect(matches(f, new Date("2026-10-12T09:30:00Z"), "UTC")).toBe(true); // a Monday
    expect(matches(f, new Date("2026-10-11T09:30:00Z"), "UTC")).toBe(false); // a Sunday
    expect(matches(f, new Date("2026-10-12T09:31:00Z"), "UTC")).toBe(false);
    const either = parseCron("0 9 1 * 0");
    expect(matches(either, new Date("2026-10-01T09:00:00Z"), "UTC")).toBe(true); // the 1st, a Thursday
    expect(matches(either, new Date("2026-10-11T09:00:00Z"), "UTC")).toBe(true); // a Sunday
    expect(() => parseCron("61 * * * *")).toThrow();
    expect(() => parseCron("* * *")).toThrow("five fields");
  });

  test("a schedule is read in its own timezone", () => {
    // 9:00 in Kolkata is 03:30 UTC.
    expect(matches(parseCron("0 9 * * *"), new Date("2026-10-12T03:30:00Z"), "Asia/Kolkata")).toBe(true);
    expect(matches(parseCron("0 9 * * *"), new Date("2026-10-12T09:00:00Z"), "Asia/Kolkata")).toBe(false);
  });

  test("a slot is due when one falls after the last firing and up to now", () => {
    const daily = parseCron("0 9 * * *");
    expect(dueBetween(daily, "UTC", new Date("2026-10-12T08:00:00Z"), new Date("2026-10-12T09:00:00Z"))).toBe(true);
    expect(dueBetween(daily, "UTC", new Date("2026-10-12T09:00:00Z"), new Date("2026-10-12T09:30:00Z"))).toBe(false);
  });
});

describe("scheduled tasks", () => {
  test("a due task fires once, prefixed so the Inbox knows it; a one-off is then done; slots missed while closed fire once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-crons-"));
    try {
      const fired: string[] = [];
      const schedules = new Schedules(join(dir, "crons.json"), async (_a, chatId, text) => void fired.push(`${chatId}: ${text}`));
      const made = new Date("2026-10-10T00:00:00Z");
      schedules.create({ agent_id: "agent-a", conversation_id: "default", name: "standup", description: null, cron: "0 9 * * *", timezone: "UTC", recurring: true, prompt: "post the standup" }, made);
      schedules.create({ agent_id: "agent-a", conversation_id: "c", name: "once", description: null, cron: "30 9 10 10 *", timezone: "UTC", recurring: false, prompt: "remind me" }, made);
      expect(await schedules.tick(new Date("2026-10-10T08:59:00Z"))).toBe(0);
      expect(await schedules.tick(new Date("2026-10-10T09:00:00Z"))).toBe(1);
      expect(fired).toEqual(['default: Scheduled task "standup": post the standup']);
      // Closed for three days: each task fires once, not once per missed slot.
      expect(await schedules.tick(new Date("2026-10-13T12:00:00Z"))).toBe(2);
      expect(fired.slice(1).sort()).toEqual(['c: Scheduled task "once": remind me', 'default: Scheduled task "standup": post the standup']);
      expect(schedules.list().map((t) => [t.name, t.status, t.fire_count])).toEqual([["standup", "active", 2], ["once", "done", 1]]);
      expect(schedules.cancel("agent-a", "standup")).toBe(true);
      expect(schedules.cancel("agent-b", "once")).toBe(false);
      expect(await schedules.tick(new Date("2026-10-14T09:00:00Z"))).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a bad cron expression or timezone is refused when the task is made", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-crons-"));
    try {
      const schedules = new Schedules(join(dir, "crons.json"), async () => {});
      const base = { agent_id: "a", conversation_id: "c", name: "x", description: null, recurring: true, prompt: "p" };
      expect(() => schedules.create({ ...base, cron: "every day", timezone: "UTC" })).toThrow();
      expect(() => schedules.create({ ...base, cron: "0 9 * * *", timezone: "Mars/Olympus" })).toThrow();
      expect(schedules.list()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
