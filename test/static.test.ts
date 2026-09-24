import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STALE_RELOAD_SCRIPT, bootScript, buildIdOf, createStaticApp, jsonForScript, resolveAppDist } from "../mod/static.ts";

// These tests open sockets and spawn processes; on a loaded machine (a Rust build beside them, a CI runner) one
// of them has crossed bun's 5 s default. Twenty seconds still catches a hang.
setDefaultTimeout(20_000);

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

  test("resolveAppDist takes the first candidate that is a build: index.html plus assets/", () => {
    // The source app/ has an index.html that points at /src/main.tsx and needs Vite; it must be skipped.
    const source = join(dir, "source-app");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "index.html"), '<script type="module" src="/src/main.tsx"></script>');
    expect(resolveAppDist([join(dir, "missing"), source, dist, join(dir, "other")])).toBe(dist);
    expect(resolveAppDist([source])).toBeNull();
    expect(resolveAppDist([join(dir, "missing")])).toBeNull();
    expect(resolveAppDist([])).toBeNull();
  });

  test("index.html carries the LAN boot script for / and for SPA routes", async () => {
    for (const path of ["/", "/index.html", "/inbox", "/c/conv_1", "/?code=ABC234"]) {
      const res = await fetch(`${served.base}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      const html = await res.text();
      // The boot script carries the build id (a hash of index.html) so the page can tell when a new build is up.
      expect(html).toMatch(/<script>window\.__LOKI__=\{lan:true,build:"[a-f0-9]{12}",os:"(macos|windows|linux)"\}<\/script><\/head>/);
      expect(html).toContain(bootScript(buildIdOf(dist)));
      expect(html).toContain('<div id="root">');
    }
    expect(bootScript(null, "macos")).toBe('<script>window.__LOKI__={lan:true,os:"macos"}</script>');
  });

  test("the boot script cannot be broken out of: `</script>` and friends survive as JavaScript escapes", () => {
    const hostile = '</script><script>alert(1)</script>&\u2028\u2029';
    const script = bootScript(hostile);
    // One script element, opened and closed exactly once: nothing inside it reads as markup.
    expect(script.match(/<\/?script>/g)).toEqual(["<script>", "</script>"]);
    expect(script.startsWith("<script>window.__LOKI__={lan:true,build:")).toBe(true);
    expect(script).not.toContain("&");
    // What the browser evaluates is the original string, character for character.
    const json = jsonForScript(hostile);
    expect(JSON.parse(json)).toBe(hostile);
    expect(new Function(`return ${json}`)()).toBe(hostile);
    expect(jsonForScript({ a: "<b>&c" })).toBe('{"a":"\\u003cb\\u003e\\u0026c"}');
    // A plain hex build id is untouched.
    expect(bootScript("abc123def456", "macos")).toBe('<script>window.__LOKI__={lan:true,build:"abc123def456",os:"macos"}</script>');
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

  test("a hashed script from an earlier build answers with a one-shot reload, never cached; other misses are 404", async () => {
    const stale = await fetch(`${served.base}/assets/boot-OLDHASH.js`);
    expect(stale.status).toBe(200);
    expect(stale.headers.get("content-type")).toContain("javascript");
    expect(stale.headers.get("cache-control")).toBe("no-store");
    expect(await stale.text()).toBe(STALE_RELOAD_SCRIPT);
    expect(STALE_RELOAD_SCRIPT).toContain("location.reload()");
    expect(STALE_RELOAD_SCRIPT).toContain("sessionStorage"); // the loop guard
    expect((await fetch(`${served.base}/assets/nope.css`)).status).toBe(404);
    expect((await fetch(`${served.base}/nope.js`)).status).toBe(404); // only assets/ is hashed
  });

  test("a missing file with an extension is 404; traversal never leaves the dist", async () => {
    expect((await fetch(`${served.base}/assets/nope.png`)).status).toBe(404);
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
