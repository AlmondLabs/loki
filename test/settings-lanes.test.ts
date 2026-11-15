import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Lane } from "../core/attention/lanes.ts";
import type { AccountView } from "../core/frame-types.ts";
import type { MacAccountView } from "../core/frames.ts";
import { LaneEditor, Lanes, draftOf, laneAccounts, laneSummary, newDraft, saveLane, ticked, withoutLane, type LaneDraft } from "../app/src/settings/lanes.tsx";
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

const text = (html: string) => html.replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
const noAccounts = { everywhere: () => Promise.resolve({ accounts: [], other_macs: [] }) };

describe("Preferences › Flow: the lane editor (plan 087, U8)", () => {
  test("making Work with two agents and one account sends the lanes with that lane and the chosen ids (F1)", () => {
    const draft: LaneDraft = { ...newDraft("lane-new"), name: "Work", chatIds: ["agent-work", "agent-ops"], accountIds: [MAIL.account_id] };
    expect(saveLane([HOME], draft)).toEqual([HOME, { id: "lane-new", name: "Work", chats: ["agent-work", "agent-ops"], accounts: [MAIL.account_id] }]);
  });

  test("choosing all agents saves chats as all, whatever was ticked before (AE2)", () => {
    const draft: LaneDraft = { ...newDraft("lane-new"), name: "Chats", chats: "all", chatIds: ["agent-work"], accounts: "none" };
    expect(saveLane([], draft)).toEqual([{ id: "lane-new", name: "Chats", chats: "all", accounts: [] }]);
  });

  test("pick with nothing ticked saves that side as none", () => {
    const draft: LaneDraft = { ...newDraft("lane-new"), name: "Mail only", chats: "pick", chatIds: [], accounts: "all" };
    expect(saveLane([], draft)).toEqual([{ id: "lane-new", name: "Mail only", chats: [], accounts: "all" }]);
    expect(draftOf({ id: "lane-new", name: "Mail only", chats: [], accounts: "all" })).toMatchObject({ chats: "none", accounts: "all" });
  });

  test("an empty name or one another lane has, case aside, is refused with a reason and nothing to send", () => {
    expect(saveLane([HOME], { ...newDraft("lane-new"), name: "  " })).toBe("A lane needs a name");
    expect(saveLane([HOME], { ...newDraft("lane-new"), name: "home" })).toBe("Another lane is called Home");
    // A lane keeps its own name when saved again.
    expect(saveLane([HOME], { ...draftOf(HOME), name: "home" })).toEqual([{ ...HOME, name: "home" }]);
  });

  test("an editor with a refused name shows the reason inline", () => {
    const out = text(
      renderToStaticMarkup(
        createElement(LaneEditor, {
          draft: newDraft("x"),
          lanes: [HOME],
          agents: AGENTS,
          accounts: [],
          error: "Another lane is called Home",
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
    expect(saveLane([work], { ...draftOf(work), name: "Day job" })).toEqual([{ ...work, name: "Day job" }]);
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
    // The editor is a sheet, opened from a row; none shows until then.
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
