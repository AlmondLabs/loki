import { describe, expect, test } from "vitest";
import { FRAMES } from "../core/frames.ts";
import { bucketOf, summarize, type UsageOrigin, type UsageRow } from "../core/usage.ts";
import { usageFrames } from "../mod/frames/usage.ts";

const A = "anthropic/claude-sonnet-5-5";
const LOCAL = "ollama/qwen3";

/** A row with made-up figures: `input` input tokens costing a cent per thousand, and the rest zero. */
function row(hour: string, opts: { agent?: string; model?: string; origin?: UsageOrigin; input?: number; cacheRead?: number; other?: number } = {}): UsageRow {
  const input = opts.input ?? 1000;
  const cacheRead = opts.cacheRead ?? 0;
  const split = opts.other === undefined;
  const cost = split ? input / 1e5 + cacheRead / 1e6 : 0;
  return {
    hour,
    agent_id: opts.agent ?? "a1",
    model: opts.model ?? A,
    origin: opts.origin ?? "chats",
    input_tokens: input,
    cache_read_tokens: cacheRead,
    cache_write_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cost: {
      input: split ? input / 1e5 : 0,
      cache_read: split ? cacheRead / 1e6 : 0,
      cache_write: 0,
      output: 0,
      other: opts.other ?? 0,
      total: cost + (opts.other ?? 0),
    },
    cache_read_as_input: cacheRead / 1e5,
  };
}

describe("usage buckets", () => {
  test("days and hours are the reader's, across a time zone's date line and a daylight-saving change", () => {
    expect(bucketOf(Date.parse("2026-10-16T19:00:00Z"), "Asia/Kolkata", "day")).toBe("2026-10-17");
    expect(bucketOf(Date.parse("2026-10-16T19:00:00Z"), "UTC", "day")).toBe("2026-10-16");
    // New York leaves daylight saving at 2am on November 1: both of these are 1:30 there.
    expect(bucketOf(Date.parse("2026-11-01T05:30:00Z"), "America/New_York", "hour")).toBe("2026-11-01T01");
    expect(bucketOf(Date.parse("2026-11-01T06:30:00Z"), "America/New_York", "hour")).toBe("2026-11-01T01");
  });
});

describe("summarize", () => {
  const priced = { [A]: true, [LOCAL]: false };
  const since = Date.parse("2026-10-15T00:00:00Z");
  const until = Date.parse("2026-10-18T00:00:00Z");
  const rows = [
    row("2026-10-14T23:00:00.000Z", { input: 99_999 }), // before the period
    row("2026-10-15T10:00:00.000Z", { cacheRead: 10_000 }),
    row("2026-10-15T11:00:00.000Z", { agent: "a2", origin: "reflection", input: 3000 }),
    row("2026-10-17T09:00:00.000Z", { model: LOCAL, input: 5000 }),
    row("2026-10-17T10:00:00.000Z", { input: 0, cacheRead: 2000, other: 0.05 }), // seeded: cost as a total only
  ];

  test("totals, cache savings, and a model with no price counted in tokens but not in cost", () => {
    const s = summarize(rows, { since, until, timeZone: "UTC", resolution: "day", priced });
    expect(s.tokens).toEqual({ input: 9000, cache_read: 12_000, cache_write: 0, output: 0, reasoning: 0, total: 21_000 });
    expect(s.cost.input).toBeCloseTo(0.04);
    expect(s.cost.other).toBeCloseTo(0.05);
    expect(s.cost.total).toBeCloseTo(0.04 + 0.01 + 0.05);
    // 10,000 cache reads at input's cent a thousand would be 0.10; they cost 0.01. The seeded row's split is unknown.
    expect(s.cache_savings).toBeCloseTo(0.09);
    expect(s.unpriced_tokens).toBe(5000);
  });

  test("every day of the period is a bar, empty ones included, and breakdowns are sorted by cost with shares", () => {
    const s = summarize(rows, { since, until, timeZone: "UTC", resolution: "day", priced });
    expect(s.series.map((p) => p.bucket)).toEqual(["2026-10-15", "2026-10-16", "2026-10-17"]);
    expect(s.series[1]).toEqual({ bucket: "2026-10-16", cost: 0, tokens: 0 });
    expect(s.by_agent.map((l) => l.key)).toEqual(["a1", "a2"]);
    expect(s.by_origin.find((l) => l.key === "reflection")?.share).toBeCloseTo(0.03 / 0.1);
    expect(s.by_model.map((l) => [l.key, l.cost > 0])).toEqual([
      [A, true],
      [LOCAL, false],
    ]);
  });

  test("in a zone half an hour off UTC, the period starts at the reader's midnight, with no extra day before it", () => {
    // Midnight on October 15 in Kolkata is 18:30 UTC on the 14th; the row for 18:00 UTC runs past it.
    const s = summarize([row("2026-10-14T18:00:00.000Z", { input: 700 })], {
      since: Date.parse("2026-10-14T18:30:00Z"),
      until: Date.parse("2026-10-17T18:30:00Z"),
      timeZone: "Asia/Kolkata",
      resolution: "day",
      priced,
    });
    expect(s.series.map((p) => p.bucket)).toEqual(["2026-10-15", "2026-10-16", "2026-10-17"]);
    expect(s.series[0].tokens).toBe(700);
  });

  test("a filter narrows everything to one agent, origin or model; 24 hours buckets by hour", () => {
    const s = summarize(rows, { since, until, timeZone: "UTC", resolution: "day", priced, filter: { origin: "reflection" } });
    expect(s.tokens.total).toBe(3000);
    expect(s.by_agent.map((l) => l.key)).toEqual(["a2"]);
    const day = summarize(rows, { since: Date.parse("2026-10-17T00:00:00Z"), until, timeZone: "UTC", resolution: "hour", priced });
    expect(day.series).toHaveLength(24);
    expect(day.series[9]).toMatchObject({ bucket: "2026-10-17T09", tokens: 5000, cost: 0 });
  });
});

describe("the usage_get frame", () => {
  test("takes ISO instants only", () => {
    expect(FRAMES.usage_get.parse({ since: "2026-10-15T00:00:00Z", until: "2026-10-18T00:00:00Z" })).toEqual({
      since: "2026-10-15T00:00:00Z",
      until: "2026-10-18T00:00:00Z",
    });
    expect(typeof FRAMES.usage_get.parse({ since: "yesterday", until: "2026-10-18T00:00:00Z" })).toBe("string");
  });

  test("answers the rows of the period, the hour `since` falls in included, with each model's price status", async () => {
    const frames = usageFrames({
      usage: {
        rows: () => [row("2026-10-15T09:00:00.000Z"), row("2026-10-15T10:00:00.000Z", { model: LOCAL }), row("2026-10-18T00:00:00.000Z")],
        priced: (m) => m === A,
        seeded: () => "2026-10-01T00:00:00.000Z",
      },
    });
    const out = (await frames.usage_get?.({ since: "2026-10-15T09:30:00.000Z", until: "2026-10-18T00:00:00.000Z" }, {} as never)) as {
      ok: true;
      reply: { rows: UsageRow[]; priced: Record<string, boolean>; seeded_until: string };
    };
    expect(out.reply.rows.map((r) => r.hour)).toEqual(["2026-10-15T09:00:00.000Z", "2026-10-15T10:00:00.000Z"]);
    expect(out.reply.priced).toEqual({ [A]: true, [LOCAL]: false });
    expect(out.reply.seeded_until).toBe("2026-10-01T00:00:00.000Z");
    const none = (await usageFrames({}).usage_get?.({ since: "2026-10-15T00:00:00Z", until: "2026-10-18T00:00:00Z" }, {} as never)) as {
      reply: { rows: UsageRow[] };
    };
    expect(none.reply.rows).toEqual([]);
  });
});
