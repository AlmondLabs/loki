import { describe, expect, test } from "vitest";
import { ago } from "../app/src/shared/ago.ts";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const before = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

describe("how long ago, as the chat lists say it", () => {
  test("now, minutes, hours below a day, then days", () => {
    expect([ago(null, NOW), ago(before(20_000), NOW), ago(before(5 * MIN), NOW), ago(before(23 * 60 * MIN), NOW)]).toEqual(["", "now", "5m", "23h"]);
    expect([ago(before(24 * 60 * MIN), NOW), ago(before(40 * 60 * MIN), NOW), ago(before(5 * 24 * 60 * MIN), NOW)]).toEqual(["1d", "2d", "5d"]);
  });
});
