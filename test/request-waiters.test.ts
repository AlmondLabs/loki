import { describe, expect, test } from "vitest";
import { LINK_CLOSED, RequestWaiters } from "../app/src/desk/request-waiters.ts";

describe("requests waiting on the mod's answer", () => {
  test("an answer goes to whoever asked, once", () => {
    const w = new RequestWaiters<string>();
    const got: unknown[] = [];
    w.wait("r1", (m) => got.push(m));
    w.sent("r1", "socket-a");
    expect(w.answer("r1", { type: "desks", request_id: "r1" })).toBe(true);
    expect(w.answer("r1", { type: "desks", request_id: "r1" })).toBe(false);
    expect(got).toEqual([{ type: "desks", request_id: "r1" }]);
  });

  test("a socket that closes answers what went out on it with an error; the rest keeps waiting", () => {
    const w = new RequestWaiters<string>();
    const got: Array<[string, unknown]> = [];
    for (const id of ["on-a", "on-b", "not-sent", "timed-out"]) w.wait(id, (m) => got.push([id, m]));
    w.sent("on-a", "socket-a");
    w.sent("on-b", "socket-b");
    w.sent("timed-out", "socket-a");
    w.drop("timed-out");
    w.closed("socket-a");
    expect(got).toEqual([["on-a", { type: "error", request_id: "on-a", message: LINK_CLOSED }]]);
    // The chat switch's new socket carries the request that had not gone out, and the other socket's answer still lands.
    w.sent("not-sent", "socket-b");
    expect(w.answer("not-sent", { type: "ok" })).toBe(true);
    expect(w.answer("on-b", { type: "ok" })).toBe(true);
  });

  test("a request made with no socket open goes out as the next one opens, once, and is then that socket's", () => {
    const w = new RequestWaiters<string>();
    const got: unknown[] = [];
    w.wait("early", (m) => got.push(m));
    w.hold("early", { type: "history_get", request_id: "early" });
    w.wait("gave-up", () => {});
    w.hold("gave-up", { type: "desks", request_id: "gave-up" });
    w.drop("gave-up");
    const out: object[] = [];
    w.flush("socket-a", (f) => out.push(f));
    w.flush("socket-a", (f) => out.push(f));
    expect(out).toEqual([{ type: "history_get", request_id: "early" }]);
    w.closed("socket-a");
    expect(got).toEqual([{ type: "error", request_id: "early", message: LINK_CLOSED }]);
  });
});
