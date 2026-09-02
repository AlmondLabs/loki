import { describe, expect, test, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { startServer, type LociServer } from "../src/server";

const FIXTURE_ROOT = "/tmp/loci-test-web";
const servers: LociServer[] = [];

function fixtureWebRoot(): string {
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  mkdirSync(`${FIXTURE_ROOT}/assets`, { recursive: true });
  writeFileSync(`${FIXTURE_ROOT}/index.html`, "<html><body>loci-fixture</body></html>");
  writeFileSync(`${FIXTURE_ROOT}/assets/main.js`, "console.log('loci')");
  return FIXTURE_ROOT;
}

async function start(): Promise<LociServer> {
  const s = await startServer({ port: 0, webRoot: fixtureWebRoot() });
  servers.push(s);
  return s;
}

afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

describe("loci server", () => {
  test("serves index only with the token", async () => {
    const s = await start();
    const noToken = await fetch(`http://127.0.0.1:${s.port}/`);
    expect(noToken.status).toBe(403);

    const badToken = await fetch(`http://127.0.0.1:${s.port}/?t=wrong`);
    expect(badToken.status).toBe(403);

    const ok = await fetch(s.url);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("loci-fixture");
  });

  test("serves assets and 404s the rest", async () => {
    const s = await start();
    const asset = await fetch(`http://127.0.0.1:${s.port}/assets/main.js`);
    expect(asset.status).toBe(200);

    const missing = await fetch(`http://127.0.0.1:${s.port}/nope`);
    expect(missing.status).toBe(404);
  });

  test("rejects path traversal", async () => {
    const s = await start();
    const evil = await fetch(`http://127.0.0.1:${s.port}/assets/..%2F..%2Fetc%2Fpasswd`);
    expect([400, 404]).toContain(evil.status);
  });

  test("binds ephemeral ports without collision (reload safety)", async () => {
    const a = await start();
    const b = await start();
    expect(a.port).not.toBe(b.port);
    await a.close();
    await b.close();
  });
});

describe("token stability", () => {
  test("uses a provided token verbatim", async () => {
    const s = await startServer({ port: 0, webRoot: fixtureWebRoot(), token: "a".repeat(32) });
    servers.push(s);
    expect(s.url).toContain(`t=${"a".repeat(32)}`);
    const ok = await fetch(s.url);
    expect(ok.status).toBe(200);
  });
});
