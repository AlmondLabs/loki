import { describe, expect, test } from "vitest";
import { SHARED_SCOPE, homeNote } from "../core/desk-core.ts";
import type { DeskSummary, InboxRow } from "../core/frame-types.ts";
import { RemoteChats } from "../mod/remote-chats.ts";

const MINI = "bbbbbbbb-2222-4222-8222-222222222222";

/** A desk as a Mac lists its own. */
const desk = (conversationId: string, title: string, agentId = "agent-ira"): DeskSummary => ({
  scope: conversationId,
  title,
  status: "live",
  agent_name: "Ira",
  agent_id: agentId,
  conversation_id: conversationId,
  widgets: 0,
  active: true,
  last_active: "2026-10-18T10:00:00Z",
});

const row = (id: string): InboxRow => ({
  id,
  agent_id: "agent-ira",
  agent_name: "Ira",
  title: "plan the week",
  last_message_at: "2026-10-18T10:00:00Z",
  archived: false,
  last_role: "assistant",
  last_assistant_text: "done",
  last_ask: null,
});

/** The mini as its link answers `peer_chats_get`: whatever `lists` holds now, or out of reach. */
function fixture() {
  const state = {
    lists: { desks: [desk("conv-1", "plan the week"), desk(SHARED_SCOPE, "shared")], inbox: [row("conv-1")] },
    reachable: true,
    changes: 0,
  };
  const link = {
    request: () => (state.reachable ? Promise.resolve({ type: "peer_chats", ...state.lists }) : Promise.reject(new Error("that Mac is out of reach"))),
  };
  const remote = new RemoteChats({
    link: (id) => (id === MINI ? (link as never) : null),
    name: () => "Mac mini",
    onChange: () => state.changes++,
    debounceMs: 5,
  });
  return { state, remote };
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("another Mac's chats in this Mac's lists", () => {
  test("a reachable Mac's chats are listed with its name, its shared canvas left out", async () => {
    const { remote, state } = fixture();
    await remote.refresh(MINI);
    expect(remote.desks()).toEqual([{ ...desk("conv-1", "plan the week"), active: false, home: MINI, home_name: "Mac mini", reachable: true }]);
    expect(remote.inbox()).toEqual([{ ...row("conv-1"), home: MINI, home_name: "Mac mini", reachable: true }]);
    expect(state.changes).toBe(1);
  });

  test("a Mac going out of reach keeps its chats, marked waiting, and its return brings them back", async () => {
    const { remote, state } = fixture();
    await remote.refresh(MINI);
    remote.setReachable(MINI, false);
    expect(remote.desks().map((d) => d.reachable)).toEqual([false]);
    expect(homeNote(remote.desks()[0])).toBe("waiting for Mac mini");
    state.lists.desks = [desk("conv-1", "plan the month")];
    remote.setReachable(MINI, true);
    await until(() => remote.desks()[0]?.reachable === true);
    expect(remote.desks()[0].title).toBe("plan the month");
    expect(homeNote(remote.desks()[0])).toBe("on Mac mini");
  });

  test("a failed fetch marks the Mac out of reach", async () => {
    const { remote, state } = fixture();
    await remote.refresh(MINI);
    state.reachable = false;
    await remote.refresh(MINI);
    expect(remote.desks().map((d) => d.reachable)).toEqual([false]);
  });

  test("unpairing a Mac takes its chats off every list", async () => {
    const { remote, state } = fixture();
    await remote.refresh(MINI);
    const before = state.changes;
    remote.sync([]);
    expect(remote.desks()).toEqual([]);
    expect(remote.inbox()).toEqual([]);
    expect(state.changes).toBe(before + 1);
  });

  test("a push that may change the Mac's chats fetches them again; one that cannot, does not", async () => {
    const { remote, state } = fixture();
    await remote.refresh(MINI);
    state.lists.desks = [desk("conv-1", "renamed")];
    remote.heard(MINI, { type: "peers" });
    await new Promise((r) => setTimeout(r, 20));
    expect(remote.desks()[0].title).toBe("plan the week");
    remote.heard(MINI, { type: "chat_event" });
    await until(() => remote.desks()[0]?.title === "renamed");
  });

  test("says which Mac a chat or a canvas lives on, and nothing for this Mac's own", async () => {
    const { remote } = fixture();
    await remote.refresh(MINI);
    expect(remote.homeOf("conv-1", "agent-ira")).toEqual({ mac: MINI, reachable: true });
    expect(remote.homeOf("conv-1", "agent-friday")).toBeNull();
    expect(remote.homeOf("conv-9")).toBeNull();
    expect(remote.homeOfScope("conv-1")).toEqual({ mac: MINI, reachable: true });
    expect(homeNote({})).toBeNull();
  });
});
