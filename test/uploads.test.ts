import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dayFolder, freePath, insideDir, safeName, uploadRoute } from "../mod/uploads.ts";
import { tokenAuth } from "../mod/server.ts";
import { crossOrigin } from "../mod/lan.ts";

describe("uploads: names and places", () => {
  test("a name stays one file: no folders, no leading dots, no control characters", () => {
    expect(safeName("../../etc/passwd")).toBe("passwd");
    expect(safeName("C:\\Users\\me\\q3 report.pdf")).toBe("q3 report.pdf");
    expect(safeName(".env")).toBe("env");
    expect(safeName("a\u0000b<c>.txt")).toBe("abc.txt");
    expect(safeName("")).toBe("file");
  });
  test("a taken name gets a number before its extension", () => {
    // In this system's separators: freePath joins with node:path, so Windows' come back as backslashes.
    const taken = new Set([join("/u", "q3.pdf"), join("/u", "q3 (2).pdf")]);
    expect(freePath("/u", "q3.pdf", (p) => taken.has(p))).toBe(join("/u", "q3 (3).pdf"));
    expect(freePath("/u", "notes", () => false)).toBe(join("/u", "notes"));
  });
  test("only paths under the uploads folder count as uploads", () => {
    expect(insideDir("/u", "/u/2026-09-30/a.pdf")).toBe(true);
    expect(insideDir("/u", "/u")).toBe(false);
    expect(insideDir("/u", "/u/../etc/passwd")).toBe(false);
    expect(insideDir("/u", "/elsewhere/a.pdf")).toBe(false);
  });
  test("the day's folder is the local date", () => {
    expect(dayFolder(new Date(2026, 8, 3, 23, 59))).toBe("2026-09-03");
  });
});

describe("uploads: the route", () => {
  let dir: string;
  let server: Server;
  let base: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "loki-uploads-"));
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (!uploadRoute(req, res, url, { authorize: tokenAuth("tok"), dir, denied: 403, maxBytes: 64 })) res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/uploads`;
  });
  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a file lands in the day's folder under its own name, and the reply says where", async () => {
    const res = await fetch(`${base}?t=tok&name=${encodeURIComponent("../notes.txt")}&type=text/plain`, { method: "POST", body: "hello" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; name: string; size: number; mime: string };
    expect(body).toMatchObject({ name: "notes.txt", size: 5, mime: "text/plain" });
    expect(body.path).toBe(join(dir, dayFolder(), "notes.txt"));
    expect(readFileSync(body.path, "utf8")).toBe("hello");
    const again = (await (await fetch(`${base}?t=tok&name=notes.txt`, { method: "POST", body: "second" })).json()) as { name: string };
    expect(again.name).toBe("notes (2).txt");
  });

  test("no token, no upload; too big is refused and leaves nothing behind", async () => {
    expect((await fetch(`${base}?name=x.txt`, { method: "POST", body: "x" })).status).toBe(403);
    const big = await fetch(`${base}?t=tok&name=big.bin`, { method: "POST", body: "x".repeat(65) });
    expect(big.status).toBe(413);
    expect(existsSync(join(dir, dayFolder(), "big.bin"))).toBe(false);
  });

  test("delete removes an upload, and nothing outside the folder", async () => {
    const outside = join(tmpdir(), `loki-outside-${Date.now()}.txt`);
    writeFileSync(outside, "keep");
    expect((await fetch(`${base}?t=tok&path=${encodeURIComponent(outside)}`, { method: "DELETE" })).status).toBe(400);
    expect(existsSync(outside)).toBe(true);
    rmSync(outside);
    mkdirSync(join(dir, "d"), { recursive: true });
    const inside = join(dir, "d", "gone.txt");
    writeFileSync(inside, "x");
    expect((await fetch(`${base}?t=tok&path=${encodeURIComponent(inside)}`, { method: "DELETE" })).status).toBe(200);
    expect(existsSync(inside)).toBe(false);
  });

  test("on the Wi-Fi listener a page from another site is refused (the cookie would ride along)", () => {
    const req = (origin?: string) => ({ headers: { host: "mac.local:41415", ...(origin ? { origin } : {}) } }) as never;
    expect(crossOrigin(req("http://mac.local:41415"))).toBeNull();
    expect(crossOrigin(req())).toBeNull();
    expect(crossOrigin(req("https://evil.example"))).toMatchObject({ status: 403 });
  });
});
