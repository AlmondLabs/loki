import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Lane, LaneWindow } from "../core/attention/lanes.ts";
import { timesLabel } from "../core/attention/lane-times.ts";
import type { AccountView } from "../core/frame-types.ts";
import type { MacAccountView } from "../core/frames.ts";
import {
  LaneEditor,
  Lanes,
  draftOf,
  laneAccounts,
  laneSummary,
  newDraft,
  saveLane,
  ticked,
  withNewTime,
  withoutLane,
  type LaneDraft,
} from "../app/src/settings/lanes.tsx";
import { InboxPage } from "../app/src/settings/settings.tsx";
import { RETURN_TIMES_DEFAULT } from "../core/attention/rest.ts";

const AGENTS = [
  { id: "agent-work", name: "Work" },
  { id: "agent-ops", name: "Ops" },
  { id: "agent-home", name: "Home" },
];

const MAIL: AccountView = {
  account_id: "gmail:ada@acme.com",
  provider: "gmail",
  address: "ada@acme.com",
  owner_agent_id: "agent-work",
  status: "connected",
  connected_at: "2026-11-01T09:00:00.000Z",
};
const STUDIO: MacAccountView = {
  account_id: "slack:T09:U01",
  provider: "slack",
  address: "Studio",
  owner_agent_id: "agent-home",
  status: "connected",
  connected_at: "2026-11-02T09:00:00.000Z",
  mac_id: "mac-2",
  mac_name: "Studio Mac",
};

const HOME: Lane = { id: "lane-home", name: "Home", chats: ["agent-home"], accounts: "all" };
const NOW = new Date("2026-11-19T10:00:00.000Z");

const text = (html: string) => html.replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
const noAccounts = { everywhere: () => Promise.resolve({ accounts: [], other_macs: [] }) };

describe("Preferences › Flow: the lane editor (plan 087, U8)", () => {
  test("making Work with two agents and one account sends the lanes with that lane and the chosen ids (F1)", () => {
    const draft: LaneDraft = { ...newDraft("lane-new"), name: "Work", chatIds: ["agent-work", "agent-ops"], accountIds: [MAIL.account_id] };
    expect(saveLane([HOME], draft, NOW)).toEqual([HOME, { id: "lane-new", name: "Work", chats: ["agent-work", "agent-ops"], accounts: [MAIL.account_id] }]);
  });

  test("choosing all agents saves chats as all, whatever was ticked before (AE2)", () => {
    const draft: LaneDraft = { ...newDraft("lane-new"), name: "Chats", chats: "all", chatIds: ["agent-work"], accounts: "none" };
    expect(saveLane([], draft, NOW)).toEqual([{ id: "lane-new", name: "Chats", chats: "all", accounts: [] }]);
  });

  test("pick with nothing ticked saves that side as none", () => {
    const draft: LaneDraft = { ...newDraft("lane-new"), name: "Mail only", chats: "pick", chatIds: [], accounts: "all" };
    expect(saveLane([], draft, NOW)).toEqual([{ id: "lane-new", name: "Mail only", chats: [], accounts: "all" }]);
    expect(draftOf({ id: "lane-new", name: "Mail only", chats: [], accounts: "all" })).toMatchObject({ chats: "none", accounts: "all" });
  });

  test("an empty name or one another lane has, case aside, is refused with a reason and nothing to send", () => {
    expect(saveLane([HOME], { ...newDraft("lane-new"), name: "  " }, NOW)).toEqual({ message: "A lane needs a name", time: null });
    expect(saveLane([HOME], { ...newDraft("lane-new"), name: "home" }, NOW)).toEqual({ message: "Another lane is called Home", time: null });
    expect(saveLane([HOME], { ...draftOf(HOME), name: "home" }, NOW)).toEqual([{ ...HOME, name: "home" }]);
  });

  test("an editor with a refused name shows the reason inline", () => {
    const out = text(
      renderToStaticMarkup(
        createElement(LaneEditor, {
          draft: newDraft("x"),
          lanes: [HOME],
          agents: AGENTS,
          accounts: [],
          error: { message: "Another lane is called Home", time: null },
          onDraft: () => {},
          onSave: () => {},
          onCancel: () => {},
          onDelete: null,
        }),
      ),
    );
    expect(out).toContain('role="alert"');
    expect(out).toContain("Another lane is called Home");
  });

  test("deleting a lane sends the list without it", () => {
    const work: Lane = { id: "lane-work", name: "Work", chats: "all", accounts: [] };
    expect(withoutLane([HOME, work], "lane-home")).toEqual([work]);
  });

  test("an account on a paired Mac is listed with its owner agent and its Mac, and can be picked", () => {
    const rows = laneAccounts({ accounts: [MAIL], other_macs: [STUDIO] }, AGENTS);
    expect(rows).toEqual([
      { account_id: MAIL.account_id, label: "ada@acme.com", service: "Gmail", owner: "Work", mac: null },
      { account_id: STUDIO.account_id, label: "Studio", service: "Slack", owner: "Home", mac: "Studio Mac" },
    ]);
    const draft: LaneDraft = { ...newDraft("lane-new"), accounts: "pick" };
    const out = text(
      renderToStaticMarkup(
        createElement(LaneEditor, {
          draft,
          lanes: [],
          agents: AGENTS,
          accounts: rows,
          error: null,
          onDraft: () => {},
          onSave: () => {},
          onCancel: () => {},
          onDelete: null,
        }),
      ),
    );
    expect(out).toContain("Studio");
    expect(out).toContain("Slack · Home · Studio Mac");
    expect(out).toContain('aria-label="Pick Studio"');
    expect(ticked([], STUDIO.account_id, true)).toEqual([STUDIO.account_id]);
    expect(ticked([STUDIO.account_id], STUDIO.account_id, false)).toEqual([]);
  });

  test("a lane picking an agent this Mac does not know keeps that id when its name is edited (KTD2)", () => {
    const work: Lane = { id: "lane-work", name: "Work", chats: ["agent-elsewhere", "agent-work"], accounts: [] };
    expect(saveLane([work], { ...draftOf(work), name: "Day job" }, NOW)).toEqual([{ ...work, name: "Day job" }]);
  });

  test("while the lanes are not in yet the editor says it is loading, not that there are none", () => {
    const loading = text(renderToStaticMarkup(createElement(Lanes, { lanes: { lanes: null, set: () => {} }, accounts: noAccounts, agents: AGENTS })));
    expect(loading).toContain("Asking loki…");
    expect(loading).not.toContain("Add Lane…");
    const none = text(renderToStaticMarkup(createElement(Lanes, { lanes: { lanes: [], set: () => {} }, accounts: noAccounts, agents: AGENTS })));
    expect(none).toContain("Add Lane…");
    expect(none).toContain("No lanes yet");
  });

  test("the Flow page holds the lanes above the return times", () => {
    const out = text(
      renderToStaticMarkup(
        createElement(InboxPage, {
          returnTimes: { times: RETURN_TIMES_DEFAULT, set: () => {} },
          lanes: { lanes: { lanes: [HOME], set: () => {} }, accounts: noAccounts, agents: AGENTS },
        }),
      ),
    );
    expect(out.indexOf("Home")).toBeGreaterThan(-1);
    expect(out.indexOf("Add Lane…")).toBeLessThan(out.indexOf("Read rests a card for"));
  });
  test("each lane is a row of the table: its name, what it shows and Edit…, then Add Lane… (plan 2026-11-15-2359, KTD1)", () => {
    const work: Lane = { id: "lane-work", name: "Work", chats: ["agent-work", "agent-ops"], accounts: [MAIL.account_id] };
    const out = text(renderToStaticMarkup(createElement(Lanes, { lanes: { lanes: [HOME, work], set: () => {} }, accounts: noAccounts, agents: AGENTS })));
    expect(out).toContain("Chats from Home, all mail and Slack");
    expect(out).toContain("Chats from Work and Ops, mail and Slack from one account");
    expect(out).toContain('aria-label="Edit Work"');
    expect(out.indexOf("Work")).toBeLessThan(out.indexOf("Add Lane…"));
    expect(out).not.toContain("Lane name");
  });

  test("a row's line names agents this Mac knows and counts the rest, then the accounts (KTD2)", () => {
    expect(laneSummary({ id: "a", name: "A", chats: "all", accounts: [] }, AGENTS)).toBe("All chats, no mail or Slack");
    expect(laneSummary({ id: "a", name: "A", chats: [], accounts: ["x", "y"] }, AGENTS)).toBe("No chats, mail and Slack from 2 accounts");
    expect(laneSummary({ id: "a", name: "A", chats: ["agent-work", "agent-elsewhere"], accounts: "all" }, AGENTS)).toBe(
      "Chats from Work and an agent on another Mac, all mail and Slack",
    );
    expect(laneSummary({ id: "a", name: "A", chats: ["agent-work", "agent-ops", "agent-home", "x", "y"], accounts: "all" }, AGENTS)).toBe(
      "Chats from Work, Ops, Home and 2 agents on other Macs, all mail and Slack",
    );
  });

  test("the sheet's editor has Cancel and Save, and Delete Lane… only for a saved lane", () => {
    const base = { lanes: [HOME], agents: AGENTS, accounts: [], error: null, onDraft: () => {}, onSave: () => {}, onCancel: () => {} };
    const saved = text(renderToStaticMarkup(createElement(LaneEditor, { ...base, draft: draftOf(HOME), onDelete: () => {} })));
    expect(saved).toContain("Edit Home");
    expect(saved).toContain("Delete Lane…");
    expect(saved.indexOf("Cancel")).toBeLessThan(saved.indexOf("Save"));
    const fresh = text(renderToStaticMarkup(createElement(LaneEditor, { ...base, draft: newDraft("x"), onDelete: null })));
    expect(fresh).toContain("New lane");
    expect(fresh).not.toContain("Delete Lane…");
  });
});

describe("Preferences › Flow: a lane's switching times (plan 2026-11-19-1851, U5)", () => {
  const EARLIER = "2026-11-01T09:00:00.000Z";
  const weekdays = [1, 2, 3, 4, 5];
  const at = (start: string, end: string, days = weekdays): LaneWindow => ({ days, start, end, since: EARLIER });
  const COMMS: Lane = { id: "lane-comms", name: "Comms", chats: [], accounts: "all", times: [at("09:00", "09:30"), at("16:00", "16:30")] };
  const READING: Lane = { id: "lane-reading", name: "Reading", chats: ["agent-home"], accounts: [] };
  const editor = (draft: LaneDraft, error: { message: string; time: number | null } | null = null) =>
    text(
      renderToStaticMarkup(
        createElement(LaneEditor, {
          draft,
          lanes: [COMMS],
          agents: AGENTS,
          accounts: [],
          error,
          onDraft: () => {},
          onSave: () => {},
          onCancel: () => {},
          onDelete: null,
        }),
      ),
    );
  const savedLanes = (next: Lane[] | { message: string; time: number | null }): Lane[] => {
    if (!Array.isArray(next)) throw new Error(next.message);
    return next;
  };

  test("a new window is stamped with the injected clock; an unchanged one keeps its since", () => {
    const [comms] = savedLanes(saveLane([COMMS], withNewTime(draftOf(COMMS)), NOW));
    expect(comms.times).toEqual([at("09:00", "09:30"), at("16:00", "16:30"), { days: weekdays, start: "09:00", end: "17:00", since: NOW.toISOString() }]);
  });

  test("changing one window's end restamps only that window", () => {
    const draft = draftOf(COMMS);
    const times = draft.times.map((t, i) => (i === 1 ? { ...t, end: "16:45" } : t));
    const [comms] = savedLanes(saveLane([COMMS], { ...draft, times }, NOW));
    expect(comms.times).toEqual([at("09:00", "09:30"), { ...at("16:00", "16:45"), since: NOW.toISOString() }]);
  });

  test("ticking the same days in another order is no change", () => {
    const draft = draftOf(COMMS);
    const times = draft.times.map((t) => ({ ...t, days: [5, 4, 3, 2, 1] }));
    expect(savedLanes(saveLane([COMMS], { ...draft, times }, NOW))).toEqual([COMMS]);
  });

  test("saving keeps a field the editor does not know", () => {
    const later = { ...COMMS, later_field: "kept" };
    expect(savedLanes(saveLane([later], { ...draftOf(later), name: "Messages" }, NOW))).toEqual([{ ...later, name: "Messages" }]);
  });

  test("a window with no day, or with the same start and end, is refused with its message and nothing to send", () => {
    const draft = draftOf(COMMS);
    const noDay = { ...draft, times: draft.times.map((t, i) => (i === 1 ? { ...t, days: [] } : t)) };
    expect(saveLane([COMMS], noDay, NOW)).toEqual({ message: "Pick at least one day", time: 1 });
    const same = { ...draft, times: draft.times.map((t, i) => (i === 0 ? { ...t, end: "09:00" } : t)) };
    expect(saveLane([COMMS], same, NOW)).toEqual({ message: "Start and end must differ", time: 0 });
  });

  test("the refusal shows beside its row, not at the top of the sheet", () => {
    const out = editor(draftOf(COMMS), { message: "Start and end must differ", time: 1 });
    expect(out).toContain("Start and end must differ");
    expect(out.indexOf("Start and end must differ")).toBeGreaterThan(out.indexOf('aria-label="Remove time 2"'));
    expect(out).not.toContain('aria-invalid="true"');
  });

  test("Add Time adds a Monday-to-Friday row from 9:00 to 17:00", () => {
    const added = withNewTime(newDraft("x")).times;
    expect(added.map(({ key: _key, ...time }) => time)).toEqual([{ days: weekdays, start: "09:00", end: "17:00", was: null }]);
    const twice = withNewTime(withNewTime(newDraft("x"))).times;
    expect(new Set(twice.map((t) => t.key)).size).toBe(2);
  });

  test("each row's Remove, start and end carry its number, and its days are pressed chips", () => {
    const out = editor(draftOf(COMMS));
    expect(out).toContain("Every Mac and your phone switch to this lane at these times, from the first start or end after you save.");
    for (const n of [1, 2]) {
      expect(out).toContain(`aria-label="Remove time ${n}"`);
      expect(out).toContain(`aria-label="Start of time ${n}"`);
      expect(out).toContain(`aria-label="End of time ${n}"`);
    }
    expect(out.match(/type="time"/g)).toHaveLength(4);
    expect(out).toContain('value="16:30"');
    const schedule = out.slice(out.indexOf('aria-label="Days of time 1"'));
    expect(schedule).toContain('aria-label="Days of time 2"');
    expect(schedule.match(/aria-pressed="true"/g)).toHaveLength(10);
    expect(schedule.match(/aria-pressed="false"/g)).toHaveLength(4);
    expect(out).toContain("Add Time");
  });

  test("removing the last window saves the lane with no times", () => {
    const [comms] = savedLanes(saveLane([COMMS], { ...draftOf(COMMS), times: [] }, NOW));
    expect(comms).not.toHaveProperty("times");
    expect(comms).toEqual({ id: "lane-comms", name: "Comms", chats: [], accounts: "all" });
  });

  test("the table row for Comms says when it runs under what it shows; Reading has no such line", () => {
    const out = text(renderToStaticMarkup(createElement(Lanes, { lanes: { lanes: [COMMS, READING], set: () => {} }, accounts: noAccounts, agents: AGENTS })));
    const label = timesLabel(COMMS.times ?? []);
    expect(label).toMatch(/^Weekdays, /);
    expect(out).toContain(label);
    expect(out.indexOf("No chats, all mail and Slack")).toBeLessThan(out.indexOf(label));
    expect(out.indexOf(label)).toBeLessThan(out.indexOf("Reading"));
    expect(out.match(/Weekdays, /g)).toHaveLength(1);
    expect(out).toContain("from the sidebar under Flow on a Mac and from Flow's title on the phone");
  });
});
