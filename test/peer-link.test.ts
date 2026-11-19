import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocketServer, type WebSocket } from "../mod/ws.ts";
import { PeerLink, type LinkStatus } from "../mod/peer-link.ts";

const PROTOCOL = 1;
let server: WebSocketServer;
let url = "";
const sockets = new Set<WebSocket>();

beforeAll(async () => {
  server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("the test server has no port");
  url = `ws://127.0.0.1:${address.port}/ws`;
  server.on("connection", (ws) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    ws.on("message", (raw) => {
      const frame: unknown = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : "{}");
      if (typeof frame !== "object" || frame === null || !("type" in frame) || frame.type !== "peer_ping") return;
      ws.send(JSON.stringify({ type: "peer_pong", request_id: "request_id" in frame ? frame.request_id : null, protocol: PROTOCOL }));
    });
  });
});

afterAll(async () => {
  for (const ws of sockets) ws.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

function escapes() {
  const seen: unknown[] = [];
  const add = (error: unknown) => void seen.push(error);
  process.on("unhandledRejection", add);
  process.on("uncaughtException", add);
  return {
    seen,
    off: () => {
      process.off("unhandledRejection", add);
      process.off("uncaughtException", add);
    },
  };
}

function watched(opts: { token?: () => Promise<string | null>; throwOn?: LinkStatus } = {}) {
  const statuses: LinkStatus[] = [];
  const waiters: Array<() => boolean> = [];
  const link = new PeerLink({
    macId: "mac-mini",
    url: () => url,
    token: opts.token ?? (() => Promise.resolve("token")),
    protocol: PROTOCOL,
    minBackoffMs: 1,
    onStatus: (status) => {
      statuses.push(status);
      waiters.push(...waiters.splice(0).filter((done) => !done()));
      if (status === opts.throwOn) throw new Error(`the ${status} listener broke`);
    },
  });
  const reached = (status: LinkStatus, times = 1) =>
    new Promise<void>((resolve) => {
      const done = () => {
        if (statuses.filter((s) => s === status).length < times) return false;
        resolve();
        return true;
      };
      if (!done()) waiters.push(done);
    });
  return { link, statuses, reached };
}

describe("a link to another Mac", () => {
  test("a token lookup that throws counts as a failed attempt: the link says it is out of reach and tries again", async () => {
    let lookups = 0;
    const w = watched({ token: () => (++lookups === 1 ? Promise.reject(new Error("the keychain is locked")) : Promise.resolve("token")) });
    try {
      w.link.start();
      await w.reached("reachable");
      expect(w.statuses).toEqual(["unreachable", "reachable"]);
      expect(lookups).toBe(2);
    } finally {
      w.link.stop();
    }
  });

  test("a status listener that throws when the first ping answers leaves no unhandled rejection, and the link stays reachable", async () => {
    const escaped = escapes();
    const w = watched({ throwOn: "reachable" });
    try {
      w.link.start();
      await w.reached("reachable");
      await nextTurn();
      expect(escaped.seen).toEqual([]);
      expect(w.link.status).toBe("reachable");
    } finally {
      w.link.stop();
      escaped.off();
    }
  });

  test("a status listener that throws when the socket closes throws nothing out of the handler, and the link tries again", async () => {
    const escaped = escapes();
    const w = watched({ throwOn: "unreachable" });
    try {
      w.link.start();
      await w.reached("reachable");
      for (const ws of sockets) ws.close();
      await w.reached("reachable", 2);
      expect(w.statuses).toEqual(["reachable", "unreachable", "reachable"]);
      expect(escaped.seen).toEqual([]);
    } finally {
      w.link.stop();
      escaped.off();
    }
  });
});
