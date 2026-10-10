import { describe, expect, test } from "vitest";
import { createBridge } from "../mod/bridge.ts";
import { fail, reply, type FrameHandlers } from "../mod/frames/context.ts";
import { bridgeWith, client, settled } from "./fixtures/frames.ts";

describe("the frame router", () => {
  test("a request's reply goes out under the table's name, with its requestId", () => {
    const skills: FrameHandlers = { skills_global: () => reply({ skills: [{ name: "unslop", path: "/skills/unslop", isLink: false, description: null }] }) };
    const { bridge } = bridgeWith({ modules: [skills] });
    const c = client("d1");
    bridge.onMessage(c, { type: "skills_global", requestId: "r1" });
    expect(c.sent.at(-1)).toEqual({ type: "skills_global", requestId: "r1", skills: [{ name: "unslop", path: "/skills/unslop", isLink: false, description: null }] });
  });

  test("every way a request can fail answers error with its requestId: refused, malformed, failed, thrown, rejected", async () => {
    const agents: FrameHandlers = {
      memory_read: ({ agentId, path }) => (path === "gone.md" ? fail("no such file") : path === "boom.md" ? (() => { throw new Error("disk on fire"); })() : reply({ agentId, path, content: "x" })),
      skill_install: async () => {
        throw new Error("the installer crashed");
      },
    };
    const { bridge } = bridgeWith({ modules: [agents] });
    const c = client("d1");
    bridge.onMessage(c, { type: "memory_read", requestId: "r1", agentId: "agent-1" });
    expect(c.sent.at(-1)).toEqual({ type: "error", requestId: "r1", message: "path required" });
    bridge.onMessage(c, { type: "memory_read", requestId: "r2", agentId: "agent-1", path: "gone.md" });
    expect(c.sent.at(-1)).toEqual({ type: "error", requestId: "r2", message: "no such file" });
    bridge.onMessage(c, { type: "memory_read", requestId: "r3", agentId: "agent-1", path: "boom.md" });
    expect(c.sent.at(-1)).toEqual({ type: "error", requestId: "r3", message: "disk on fire" });
    bridge.onMessage(c, { type: "skill_install", requestId: "r4", agentId: "agent-1", source: "x" });
    await settled();
    expect(c.sent.at(-1)).toEqual({ type: "error", requestId: "r4", message: "the installer crashed" });
    const phone = client("d1", "dev-1");
    bridge.onMessage(phone, { type: "skill_install", requestId: "r5", agentId: "agent-1", source: "x" });
    expect(phone.sent.at(-1)).toEqual({ type: "error", requestId: "r5", message: "skill_install is not available on the phone" });
  });

  test("a send that is malformed, or whose handler fails, answers an error push without a requestId", () => {
    const lan: FrameHandlers = { lan_via_set: () => { throw new Error("the listener is closing"); } };
    const { bridge } = bridgeWith({ modules: [lan] });
    const c = client("d1");
    bridge.onMessage(c, { type: "lan_via_set", via: "bluetooth" });
    expect(c.sent.at(-1)).toEqual({ type: "error", message: 'via must be "tailscale" or "lan"' });
    bridge.onMessage(c, { type: "lan_via_set", via: "lan" });
    expect(c.sent.at(-1)).toEqual({ type: "error", message: "the listener is closing" });
  });

  test("a frame two modules answer is refused when the bridge is built", () => {
    const a: FrameHandlers = { seen_list: () => {} };
    const b: FrameHandlers = { seen_list: () => {} };
    expect(() => createBridge({ broadcast: () => {}, modules: [a, b] })).toThrow("two handlers for seen_list");
  });
});
