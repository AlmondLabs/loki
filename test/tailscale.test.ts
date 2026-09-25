import { describe, expect, test } from "bun:test";
import { Tailscale, findTailscale, parseServeStatus, parseStatus } from "../mod/tailscale.ts";
import { SERVE_41415, STATUS_RUNNING, STATUS_STOPPED } from "./fixtures/tailscale.ts";

describe("tailscale status parsing", () => {
  test("running: ip, MagicDNS name lower-cased without the dot", () => {
    expect(parseStatus(STATUS_RUNNING)).toEqual({ running: true, ip: "100.101.102.103", name: "my-macbook-pro.tail1234.ts.net" });
  });

  test("stopped: not running, but the name is still known", () => {
    expect(parseStatus(STATUS_STOPPED)).toEqual({ running: false, ip: "100.101.102.103", name: "my-macbook-pro.tail1234.ts.net" });
  });

  test("garbage, empty, or a shape without Self", () => {
    expect(parseStatus("not json")).toEqual({ running: false, ip: null, name: null });
    expect(parseStatus("")).toEqual({ running: false, ip: null, name: null });
    expect(parseStatus("null")).toEqual({ running: false, ip: null, name: null });
    expect(parseStatus(JSON.stringify({ BackendState: "NeedsLogin" }))).toEqual({ running: false, ip: null, name: null });
    expect(parseStatus(JSON.stringify({ BackendState: "Running", Self: { TailscaleIPs: ["fd7a:115c:a1e0::1"] } }))).toEqual({ running: true, ip: null, name: null });
  });
});

describe("tailscale serve status parsing", () => {
  const name = "my-macbook-pro.tail1234.ts.net";

  test("a / handler proxying 443 to the listener's port is the https front", () => {
    expect(parseServeStatus(SERVE_41415, name, 41415)).toBe("https://my-macbook-pro.tail1234.ts.net");
    expect(parseServeStatus(SERVE_41415, name)).toBe("https://my-macbook-pro.tail1234.ts.net"); // any port when none given
    expect(parseServeStatus(SERVE_41415, "My-MacBook-Pro.tail1234.ts.net", 41415)).toBe("https://my-macbook-pro.tail1234.ts.net");
    // the Web entry alone is proof; TCP is not required
    expect(parseServeStatus(JSON.stringify({ Web: { [`${name}:443`]: { Handlers: { "/": { Proxy: "http://localhost:41415" } } } } }), name, 41415)).toBe(`https://${name}`);
  });

  test("another port, another site, another path, no serve, garbage → null", () => {
    expect(parseServeStatus(SERVE_41415, name, 3000)).toBeNull();
    expect(parseServeStatus(SERVE_41415, "other.tail1234.ts.net", 41415)).toBeNull();
    expect(parseServeStatus(SERVE_41415, null, 41415)).toBeNull();
    expect(parseServeStatus(JSON.stringify({ Web: { [`${name}:443`]: { Handlers: { "/api": { Proxy: "http://127.0.0.1:41415" } } } } }), name, 41415)).toBeNull();
    expect(parseServeStatus(JSON.stringify({ Web: { [`${name}:443`]: { Handlers: { "/": { Path: "/Users/x/site" } } } } }), name, 41415)).toBeNull();
    expect(parseServeStatus(JSON.stringify({ Web: { [`${name}:443`]: { Handlers: { "/": { Proxy: "http://10.0.0.2:41415" } } } } }), name, 41415)).toBeNull();
    expect(parseServeStatus("{}", name, 41415)).toBeNull();
    expect(parseServeStatus("", name, 41415)).toBeNull();
    expect(parseServeStatus("nope", name, 41415)).toBeNull();
  });
});

describe("finding the CLI", () => {
  test("tailscale.exe on a Windows PATH; LOKI_TAILSCALE_BIN first", () => {
    const env = { Path: String.raw`C:\Windows\system32;C:\Program Files\Tailscale`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
    const exe = String.raw`C:\Program Files\Tailscale\tailscale.exe`;
    expect(findTailscale({ platform: "win32", env, exists: (p) => p === exe })).toBe(exe);
    expect(findTailscale({ platform: "win32", env: { ...env, LOKI_TAILSCALE_BIN: "D:\\ts.exe" }, exists: () => true })).toBe("D:\\ts.exe");
    expect(findTailscale({ platform: "win32", env, exists: () => false })).toBeNull();
    expect(findTailscale({ platform: "linux", env: { PATH: "/usr/sbin:/usr/bin" }, exists: (p) => p === "/usr/bin/tailscale" })).toBe("/usr/bin/tailscale");
  });
});

describe("Tailscale (injected CLI)", () => {
  function recorded(answers: Record<string, string | Error>, opts: { bin?: string | null; ttlMs?: number; port?: number } = {}) {
    const calls: string[][] = [];
    const ts = new Tailscale({
      bin: opts.bin === undefined ? "/fake/tailscale" : opts.bin,
      port: opts.port ?? 41415,
      ttlMs: opts.ttlMs,
      exec: async (bin, args) => {
        calls.push([bin, ...args]);
        const a = answers[args.join(" ")];
        if (a === undefined) throw new Error(`unexpected: ${args.join(" ")}`);
        if (a instanceof Error) throw a;
        return a;
      },
    });
    return { ts, calls };
  }

  test("no binary: installed false, nothing is run, nothing throws", async () => {
    const { ts, calls } = recorded({}, { bin: null });
    expect(ts.cached()).toEqual({ installed: false, running: false, ip: null, name: null, serveUrl: null, error: null });
    expect(await ts.status()).toEqual({ installed: false, running: false, ip: null, name: null, serveUrl: null, error: null });
    const after = await ts.setServe(true);
    expect(after.installed).toBe(false);
    expect(after.error).toBe("Tailscale is not installed");
    expect(calls).toEqual([]);
  });

  test("the CLI failing: installed, not running, its words in error", async () => {
    const { ts } = recorded({ "status --json": new Error("failed to connect to local tailscaled; it doesn't appear to be running") });
    expect(await ts.status()).toEqual({ installed: true, running: false, ip: null, name: null, serveUrl: null, error: "failed to connect to local tailscaled; it doesn't appear to be running" });
  });

  test("running with an https front; the cache answers the second call", async () => {
    const { ts, calls } = recorded({ "status --json": STATUS_RUNNING, "serve status --json": SERVE_41415 });
    expect(ts.cached().installed).toBe(true);
    const first = await ts.status();
    expect(first).toEqual({ installed: true, running: true, ip: "100.101.102.103", name: "my-macbook-pro.tail1234.ts.net", serveUrl: "https://my-macbook-pro.tail1234.ts.net", error: null });
    expect(await ts.status()).toBe(first);
    expect(calls).toEqual([["/fake/tailscale", "status", "--json"], ["/fake/tailscale", "serve", "status", "--json"]]);
    expect(ts.cached()).toBe(first);
    ts.invalidate();
    await ts.status();
    expect(calls).toHaveLength(4);
  });

  test("stopped: serve status is not even asked", async () => {
    const { ts, calls } = recorded({ "status --json": STATUS_STOPPED });
    expect(await ts.status()).toEqual({ installed: true, running: false, ip: "100.101.102.103", name: "my-macbook-pro.tail1234.ts.net", serveUrl: null, error: null });
    expect(calls).toEqual([["/fake/tailscale", "status", "--json"]]);
  });

  test("serve status failing keeps the node's facts and reports the complaint", async () => {
    const { ts } = recorded({ "status --json": STATUS_RUNNING, "serve status --json": new Error("serve is not enabled on this tailnet") });
    expect(await ts.status()).toEqual({ installed: true, running: true, ip: "100.101.102.103", name: "my-macbook-pro.tail1234.ts.net", serveUrl: null, error: "serve is not enabled on this tailnet" });
  });

  test("setServe runs the exact commands, invalidates, and answers with a fresh status", async () => {
    let served = false;
    const answers: Record<string, string | Error> = { "status --json": STATUS_RUNNING };
    const calls: string[][] = [];
    const ts = new Tailscale({
      bin: "/fake/tailscale",
      port: 41415,
      exec: async (_bin, args) => {
        calls.push(args);
        const key = args.join(" ");
        if (key === "serve --bg --https=443 http://127.0.0.1:41415") return void (served = true), "Available within your tailnet:\n\nhttps://my-macbook-pro.tail1234.ts.net/\n";
        if (key === "serve --https=443 off") return void (served = false), "";
        if (key === "serve status --json") return served ? SERVE_41415 : "{}";
        const a = answers[key];
        if (a === undefined) throw new Error(`unexpected: ${key}`);
        if (a instanceof Error) throw a;
        return a;
      },
    });
    expect((await ts.status()).serveUrl).toBeNull();
    const on = await ts.setServe(true);
    expect(on.serveUrl).toBe("https://my-macbook-pro.tail1234.ts.net");
    expect(on.error).toBeNull();
    expect(calls).toEqual([["status", "--json"], ["serve", "status", "--json"], ["serve", "--bg", "--https=443", "http://127.0.0.1:41415"], ["status", "--json"], ["serve", "status", "--json"]]);
    const off = await ts.setServe(false);
    expect(off.serveUrl).toBeNull();
    expect(calls.at(-3)).toEqual(["serve", "--https=443", "off"]);
    expect(calls.some((c) => c[0] === "funnel")).toBe(false);
  });

  test("setServe failing: the CLI's stderr verbatim (clipped to 400) in error, nothing thrown", async () => {
    const long = "error: ".padEnd(600, "x");
    const { ts } = recorded({ "status --json": STATUS_RUNNING, "serve status --json": "{}", "serve --bg --https=443 http://127.0.0.1:41415": new Error(`\n  ${long}\n`) });
    const s = await ts.setServe(true);
    expect(s.running).toBe(true);
    expect(s.serveUrl).toBeNull();
    expect(s.error).toBe(long.slice(0, 400));
    expect(s.error).toHaveLength(400);
    const { ts: ts2 } = recorded({ "status --json": STATUS_RUNNING, "serve status --json": "{}", "serve --bg --https=443 http://127.0.0.1:41415": new Error("Error: HTTPS is not enabled for this tailnet; enable it in the admin console") });
    expect((await ts2.setServe(true)).error).toBe("Error: HTTPS is not enabled for this tailnet; enable it in the admin console");
  });
});
