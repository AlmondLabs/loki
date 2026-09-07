import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAN_BOOT_SCRIPT, createStaticApp, resolveAppDist } from "../mod/static.ts";

const INDEX = `<!doctype html><html><head><meta charset="utf-8"><title>loki</title></head><body><div id="root"></div></body></html>`;

async function serve(dist: string | null): Promise<{ server: Server; base: string }> {
  const handle = createStaticApp(dist);
  const server = createServer((req, res) => handle(req, res, new URL(req.url ?? "/", "http://127.0.0.1")));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

describe("static app", () => {
  let dir: string;
  let dist: string;
  let served: { server: Server; base: string };
  let empty: { server: Server; base: string };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "loki-static-"));
    dist = join(dir, "dist");
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(join(dist, "index.html"), INDEX);
    writeFileSync(join(dist, "assets", "x.js"), "console.log(1)");
    writeFileSync(join(dist, "assets", "x.css"), "body{}");
    writeFileSync(join(dist, "manifest.webmanifest"), "{}");
    writeFileSync(join(dist, "icon.svg"), "<svg/>");
    writeFileSync(join(dir, "secret.txt"), "nope");
    served = await serve(dist);
    empty = await serve(null);
  });
  afterAll(() => {
    served.server.close();
    empty.server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("resolveAppDist takes the first candidate with an index.html", () => {
    expect(resolveAppDist([join(dir, "missing"), dist, join(dir, "other")])).toBe(dist);
    expect(resolveAppDist([join(dir, "missing")])).toBeNull();
    expect(resolveAppDist([])).toBeNull();
  });

  test("index.html carries the LAN boot script for / and for SPA routes", async () => {
    for (const path of ["/", "/inbox", "/c/conv_1", "/?code=ABC234"]) {
      const res = await fetch(`${served.base}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      const html = await res.text();
      expect(html).toContain(`${LAN_BOOT_SCRIPT}</head>`);
      expect(html).toContain('<div id="root">');
    }
    expect(LAN_BOOT_SCRIPT).toBe("<script>window.__LOKI__={lan:true}</script>");
  });

  test("assets are served with their content type and immutable caching", async () => {
    const js = await fetch(`${served.base}/assets/x.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("application/javascript");
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await js.text()).toBe("console.log(1)");
    const css = await fetch(`${served.base}/assets/x.css`);
    expect(css.headers.get("content-type")).toContain("text/css");
    const manifest = await fetch(`${served.base}/manifest.webmanifest`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("content-type")).toContain("application/manifest+json");
    expect(manifest.headers.get("cache-control")).toBe("no-cache");
    const svg = await fetch(`${served.base}/icon.svg`);
    expect(svg.headers.get("content-type")).toContain("image/svg+xml");
  });

  test("a missing file with an extension is 404; traversal never leaves the dist", async () => {
    expect((await fetch(`${served.base}/assets/nope.js`)).status).toBe(404);
    expect((await fetch(`${served.base}/assets/../../secret.txt`)).status).toBe(404);
    expect((await fetch(`${served.base}/assets/..%2F..%2Fsecret.txt`)).status).toBe(404);
    expect((await fetch(`${served.base}/%2e%2e/secret.txt`)).status).toBe(404);
    expect((await fetch(`${served.base}/assets/%zz.js`)).status).toBe(404);
  });

  test("without a dist, / answers a 503 page that says how to build one", async () => {
    const res = await fetch(`${empty.base}/`);
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("bun run build:app");
    expect((await fetch(`${empty.base}/assets/x.js`)).status).toBe(503);
  });
});
