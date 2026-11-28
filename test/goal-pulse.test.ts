import { afterAll, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GOAL_CHECKIN_CHAT_TITLE } from "../core/goals.ts";
import type { TranscriptRow } from "../core/attention/transcript.ts";
import { GoalPulse } from "../daemon/goal-pulse.ts";
import { GoalsStore } from "../daemon/goals-store.ts";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "loki-goal-pulse-"));
  dirs.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function setup(initialNow: string) {
  const dir = tempDir();
  let now = new Date(initialNow);
  const store = new GoalsStore(join(dir, "goals.json"), () => now);
  const chatsMap = new Map<string, { agentId: string; title: string; rows: TranscriptRow[] }>();
  const delivered: Array<{ agentId: string; chatId: string; text: string }> = [];

  const pulse = new GoalPulse({
    store,
    agents: () => [{ id: "agent-a", name: "Ada" }],
    chats: {
      list: () =>
        [...chatsMap.entries()].map(([conversationId, c]) => ({
          conversationId,
          agentId: c.agentId,
          archived: false,
          hidden: false,
          lastMessageAt: c.rows.at(-1)?.at ?? null,
        })),
      info: (conversationId) => {
        const c = chatsMap.get(conversationId);
        return c
          ? {
              agentId: c.agentId,
              title: c.title,
              lastMessageAt: c.rows.at(-1)?.at ?? null,
              archived: false,
              model: null,
              reasoningEffort: null,
              mode: "unrestricted",
              labels: [],
              purpose: null,
              hasDraft: false,
              draftText: null,
              cwd: dir,
            }
          : null;
      },
      since: (conversationId) => {
        const rows = chatsMap.get(conversationId)?.rows ?? [];
        return { rows, lines: rows.length };
      },
    },
    createChat: (agentId, _cwd, title) => {
      const conversationId = `chat-${chatsMap.size + 1}`;
      chatsMap.set(conversationId, { agentId, title: title ?? "Untitled", rows: [] });
      return Promise.resolve({ agentId, conversationId });
    },
    deliver: (agentId, chatId, text) => {
      delivered.push({ agentId, chatId, text });
      const entry = chatsMap.get(chatId);
      if (entry) entry.rows.push({ role: "assistant", text: "Check-in message", at: now.toISOString() });
      return Promise.resolve({ outcome: Promise.resolve({ status: "done" as const }) });
    },
    busy: () => Promise.resolve(false),
    defaultCwd: dir,
    now: () => now,
  });

  return {
    store,
    pulse,
    chatsMap,
    delivered,
    setNow: (iso: string) => {
      now = new Date(iso);
    },
  };
}

describe("GoalPulse proactive loop", () => {
  test("respects quiet hours and sends daily focus outside quiet hours", async () => {
    // 2026-11-24 is Tuesday; weekly_day defaults to Monday (1), so Tuesday triggers daily focus.
    const s = setup("2026-11-24T22:00:00.000Z");
    s.store.setSettings({ timezone: "UTC", quiet_start: 21, quiet_end: 8, daily_hour: 9, weekly_day: 1 });
    s.store.create({ title: "Finish proposal", horizon: "short", next_step: "Draft executive summary" });

    expect(await s.pulse.tick()).toBe(false);
    expect(s.delivered).toHaveLength(0);

    s.setNow("2026-11-25T10:00:00.000Z");
    expect(await s.pulse.tick()).toBe(true);
    expect(s.delivered).toHaveLength(1);
    expect(s.delivered[0].text).toContain("Finish proposal");
    expect(s.chatsMap.get(s.delivered[0].chatId)?.title).toBe(GOAL_CHECKIN_CHAT_TITLE);
  });

  test("anti-nagging skips automatic follow-up when previous nudge has not been answered", async () => {
    const s = setup("2026-11-24T10:00:00.000Z");
    s.store.setSettings({ timezone: "UTC", quiet_start: 21, quiet_end: 8, daily_hour: 9, weekly_day: 1 });
    s.store.create({ title: "Ship feature", horizon: "short" });

    expect(await s.pulse.tick()).toBe(true);
    expect(s.delivered).toHaveLength(1);

    // Next day (>24h cooldown passed), still unanswered assistant message in chat -> skips!
    s.setNow("2026-11-25T11:00:00.000Z");
    expect(await s.pulse.tick()).toBe(false);
    expect(s.delivered).toHaveLength(1);

    // User replies -> next tick proceeds!
    const chat = s.chatsMap.get(s.delivered[0].chatId);
    chat?.rows.push({ role: "user", text: "On it today", at: "2026-11-25T12:00:00.000Z" });
    s.setNow("2026-11-25T13:00:00.000Z");
    expect(await s.pulse.tick()).toBe(true);
    expect(s.delivered).toHaveLength(2);
  });

  test("triggers weekly review on weekly_day and supports manual runNow", async () => {
    // 2026-11-23 is Monday
    const s = setup("2026-11-23T10:00:00.000Z");
    s.store.setSettings({ timezone: "UTC", weekly_day: 1, weekly_hour: 9, autonomy: "nudge_only" });
    const g = s.store.create({ title: "Exercise 3x", horizon: "medium" });

    expect(await s.pulse.tick()).toBe(true);
    expect(s.delivered[0].text).toContain("Goal partner weekly review");
    expect(s.delivered[0].text).toContain("2-minute");

    const manual = await s.pulse.runNow({ kind: "goal", goalId: g.id });
    expect(manual.note).toContain("Exercise 3x");
    expect(s.delivered).toHaveLength(2);
    expect(s.delivered[1].text).toContain('Goal check-in for "Exercise 3x"');
  });
});
