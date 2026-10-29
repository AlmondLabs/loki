import { createServer } from "node:http";
import { describe, expect, test } from "vitest";
import type { Scope } from "../core/desk-core.ts";
import type { Audience, LokiServer, WsBridge } from "../mod/server.ts";
import { Sockets, type PhoneListener } from "../mod/sockets.ts";

/** A listener that records what it was asked to send, and whether it was closed. */
function fakeListener(name: string, sent: string[]) {
  const record = (msg: object, scope?: Scope, to: Audience = "all") => sent.push(`${name}:${(msg as { type: string }).type}:${scope ?? "-"}:${to}`);
  const bridge: WsBridge = {
    broadcast: record,
    clientCount: () => 2,
    closeDevice: () => 0,
    closeDevices: () => 0,
    closePeer: () => 0,
    close: () => sent.push(`${name}:closed`),
  };
  const phones: PhoneListener = {
    broadcast: record,
    clientCount: () => 1,
    stop: () => Promise.resolve(sent.push(`${name}:stopped`)),
  };
  return { bridge, phones };
}

const fakeServer = (closed: string[]): LokiServer => ({
  server: createServer(),
  port: 0,
  close: () => Promise.resolve(void closed.push("server")),
});

describe("the mod's sockets (plan 052)", () => {
  test("each push reaches only its audience: a Mac's frame never goes to a tab, or past the LAN listener's Macs", async () => {
    const sent: string[] = [];
    const sockets = new Sockets();
    await sockets.serve(
      () => Promise.resolve(fakeServer([])),
      () => fakeListener("desktop", sent).bridge,
    );
    sockets.attachPhones(fakeListener("lan", sent).phones);
    sockets.push({ type: "desks" });
    sockets.push({ type: "widgets" }, { scope: "c1" });
    sockets.push({ type: "lan_status" }, { to: "desktop" });
    sockets.push({ type: "group_changed" }, { to: "macs" });
    expect(sent).toEqual([
      "desktop:desks:-:all",
      "lan:desks:-:all",
      "desktop:widgets:c1:all",
      "lan:widgets:c1:all",
      "desktop:lan_status:-:all",
      "lan:group_changed:-:macs",
    ]);
    expect(sockets.tabs()).toBe(2);
  });

  test("before the listeners are up a push goes nowhere, and asking for the phone listener says it is not up", () => {
    const sockets = new Sockets();
    sockets.push({ type: "desks" });
    expect(sockets.tabs()).toBe(0);
    expect(sockets.phoneListener()).toBeNull();
    expect(() => sockets.phones()).toThrow(/not up yet/);
  });

  test("a server that comes up after the mod stopped is closed, so the next mod can have the port", async () => {
    const closed: string[] = [];
    const sockets = new Sockets();
    let up: (s: LokiServer) => void = () => {};
    const serving = sockets.serve(
      () => new Promise<LokiServer>((resolve) => (up = resolve)),
      () => fakeListener("desktop", []).bridge,
    );
    sockets.stop();
    up(fakeServer(closed));
    await expect(serving).rejects.toThrow(/stopped while its server was starting/);
    expect(closed).toEqual(["server"]);
  });

  test("stopping closes the tabs' sockets, the server and the phone listener", async () => {
    const sent: string[] = [];
    const closed: string[] = [];
    const sockets = new Sockets();
    await sockets.serve(
      () => Promise.resolve(fakeServer(closed)),
      () => fakeListener("desktop", sent).bridge,
    );
    sockets.attachPhones(fakeListener("lan", sent).phones);
    sockets.stop();
    expect(sent).toEqual(["desktop:closed", "lan:stopped"]);
    expect(closed).toEqual(["server"]);
  });
});
