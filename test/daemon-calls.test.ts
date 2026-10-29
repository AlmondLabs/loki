import { describe, expect, test } from "vitest";
import type { FrameRequest } from "../core/attention/chat-client.ts";
import { daemonCalls } from "../core/daemon-calls.ts";
import type { RequestResult } from "../core/frames.ts";

/** A mod socket that records each request and answers from `replies` by its type; a type with none is refused. */
function fakeRequest(replies: Record<string, unknown>) {
  const sent: Array<{ type: string; payload: unknown }> = [];
  const request = ((type: string, payload: unknown) => {
    sent.push({ type, payload });
    const reply = replies[type];
    const result: RequestResult<unknown> = reply === undefined ? { ok: false, error: `no ${type} here`, timed_out: false } : { ok: true, reply };
    return Promise.resolve(result);
  }) as FrameRequest;
  return { request, sent };
}

describe("the daemon's settings calls (plan 049)", () => {
  test("a call that only takes answers null, or the mod's reason in words", async () => {
    const { request, sent } = fakeRequest({ chat_memory_write: { type: "chat_done" } });
    const calls = daemonCalls(request);
    expect(await calls.memory.write("ada", "system/a.md", "hi", "why")).toBeNull();
    expect(await calls.memory.remove("ada", "system/a.md")).toBeNull();
    expect(await calls.memory.revert("ada", "abc")).toBe("no chat_memory_revert here");
    expect(sent.map((s) => s.payload)).toEqual([
      { agent_id: "ada", path: "system/a.md", content: "hi", message: "why" },
      { agent_id: "ada", path: "system/a.md", content: null, message: undefined },
      { agent_id: "ada", sha: "abc" },
    ]);
  });

  test("a call that answers with what now stands gives its reply, a secret its reference, the approvals their list", async () => {
    const view = { type: "chat_mcp", servers: [] };
    const { request } = fakeRequest({ chat_mcp_get: view, chat_mcp_secret: { ref: "${keychain:notes}" }, chat_approvals_get: { always: ["read"] } });
    const calls = daemonCalls(request);
    expect(await calls.mcp.get()).toEqual(view);
    expect(await calls.mcp.secret("notes", "s3cret")).toEqual({ ref: "${keychain:notes}" });
    expect(await calls.mcp.approvals.list()).toEqual(["read"]);
    // Refused, each says why rather than throwing.
    expect(await calls.mcp.restart("notes")).toBe("no chat_mcp_restart here");
    expect(await calls.engines.check("fake")).toBe("no chat_engine_check here");
    expect(await calls.mcp.approvals.set("read", false)).toBe("no chat_approvals_set here");
  });
});
