import { afterAll, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRAMES } from "../core/frames.ts";
import { GoalsStore } from "../daemon/goals-store.ts";
import type { ModuleDeps } from "../mod/frames/index.ts";
import { bridgeWith, client, settled } from "./fixtures/frames.ts";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "loki-goals-frames-"));
  dirs.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("goals frame parsers", () => {
  test("reject invalid payloads cleanly and accept valid ones", () => {
    expect(FRAMES.goals_create.parse({})).toBe("title required");
    expect(FRAMES.goals_create.parse({ title: "Run 5k", horizon: "forever" })).toBe("horizon must be short, medium, or long");
    expect(FRAMES.goals_create.parse({ title: "Run 5k", horizon: "short", target_date: "tomorrow" })).toBe("target_date must be YYYY-MM-DD");
    expect(FRAMES.goals_create.parse({ title: "Run 5k", horizon: "short", lead_habit: { label: "Run", per_week: 9 } })).toBe(
      "lead_habit.per_week must be 1 to 7",
    );
    expect(FRAMES.goals_create.parse({ title: "Run 5k", horizon: "short", lead_habit: { label: "Run", per_week: 3 } })).toMatchObject({
      title: "Run 5k",
      horizon: "short",
      lead_habit: { label: "Run", per_week: 3 },
    });
    expect(FRAMES.goals_settings_set.parse({ daily_hour: 25 })).toBe("daily_hour must be 0 to 23");
    expect(FRAMES.goals_settings_set.parse({ autonomy: "yolo" })).toBe("autonomy must be prep_and_nudge or nudge_only");
    expect(FRAMES.goals_pulse_run.parse({ kind: "yearly" })).toBe("kind must be daily, weekly, or goal");
  });
});

describe("goals frame handlers", () => {
  test("CRUD, habit toggle, settings, pulse, work_start, and discover_start broadcast goals_changed", async () => {
    const dir = tempDir();
    const store = new GoalsStore(join(dir, "goals.json"));
    const createdChats: Array<{ agentId?: string | null; title: string }> = [];

    const deps = {
      goals: {
        store,
        runPulse: (opts?: { kind?: "daily" | "weekly" | "goal"; goalId?: string }) =>
          Promise.resolve({ note: `ran ${opts?.kind ?? "daily"}`, agent_id: "a1", conversation_id: "c-pulse" }),
        chatLive: () => false,
        startChat: (opts: { agentId?: string | null; title: string }) => {
          createdChats.push(opts);
          return Promise.resolve({ agent_id: opts.agentId ?? "a1", conversation_id: `conv-${createdChats.length}`, agent_name: "Ada" });
        },
      },
    } as unknown as ModuleDeps;

    const { bridge, broadcasts } = bridgeWith(deps);
    const c = client("shared");
    const send = async (frame: Record<string, unknown>, id: string): Promise<Record<string, unknown>> => {
      bridge.onMessage(c, { ...frame, request_id: id });
      await settled();
      return c.sent.find((m) => m.request_id === id) ?? {};
    };

    const created = await send(
      {
        type: "goals_create",
        title: "Ship goals",
        horizon: "short",
        lead_habit: { label: "Code 1h", per_week: 4 },
      },
      "r1",
    );
    expect(created.goals).toHaveLength(1);
    const goalId = (created.goals as Array<{ id: string }>)[0].id;

    await send({ type: "goals_progress_add", id: goalId, note: "Added core logic" }, "r2");
    await send({ type: "goals_habit_toggle", id: goalId, day: "2026-11-28", done: true }, "r3");
    await send({ type: "goals_settings_set", autonomy: "nudge_only", daily_hour: 10 }, "r4");

    const work = await send({ type: "goals_work_start", id: goalId }, "r5");
    expect(work).toMatchObject({ agent_id: "a1", conversation_id: "conv-1", created: true });
    expect(String(work.brief)).toContain("Ship goals");

    const discover = await send({ type: "goals_discover_start", agent_id: "a1" }, "r6");
    expect(discover).toMatchObject({ agent_id: "a1", conversation_id: "conv-2", created: true });
    expect(String(discover.brief)).toContain("Ada");

    const pulse = await send({ type: "goals_pulse_run", kind: "weekly" }, "r7");
    expect(pulse).toMatchObject({ note: "ran weekly", agent_id: "a1", conversation_id: "c-pulse" });

    const listed = await send({ type: "goals_list" }, "r8");
    expect((listed.settings as { autonomy: string; daily_hour: number }).autonomy).toBe("nudge_only");
    expect((listed.goals as Array<{ lead_habit?: { checkins: string[] } }>)[0].lead_habit?.checkins).toEqual(["2026-11-28"]);

    await send({ type: "goals_delete", id: goalId }, "r9");
    const afterDelete = await send({ type: "goals_list" }, "r10");
    expect(afterDelete.goals).toEqual([]);
    expect(broadcasts.filter((b) => b.frame.type === "goals_changed").length).toBeGreaterThanOrEqual(7);
  });
});
