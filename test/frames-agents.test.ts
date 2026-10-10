import { describe, expect, test } from "vitest";
import type { AgentsDeps } from "../mod/frames/agents.ts";
import type { LanDeps } from "../mod/frames/lan.ts";
import { bridgeWith, client, settled } from "./fixtures/frames.ts";

describe("agent and phone-listener frames", () => {
  test("an agent page whose memory tree cannot be read answers error, not silence", async () => {
    const agents = { get: () => ({ id: "agent-1", name: "ira" }), tree: () => { throw new Error("memory is not a git repo"); }, skills: () => [], hasProfile: () => false, read: () => null, log: async () => [], diff: async () => "" } as unknown as NonNullable<AgentsDeps["agents"]>;
    const { bridge } = bridgeWith({ agents });
    const c = client("d1");
    bridge.onMessage(c, { type: "agent_get", requestId: "r1", agentId: "agent-1" });
    await settled();
    expect(c.sent.at(-1)).toEqual({ type: "error", requestId: "r1", message: "memory is not a git repo" });
  });

  test("a listener refresh that fails answers an error push", async () => {
    const lan = { refresh: async () => { throw new Error("tailscale hung"); } } as unknown as NonNullable<LanDeps["lan"]>;
    const { bridge } = bridgeWith({ lan });
    const c = client("d1");
    bridge.onMessage(c, { type: "lan_get" });
    await settled();
    expect(c.sent.at(-1)).toEqual({ type: "error", message: "tailscale hung" });
  });
});
