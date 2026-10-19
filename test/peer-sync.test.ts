import { describe, expect, test } from "vitest";
import { PeerSync, type PeerSyncer } from "../mod/peer-sync.ts";

const MINI = "bbbbbbbb-2222-4222-8222-222222222222";

/** A step that logs its start, waits for `release`, then logs its end (or fails, when `fail`). */
function gate(log: string[], name: string, fail = false) {
  let release = () => {};
  const done = new Promise<void>((r) => (release = r));
  const run = async () => {
    log.push(`${name} start`);
    await done;
    log.push(`${name} end`);
    if (fail) throw new Error(`${name} failed`);
  };
  return { run, release };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("a paired Mac coming into reach", () => {
  test("agents, then their memory, then the chats that move with them; state alongside, waiting for none", async () => {
    const log: string[] = [];
    const [agents, memory, moves, state] = [gate(log, "agents"), gate(log, "memory"), gate(log, "moves"), gate(log, "state")];
    const sync = new PeerSync(
      [
        { name: "agents", reached: agents.run },
        { name: "memory", after: "agents", reached: memory.run },
        { name: "moves", after: "memory", reached: moves.run },
        { name: "state", reached: state.run },
      ],
      () => {},
    );
    const all = sync.reached(MINI);
    await tick();
    expect(log).toEqual(["agents start", "state start"]);
    agents.release();
    await tick();
    expect(log).toContain("memory start");
    expect(log).not.toContain("moves start");
    memory.release();
    moves.release();
    state.release();
    await all;
    expect(log.indexOf("memory end")).toBeLessThan(log.indexOf("moves start"));
  });

  test("a syncer that fails is reported, and the one waiting for it still runs", async () => {
    const log: string[] = [];
    const reported: string[] = [];
    const agents = gate(log, "agents", true);
    const memory = gate(log, "memory");
    const sync = new PeerSync(
      [
        { name: "agents", reached: agents.run },
        { name: "memory", after: "agents", reached: memory.run },
      ],
      (name, mac, err) => reported.push(`${name}@${mac}: ${err instanceof Error ? err.message : String(err)}`),
    );
    const all = sync.reached(MINI);
    agents.release();
    memory.release();
    await all;
    expect(reported).toEqual([`agents@${MINI}: agents failed`]);
    expect(log).toContain("memory end");
  });
});

describe("a push from a paired Mac", () => {
  test("wakes only the syncers that name it, with the frame as sent", async () => {
    const heard: string[] = [];
    const syncers: PeerSyncer[] = [
      { name: "memory", pushes: { memory_changed: (mac, f) => heard.push(`memory ${mac} ${f.agent_id}`) } },
      { name: "state", pushes: { state_changed: () => heard.push("state") } },
    ];
    const sync = new PeerSync(syncers, () => {});
    await sync.heard(MINI, { type: "memory_changed", agent_id: "agent-ira" });
    await sync.heard(MINI, { type: "chat_event", events: [] });
    expect(heard).toEqual([`memory ${MINI} agent-ira`]);
  });
});

describe("the syncers as declared", () => {
  test("one waiting for a syncer that does not come before it, or two of one name, is refused at once", () => {
    expect(() => new PeerSync([{ name: "memory", after: "agents" }, { name: "agents" }], () => {})).toThrow(/memory waits for agents/);
    expect(() => new PeerSync([{ name: "state" }, { name: "state" }], () => {})).toThrow(/two syncers named state/);
  });
});
