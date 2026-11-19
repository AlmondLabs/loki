import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { dueLane, followLane, latestEdge, nextChange, timesLabel, untilTime } from "../core/attention/lane-times.ts";
import type { Lane, LaneWindow } from "../core/attention/lanes.ts";

const tz = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
beforeEach(() => {
  process.env.TZ = "UTC";
});
afterEach(() => {
  process.env.TZ = tz;
});

const LONG_AGO = "2026-01-01T00:00:00Z";
const WEEKDAYS = [1, 2, 3, 4, 5];
const win = (start: string, end: string, days = WEEKDAYS, since = LONG_AGO): LaneWindow => ({ days, start, end, since });
const lane = (id: string, times?: LaneWindow[]): Lane => ({ id, name: id, chats: "all", accounts: "all", ...(times ? { times } : {}) });

const work = lane("work", [win("09:00", "18:00")]);
const comms = lane("comms", [win("09:00", "09:30"), win("16:00", "16:30")]);
const personal = lane("personal", [win("19:00", "23:30")]);
const reading = lane("reading");
const LANES = [work, comms, personal, reading];

// 2026-11-17 is a Tuesday; local time is UTC in these tests unless a test sets another zone.
const at = (day: number, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(2026, 10, day, h, m);
};
const due = (lanes: Lane[], when: Date) => dueLane(lanes, when)?.id ?? "";

describe("the lane due at a moment", () => {
  test("AE1: on a Tuesday the nested windows decide, and between windows it is Everything", () => {
    const seen = ["08:59", "09:00", "09:29", "09:30", "16:00", "16:30", "18:00", "19:00"].map((t) => due(LANES, at(17, t)));
    expect(seen).toEqual(["", "comms", "comms", "work", "comms", "work", "", "personal"]);
  });

  test("AE5: a Friday window past midnight covers early Saturday, and not early Sunday", () => {
    const late = lane("late", [win("19:00", "01:00", [5])]);
    expect(due([late], at(21, "00:30"))).toBe("late");
    expect(due([late], at(21, "01:00"))).toBe("");
    expect(due([late], at(22, "00:30"))).toBe("");
  });

  test("two lanes with the same window: the one listed first is due", () => {
    const a = lane("a", [win("10:00", "11:00")]);
    const b = lane("b", [win("10:00", "11:00")]);
    expect(due([a, b], at(17, "10:30"))).toBe("a");
    expect(due([b, a], at(17, "10:30"))).toBe("b");
  });

  test("a weekday outside the window's days is not covered", () => {
    expect(due(LANES, at(21, "10:00"))).toBe("");
  });
});

describe("the latest start or end that has passed", () => {
  test("a window ending as another starts gives one edge at that moment", () => {
    const a = lane("a", [win("09:00", "09:30")]);
    const b = lane("b", [win("09:30", "10:00")]);
    expect(latestEdge([a, b], at(17, "09:45"))).toBe(at(17, "09:30").getTime());
  });

  test("edges before a window's since do not count, and its later ones do", () => {
    const added = lane("added", [win("10:00", "11:00", [2], at(17, "10:20").toISOString())]);
    expect(latestEdge([added], at(17, "10:30"))).toBeNull();
    expect(latestEdge([added], at(17, "11:05"))).toBe(at(17, "11:00").getTime());
  });

  test("on a Sunday at noon the latest edge is Friday's end of Personal", () => {
    expect(latestEdge(LANES, at(22, "12:00"))).toBe(at(20, "23:30").getTime());
  });
});

describe("until", () => {
  test("names the next moment the due lane changes, while the active lane is the lane due", () => {
    expect(nextChange(LANES, at(17, "16:10"))).toEqual(at(17, "16:30"));
    expect(untilTime(LANES, "comms", at(17, "16:10"))).toEqual(at(17, "16:30"));
    expect(untilTime(LANES, "reading", at(17, "16:10"))).toBeNull();
    expect(untilTime(LANES, "", at(17, "18:30"))).toBeNull();
  });

  test("skips an end the same lane carries on through", () => {
    const twice = lane("twice", [win("09:00", "09:30"), win("09:00", "10:00")]);
    expect(untilTime([twice], "twice", at(17, "09:10"))).toEqual(at(17, "10:00"));
  });
});

describe("daylight saving", () => {
  test("a start in the spring gap moves forward by the gap, and one in the repeated hour takes the first", () => {
    process.env.TZ = "Europe/London";
    const early = lane("early", [win("01:30", "04:00", [0])]);
    const spring = latestEdge([early], new Date(2026, 2, 29, 3, 0));
    expect(spring === null ? null : new Date(spring).getHours()).toBe(2);
    expect(new Date(spring ?? 0).getMinutes()).toBe(30);
    const autumn = latestEdge([early], new Date(Date.parse("2026-10-25T01:00:00Z")));
    expect(autumn).toBe(Date.parse("2026-10-25T00:30:00Z"));
  });
});

describe("the times label", () => {
  test("groups windows by their days", () => {
    expect(timesLabel(comms.times ?? [], "en-GB")).toBe("Weekdays, 9:00–9:30 and 16:00–16:30");
    const more = [...(comms.times ?? []), win("10:00", "11:00", [6])];
    expect(timesLabel(more, "en-GB")).toBe("Weekdays, 9:00–9:30 and 16:00–16:30; Sat, 10:00–11:00");
  });

  test("names every day, weekends and other days", () => {
    expect(timesLabel([win("09:00", "10:00", [0, 1, 2, 3, 4, 5, 6])], "en-GB")).toBe("Every day, 9:00–10:00");
    expect(timesLabel([win("09:00", "10:00", [0, 6])], "en-GB")).toBe("Weekends, 9:00–10:00");
    expect(timesLabel([win("09:00", "10:00", [5, 1, 3])], "en-GB")).toBe("Mon, Wed, Fri, 9:00–10:00");
  });

  test("follows a 12-hour locale", () => {
    expect(timesLabel([win("16:00", "16:30")], "en-US")).toBe("Weekdays, 4:00 PM–4:30 PM");
  });
});

describe("whether a device follows the times now", () => {
  const ms = (d: Date) => d.getTime();

  test("AE2: a hand switch holds until the next start or end", () => {
    expect(followLane(LANES, ms(at(17, "15:50")), false, at(17, "16:00"))).toBe("comms");
    expect(followLane(LANES, ms(at(17, "16:10")), false, at(17, "16:20"))).toBeNull();
    expect(followLane(LANES, ms(at(17, "16:10")), false, at(17, "16:30"))).toBe("work");
  });

  test("AE3: a phone opened late catches up, and not after a hand switch since", () => {
    expect(followLane(LANES, ms(at(17, "17:00")), false, at(17, "19:40"))).toBe("personal");
    expect(followLane(LANES, ms(at(17, "19:45")), false, at(17, "19:50"))).toBeNull();
  });

  test("AE3 over a weekend: a phone last switched on Friday evening opens on Sunday in Everything", () => {
    expect(followLane(LANES, ms(at(20, "19:00")), false, at(22, "12:00"))).toBe("");
  });

  test("AE6: a window saved after it started switches no one until its end", () => {
    const edited = [work, lane("comms", [win("10:00", "11:00", [2], at(17, "10:20").toISOString())])];
    expect(followLane(edited, ms(at(17, "09:00")), false, at(17, "10:20"))).toBeNull();
    expect(followLane(edited, ms(at(17, "09:00")), false, at(17, "11:00"))).toBe("work");
  });

  test("AE4: a reply holds a due switch, and once dropped the device moves into the lane due then", () => {
    expect(followLane(LANES, ms(at(17, "09:30")), true, at(17, "16:00"))).toBeNull();
    expect(followLane(LANES, ms(at(17, "09:30")), false, at(17, "16:02"))).toBe("comms");
    expect(followLane(LANES, ms(at(17, "09:30")), false, at(17, "16:40"))).toBe("work");
  });

  test("nothing moves before the lanes load, or while a reply holds", () => {
    expect(followLane(null, null, false, at(17, "16:00"))).toBeNull();
    expect(followLane(LANES, ms(at(17, "15:50")), true, at(17, "16:00"))).toBeNull();
  });

  test("a device with no recorded switch keeps its lane until a counted start or end has passed", () => {
    const fresh = [lane("comms", [win("16:00", "16:30", [2], at(17, "16:10").toISOString())])];
    expect(followLane(fresh, null, false, at(17, "16:15"))).toBeNull();
    expect(followLane(fresh, null, false, at(17, "16:30"))).toBe("");
    expect(followLane([reading], null, false, at(17, "16:00"))).toBeNull();
  });
});
