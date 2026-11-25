import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { checksumOf, installNode, msiOutcome, NodeInstalls, pickInstaller, type NodeInstallHost } from "../desktop/node-install.ts";
import type { PageOs } from "../desktop/env.ts";

const INDEX = [
  { version: "v27.0.0", lts: false, files: ["osx-x64-pkg", "win-x64-msi"] },
  { version: "v26.13.1", lts: "Lithium", files: ["osx-x64-pkg", "win-x64-msi", "linux-x64"] },
  { version: "v24.22.3", lts: "Krypton", files: ["osx-x64-pkg", "win-x64-msi"] },
];
const PKG = new TextEncoder().encode("the node pkg");
const sums = (bytes: Uint8Array, file = "node-v26.13.1.pkg") => `${createHash("sha256").update(bytes).digest("hex")}  ${file}\nabc  other\n`;

function fakeHost(os: PageOs, opts: { body?: Uint8Array; sums?: string; exit?: number | null; changeOnDisk?: boolean } = {}) {
  const ran: string[][] = [];
  const written = new Map<string, Uint8Array>();
  const removed: string[] = [];
  const fetched: string[] = [];
  const body = opts.body ?? PKG;
  const host: NodeInstallHost = {
    os,
    fetch: (url) => {
      fetched.push(url);
      if (url.endsWith("index.json")) return Promise.resolve(Response.json(INDEX));
      if (url.endsWith("SHASUMS256.txt"))
        return Promise.resolve(new Response(opts.sums ?? sums(body, os === "windows" ? "node-v26.13.1-x64.msi" : "node-v26.13.1.pkg")));
      return Promise.resolve(new Response(new Blob([new Uint8Array(body)])));
    },
    folder: () => Promise.resolve("/private/loki-node-1"),
    write: (file, bytes) => {
      written.set(file, opts.changeOnDisk ? new TextEncoder().encode("swapped") : bytes);
      return Promise.resolve();
    },
    read: (file) => Promise.resolve(written.get(file) ?? new Uint8Array()),
    remove: (folder) => {
      removed.push(folder);
      return Promise.resolve();
    },
    run: (command, args) => {
      ran.push([command, ...args]);
      return Promise.resolve(opts.exit === undefined ? 0 : opts.exit);
    },
    log: () => {},
  };
  return { host, ran, removed, fetched };
}

describe("choosing nodejs.org's installer", () => {
  test("the newest LTS wins over a newer Current: the .pkg on the Mac, the x64 .msi on Windows", () => {
    expect(pickInstaller(INDEX, "macos")).toEqual({
      version: "v26.13.1",
      file: "node-v26.13.1.pkg",
      url: "https://nodejs.org/dist/v26.13.1/node-v26.13.1.pkg",
      sums: "https://nodejs.org/dist/v26.13.1/SHASUMS256.txt",
    });
    expect(pickInstaller(INDEX, "windows")?.file).toBe("node-v26.13.1-x64.msi");
  });

  test("Linux gets no installer, and a malformed index none either", () => {
    expect(pickInstaller(INDEX, "linux")).toBeNull();
    expect(pickInstaller({ nope: 1 }, "macos")).toBeNull();
  });

  test("the checksum is the one listed for that file", () => {
    expect(checksumOf(sums(PKG), "node-v26.13.1.pkg")).toBe(createHash("sha256").update(PKG).digest("hex"));
    expect(checksumOf("abc  node-v26.13.1.pkg", "node-v26.13.1.pkg")).toBeNull();
  });
});

describe("installing Node", () => {
  test("covers AE1: the Mac opens the checked installer and waits for it to close, then the folder goes", async () => {
    const { host, ran, removed } = fakeHost("macos");
    expect(await installNode(host)).toEqual({ kind: "opened" });
    expect(ran).toEqual([["open", "-W", join("/private/loki-node-1", "node-v26.13.1.pkg")]]);
    expect(removed).toEqual(["/private/loki-node-1"]);
  });

  test("a download that does not match the checksum opens nothing", async () => {
    const { host, ran } = fakeHost("macos", { sums: sums(new TextEncoder().encode("something else")) });
    expect(await installNode(host)).toEqual({ kind: "failed", message: "node-v26.13.1.pkg did not match nodejs.org's checksum" });
    expect(ran).toEqual([]);
  });

  test("a file that changes on disk before it opens is not opened", async () => {
    const { host, ran, removed } = fakeHost("macos", { changeOnDisk: true });
    expect(await installNode(host)).toEqual({ kind: "failed", message: "node-v26.13.1.pkg changed before it opened" });
    expect(ran).toEqual([]);
    expect(removed).toEqual(["/private/loki-node-1"]);
  });

  test("a failed download says so and opens nothing", async () => {
    const { host, ran } = fakeHost("macos");
    host.fetch = () => Promise.reject(new Error("offline"));
    expect(await installNode(host)).toEqual({ kind: "failed", message: "loki could not get Node: Error: offline" });
    expect(ran).toEqual([]);
  });

  test("Windows runs msiexec and reads its answer: 0 or 3010 installed, 1602 cancelled, anything else failed", async () => {
    const { host, ran } = fakeHost("windows", { exit: 3010 });
    expect(await installNode(host)).toEqual({ kind: "installed" });
    expect(ran).toEqual([["msiexec", "/i", join("/private/loki-node-1", "node-v26.13.1-x64.msi")]]);
    expect(msiOutcome(0)).toEqual({ kind: "installed" });
    expect(msiOutcome(1602)).toEqual({ kind: "cancelled" });
    expect(msiOutcome(1603)).toMatchObject({ kind: "failed" });
  });

  test("a second Install Node while one is running joins the first", async () => {
    const { host, fetched } = fakeHost("macos");
    const installs = new NodeInstalls(host);
    const [a, b] = await Promise.all([installs.install(), installs.install()]);
    expect(a).toBe(b);
    expect(fetched.filter((u) => u.endsWith("index.json"))).toHaveLength(1);
  });
});
