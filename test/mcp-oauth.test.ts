import { describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry } from "@earendil-works/pi-durable";
import { McpTools } from "../daemon/mcp/index.ts";
import { oauthCallbackRoute, oauthPage, startServer } from "../mod/server.ts";
import { answer, TOOLS } from "./fixtures/fake-mcp.mjs";

const until = async (check: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
};

/**
 * An MCP server behind OAuth, as MCP's authorization spec has it: a request without a good bearer is 401 naming its
 * protected-resource metadata, which names the authorization server, which registers clients, authorizes with PKCE
 * (S256) and issues tokens. JSON-RPC itself is the stand-in server's (fixtures/fake-mcp.mjs).
 */
async function oauthServer() {
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const issued = new Set<string>();
  const seen = { registrations: 0, tokenRequests: 0, mcpWithToken: 0 };
  let base = "";
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    const body = await new Promise<string>((r) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => r(b));
    });
    const json = (status: number, value: unknown, headers: Record<string, string> = {}) => res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(value));
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
    if (url.pathname === "/register" && req.method === "POST") {
      seen.registrations++;
      return json(201, { ...JSON.parse(body), client_id: "loki-test-client" });
    }
    if (url.pathname === "/authorize") {
      // The person approves at once: back to loki's callback with a code bound to the PKCE challenge.
      const code = `code-${codes.size + 1}`;
      codes.set(code, { challenge: url.searchParams.get("code_challenge") ?? "", redirect: url.searchParams.get("redirect_uri") ?? "" });
      const back = new URL(url.searchParams.get("redirect_uri")!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      return res.writeHead(302, { location: back.href }).end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      seen.tokenRequests++;
      const p = new URLSearchParams(body);
      const pending = codes.get(p.get("code") ?? "");
      const verified = pending && createHash("sha256").update(p.get("code_verifier") ?? "").digest("base64url") === pending.challenge && p.get("redirect_uri") === pending.redirect;
      if (!verified) return json(400, { error: "invalid_grant" });
      codes.delete(p.get("code")!);
      const token = `token-${issued.size + 1}`;
      issued.add(token);
      return json(200, { access_token: token, token_type: "Bearer", expires_in: 3600, refresh_token: `refresh-${issued.size}` });
    }
    if (url.pathname === "/mcp") {
      const bearer = req.headers.authorization?.replace(/^Bearer /, "");
      if (!bearer || !issued.has(bearer)) return res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` }).end();
      if (req.method !== "POST") return res.writeHead(405).end();
      seen.mcpWithToken++;
      const reply = answer(JSON.parse(body));
      return reply ? json(200, reply) : res.writeHead(202).end();
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, seen, issued, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("signing in to a remote MCP server (OAuth)", () => {
  test("it waits for a sign-in, the browser's return connects it, and signing out asks again", async () => {
    const fake = await oauthServer();
    const dir = mkdtempSync(join(tmpdir(), "loki-mcp-oauth-"));
    const keychain = new Map<string, string>();
    const mcp = new McpTools({
      registry: createRegistry(),
      configPath: join(dir, "mcp.json"),
      lokiDir: dir,
      redirect: "http://127.0.0.1:41414/mcp/oauth/callback",
      secrets: { get: async (a) => keychain.get(a) || null, set: async (a, v) => void keychain.set(a, v), delete: async (a) => void keychain.delete(a) },
    });
    try {
      mcp.setServer("issues", { url: `${fake.base}/mcp`, headers: {} });
      await until(() => mcp.view().servers[0]?.signIn?.url != null);
      const waiting = mcp.view().servers[0];
      expect(waiting).toMatchObject({ state: "signin", signIn: { signedIn: false } });
      expect(fake.seen.registrations).toBe(1); // loki registered itself, with its callback address
      expect(mcp.sectionText()).toContain("- issues: needs the person to sign in");
      const page = new URL(waiting.signIn!.url!);
      expect(page.origin + page.pathname).toBe(`${fake.base}/authorize`);
      expect(page.searchParams.get("code_challenge_method")).toBe("S256");
      expect(page.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:41414/mcp/oauth/callback");

      // The person signs in; the server sends the browser back with a code, which loki redeems.
      const back = new URL((await fetch(page, { redirect: "manual" })).headers.get("location")!);
      const params = Object.fromEntries(back.searchParams);
      expect(await mcp.finishAuth({ state: "not-ours", code: "x" })).toMatchObject({ ok: false, server: null });
      const done = await mcp.finishAuth(params);
      expect(done).toEqual({ ok: true, server: "issues", message: "Signed in to issues. You can close this tab and go back to loki." });
      await until(() => mcp.view().servers[0]?.state === "connected");
      expect(mcp.view().servers[0]).toMatchObject({ state: "connected", signIn: { url: null, signedIn: true } });
      expect(mcp.view().servers[0].tools).toHaveLength(TOOLS.length);
      expect((await mcp.servers.call("mcp__issues__list_issues", { repo: "loki" })).content).toEqual([{ type: "text", text: 'list_issues {"repo":"loki"}' }]);
      expect(fake.seen.mcpWithToken).toBeGreaterThan(0);
      // The tokens are in the keychain, never in mcp.json; a used state does not work twice.
      expect(JSON.parse(keychain.get("mcp-oauth.issues.tokens")!)).toMatchObject({ access_token: "token-1" });
      expect(await mcp.finishAuth(params)).toMatchObject({ ok: false, server: null });

      // Signing out forgets the tokens and asks for a sign-in again; the registration stays.
      await mcp.signOut("issues");
      expect(keychain.has("mcp-oauth.issues.tokens")).toBe(false);
      await until(() => mcp.view().servers[0]?.state === "signin" && mcp.view().servers[0]?.signIn?.url != null);
      expect(fake.seen.registrations).toBe(1);
    } finally {
      await mcp.close();
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a server with its own Authorization header never signs in; an error from the server's page is said plainly", async () => {
    const fake = await oauthServer();
    const dir = mkdtempSync(join(tmpdir(), "loki-mcp-oauth-"));
    const mcp = new McpTools({ registry: createRegistry(), configPath: join(dir, "mcp.json"), lokiDir: dir, redirect: "http://127.0.0.1:41414/mcp/oauth/callback" });
    try {
      mcp.setServer("token", { url: `${fake.base}/mcp`, headers: { Authorization: "Bearer wrong" } });
      await until(() => mcp.view().servers[0]?.state === "down");
      expect(mcp.view().servers[0]).toMatchObject({ state: "down", signIn: null });
      mcp.setServer("token", null);
      mcp.setServer("issues", { url: `${fake.base}/mcp`, headers: {} });
      await until(() => mcp.view().servers[0]?.signIn?.url != null);
      const state = new URL(mcp.view().servers[0].signIn!.url!).searchParams.get("state")!;
      expect(await mcp.finishAuth({ state, error: "access_denied", error_description: "You said no" })).toEqual({ ok: false, server: "issues", message: "issues did not sign in: You said no" });
    } finally {
      await mcp.close();
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the callback route answers GET with a page (its message escaped), refuses other methods, and leaves other paths alone", async () => {
    const calls: Array<Record<string, string>> = [];
    const srv = await startServer({ port: 0, token: "t", routes: [oauthCallbackRoute("/mcp/oauth/callback", async (p) => (calls.push(p), { ok: p.code === "good", message: `<b>${p.code}</b>` }))] });
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const ok = await fetch(`${base}/mcp/oauth/callback?code=good&state=s`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("cache-control")).toBe("no-store");
      const html = await ok.text();
      expect(html).toContain("Signed in");
      expect(html).toContain("&lt;b&gt;good&lt;/b&gt;");
      expect((await fetch(`${base}/mcp/oauth/callback?code=bad`)).status).toBe(400);
      expect((await fetch(`${base}/mcp/oauth/callback`, { method: "POST" })).status).toBe(405);
      expect((await fetch(`${base}/elsewhere`)).status).toBe(404);
      expect(calls).toEqual([{ code: "good", state: "s" }, { code: "bad" }]);
      expect(oauthPage(false, "x")).toContain("Not signed in");
    } finally {
      await srv.close();
    }
  });
});
