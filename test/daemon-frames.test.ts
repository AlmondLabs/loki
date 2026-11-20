import { describe, expect, test } from "vitest";
import type { RestartAnswer } from "../mod/frames/daemon.ts";
import type { Client } from "../mod/server.ts";
import { bridgeOf } from "./fixtures/frames.ts";

function restarting(answer: RestartAnswer) {
  const frames: unknown[] = [];
  const steps: Array<() => void> = [];
  const client: Client = {
    scope: "c1",
    send: (frame, sent) => {
      frames.push(frame);
      if (sent) steps.push(sent);
    },
  };
  const bridge = bridgeOf({ daemon: { restartDue: () => null, restart: () => Promise.resolve(answer) } });
  const ask = async () => {
    bridge.onMessage(client, { type: "daemon_restart", request_id: "r1", anyway: false });
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return { frames, steps, ask };
}

describe("updating a checkout's loki from the window", () => {
  test("a restart is handed to the socket with the reply, to run once the reply is written", async () => {
    let restarts = 0;
    const r = restarting({ code: "restart", restart: () => restarts++ });
    await r.ask();
    expect(r.frames).toEqual([{ type: "chat_done", request_id: "r1" }]);
    expect(restarts).toBe(0);
    expect(r.steps).toHaveLength(1);
    r.steps[0]();
    expect(restarts).toBe(1);
  });

  test("an update with nothing to restart answers with no step after it", async () => {
    const r = restarting({ code: "updated" });
    await r.ask();
    expect(r.frames).toEqual([{ type: "chat_done", request_id: "r1" }]);
    expect(r.steps).toEqual([]);
  });

  test("a refused restart answers with the reason and no step after it", async () => {
    const r = restarting({ code: "not_updated", reason: "a chat is still working or waiting for you: updating now cuts it off" });
    await r.ask();
    expect(r.frames).toEqual([{ type: "error", request_id: "r1", message: "a chat is still working or waiting for you: updating now cuts it off" }]);
    expect(r.steps).toEqual([]);
  });
});
