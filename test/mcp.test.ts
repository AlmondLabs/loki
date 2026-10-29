import { describe, expect, test } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport, type Transport } from "@modelcontextprotocol/client";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { editServer, parseConfig, readConfig, serverKey, setAlwaysLoad, withSecrets } from "../daemon/mcp/config.ts";
import { backoffMs, McpServers, toolKey, type Connector, type McpTool } from "../daemon/mcp/servers.ts";
import { rank, selected, words } from "../daemon/mcp/search.ts";
import { ERROR_KEEP, mapResult, START_CHARS } from "../daemon/mcp/results.ts";
import { McpTools } from "../daemon/mcp/index.ts";
import { AgentStore } from "../daemon/kernel/index.ts";
import { kindOf } from "../daemon/approvals.ts";
import { serve, TOOLS } from "./fixtures/fake-mcp.mjs";
import { must } from "./fixtures/must.ts";

const ctx = BACKGROUND_CONTEXT;
const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
};

/** Servers that connect in memory to the fake; `drop(name)` closes a server's end, as a crash would. */
function inMemory(opts: { tools?: unknown[] } = {}) {
  const ends = new Map<string, Transport>();
  const connect: Connector = async (config, client) => {
    const [mine, theirs] = InMemoryTransport.createLinkedPair();
    ends.set(config.name, await serve(theirs, { tools: opts.tools }));
    await client.connect(mine);
  };
  return { connect, drop: (name: string) => ends.get(name)?.close() };
}

describe("MCP config", () => {
  test("local and remote servers in the mcpServers shape; broken entries are named, not fatal", () => {
    const c = parseConfig(
      JSON.stringify({
        mcpServers: {
          github: { command: "github-mcp-server", args: ["stdio"], env: { GITHUB_TOKEN: "t" }, alwaysLoad: ["list_issues"] },
          "my linear": { url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer x" } },
          off: { command: "x", disabled: true },
          nothing: {},
          ftp: { url: "ftp://nope" },
        },
      }),
    );
    expect(c.servers).toEqual([
      {
        kind: "local",
        name: "github",
        entry: "github",
        command: "github-mcp-server",
        args: ["stdio"],
        env: { GITHUB_TOKEN: "t" },
        cwd: null,
        alwaysLoad: ["list_issues"],
      },
      { kind: "remote", name: "my_linear", entry: "my linear", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer x" }, alwaysLoad: [] },
    ]);
    expect(c.problems).toEqual(['nothing: needs a "command" (a local server) or a "url" (a remote one)', 'ftp: "ftp://nope" is not an http(s) URL']);
    expect(parseConfig("{not json").problems[0]).toMatch(/not valid JSON/);
    expect(readConfig(join(tmpdir(), "no-such-loki-mcp.json"))).toEqual({ servers: [], problems: [] });
    expect(serverKey("a b/c")).toBe("a_b_c");
  });
});

describe("MCP tool names, search and results", () => {
  const tool = (server: string, name: string, description: string, props: string[] = []): McpTool => ({
    key: toolKey(server, name),
    server,
    name,
    title: null,
    description,
    inputSchema: { type: "object", properties: Object.fromEntries(props.map((p) => [p, { type: "string" }])) },
    readOnly: false,
    destructive: false,
  });
  const tools = [
    tool("github", "list_pull_requests", "List pull requests of a repository", ["owner", "repo", "state"]),
    tool("github", "create_issue", "Open an issue", ["owner", "repo", "title"]),
    tool("linear", "update_issue", "Change a Linear issue: its state, assignee or title", ["id", "state"]),
    tool("linear", "list_issues", "List Linear issues"),
  ];

  test("a tool's key is mcp__server__tool, safe for every provider, and at most 64 characters", () => {
    expect(toolKey("github", "list_issues")).toBe("mcp__github__list_issues");
    const long = toolKey("server", "a".repeat(80));
    expect(long.length).toBe(64);
    expect(long).toMatch(/^mcp__server__a+_[0-9a-f]{6}$/);
    expect(toolKey("s", "get.thing")).toMatch(/^mcp__s__get_thing_[0-9a-f]{6}$/); // changed names keep a hash, never clash
    expect(toolKey("s", "get.thing")).not.toBe(toolKey("s", "get_thing"));
  });

  test("words split on case and separators; ranking finds by name, description, server and parameters", () => {
    expect(words("listPullRequests open_PRs")).toEqual(["list", "pull", "requests", "open", "prs"]);
    expect(rank("open pull requests on github", tools).map((t) => t.name)[0]).toBe("list_pull_requests");
    expect(rank("change the state of a linear ticket", tools).map((t) => t.name)[0]).toBe("update_issue");
    expect(rank("zebra", tools)).toEqual([]);
    expect(rank("issue", tools, 2)).toHaveLength(2);
  });

  test("select: picks exactly, by server.tool, bare name or key", () => {
    expect(selected("select:linear.update_issue, github.create_issue", tools)?.map((t) => t.key)).toEqual([
      "mcp__linear__update_issue",
      "mcp__github__create_issue",
    ]);
    expect(selected("select:list_issues", tools)?.map((t) => t.key)).toEqual(["mcp__linear__list_issues"]);
    expect(selected("select:mcp__github__create_issue", tools)?.map((t) => t.name)).toEqual(["create_issue"]);
    expect(selected("list issues", tools)).toBeNull();
  });

  test("text, images and resources map across; a big result spills to a file, an error is cut at both ends", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-mcp-results-"));
    try {
      const small = mapResult(
        {
          content: [
            { type: "text", text: "hi" },
            { type: "image", data: "AAAA", mimeType: "image/png" },
            { type: "resource_link", uri: "file:///a", name: "a" },
          ],
        } as never,
        { spillDir: dir, name: "x" },
      );
      expect(small.content).toEqual([
        { type: "text", text: "hi" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "text", text: "[resource] a file:///a" },
      ]);
      expect(mapResult({ content: [], structuredContent: { n: 1 } }, { spillDir: dir, name: "x" }).content[0]).toEqual({
        type: "text",
        text: '{\n  "n": 1\n}',
      });
      const text = "0123456789".repeat(6000);
      const big = mapResult({ content: [{ type: "text", text }] } as never, { spillDir: dir, name: "mcp__github__search" });
      expect(big.spilled).not.toBeNull();
      const spilled = must(big.spilled, "a spill file");
      expect(readFileSync(spilled, "utf8")).toBe(text);
      const note = (big.content[0] as { text: string }).text;
      expect(note).toContain("60,000 characters");
      expect(note).toContain(spilled);
      expect(note.endsWith(text.slice(0, START_CHARS))).toBe(true);
      const err = mapResult(
        { isError: true, content: [{ type: "text", text: `${"a".repeat(ERROR_KEEP)}${"m".repeat(20000)}${"z".repeat(ERROR_KEEP)}` }] } as never,
        { spillDir: dir, name: "x" },
      );
      const errText = (err.content[0] as { text: string }).text;
      expect(err.isError).toBe(true);
      expect(errText.startsWith("a".repeat(ERROR_KEEP))).toBe(true);
      expect(errText.endsWith("z".repeat(ERROR_KEEP))).toBe(true);
      expect(errText).toContain("20000 characters cut");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("MCP servers", () => {
  test("a server connects, lists its tools with their hints, is called, and comes back after it drops", async () => {
    const mem = inMemory();
    const servers = new McpServers({ connect: mem.connect });
    try {
      servers.configure([{ kind: "local", name: "fake", entry: "fake", command: "x", args: [], env: {}, cwd: null, alwaysLoad: ["list_issues"] }]);
      await until(() => servers.status()[0]?.state === "connected");
      expect(servers.status()[0]).toMatchObject({ name: "fake", state: "connected", tools: TOOLS.length, purpose: "A fake issue tracker for tests" });
      const list = must(
        servers.tools().find((t) => t.name === "list_issues"),
        "the list_issues tool",
      );
      expect(list).toMatchObject({ key: "mcp__fake__list_issues", readOnly: true, destructive: false });
      expect(servers.tools().find((t) => t.name === "delete_repo")).toMatchObject({ readOnly: false, destructive: true });
      expect([...servers.alwaysLoaded()]).toEqual(["mcp__fake__list_issues"]);
      const r = await servers.call("mcp__fake__list_issues", { repo: "loki" });
      expect(r.content).toEqual([{ type: "text", text: 'list_issues {"repo":"loki"}' }]);
      await mem.drop("fake");
      await until(() => servers.status()[0]?.state === "down");
      expect(servers.status()[0].error).toMatch(/stopped/);
      expect(servers.tools()).toEqual([]);
      await expect(servers.call("mcp__fake__list_issues", {})).rejects.toThrow(/not available/);
      await until(() => servers.status()[0]?.state === "connected", 4000); // the first retry waits a second
      expect(servers.tools()).toHaveLength(TOOLS.length);
    } finally {
      await servers.close();
    }
  });

  test("two restarts close together connect once: the start that lost is not left running beside the other", async () => {
    const mem = inMemory();
    const connects: Array<Promise<void>> = [];
    const servers = new McpServers({ connect: (c, client, err) => (connects.push(mem.connect(c, client, err)), connects[connects.length - 1]) });
    try {
      servers.configure([{ kind: "local", name: "fake", entry: "fake", command: "x", args: [], env: {}, cwd: null, alwaysLoad: [] }]);
      await until(() => servers.status()[0]?.state === "connected");
      servers.restart("fake");
      servers.restart("fake");
      // Each start goes through "starting" before it connects; the one that won ends "connected".
      await until(() => connects.length >= 2 && servers.status()[0]?.state === "connected");
      await Promise.all(connects);
      expect(connects).toHaveLength(2);
    } finally {
      await servers.close();
    }
  });

  test("the pause before a retry grows to a minute", () => {
    expect([1, 2, 3, 4, 10].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 60_000]);
  });

  test("a real local server over stdio: started, listed, called; one that cannot start is down with its reason", async () => {
    const script = join(import.meta.dirname, "fixtures", "fake-mcp.mjs");
    const servers = new McpServers();
    try {
      servers.configure([
        { kind: "local", name: "fake", entry: "fake", command: process.execPath, args: [script], env: {}, cwd: null, alwaysLoad: [] },
        { kind: "local", name: "missing", entry: "missing", command: join(tmpdir(), "no-such-mcp-server"), args: [], env: {}, cwd: null, alwaysLoad: [] },
      ]);
      await until(() => servers.status().every((s) => s.state !== "starting"), 10_000);
      const [fake, missing] = servers.status();
      expect(fake).toMatchObject({ state: "connected", tools: TOOLS.length });
      expect(missing.state).toBe("down");
      expect(missing.error).toBeTruthy();
      expect((await servers.call("mcp__fake__create_issue", { repo: "loki", title: "t" })).content).toEqual([
        { type: "text", text: 'create_issue {"repo":"loki","title":"t"}' },
      ]);
      // A crash mid-call: the server is down, the call fails, and the stderr it printed is in the reason.
      await expect(servers.call("mcp__fake__crash", {})).rejects.toThrow();
      await until(() => servers.status()[0].state === "down", 5000);
      expect(servers.status()[0].error).toMatch(/fake mcp server ready/);
    } finally {
      await servers.close();
    }
  });
});

describe("loki.mcp in a chat", () => {
  async function setup(opts: { alwaysLoad?: string[] } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "loki-mcp-chat-"));
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { fake: { command: "x", alwaysLoad: opts.alwaysLoad ?? [] } } }));
    const mem = inMemory();
    const registry = createRegistry();
    const mcp = new McpTools({ registry, configPath: join(dir, "mcp.json"), lokiDir: dir, servers: new McpServers({ connect: mem.connect }) });
    const captured: Array<[string, Record<string, unknown>]> = [];
    mcp.setCapture((e, p) => captured.push([e, p]));
    mcp.reload();
    await until(() => mcp.servers.status()[0]?.state === "connected");
    await until(() =>
      registry
        .snapshot()
        .tools()
        .some(({ tool }) => tool.name === "mcp__fake__list_issues"),
    );
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const store = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry }, ctx);
    const chat = await store.createChat("c", { agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } } }, ctx);
    const asked: string[] = [];
    // The tools a request offers travel in the transcript's system messages (pi-ai's transcript context).
    const reply = (m: ReturnType<typeof fauxAssistantMessage>) => (c: { messages: unknown[] }) => (
      asked.push(
        getCurrentTools(c.messages as never)
          .map((t) => t.name)
          .join(","),
      ),
      m
    );
    const results = async () => (await store.entries(chat, ctx)).filter((e) => e.kind === "pi.tool-result").map((e) => JSON.stringify(e.model?.[0]));
    const cleanup = async () => {
      await mcp.close();
      await store.close(ctx);
      rmSync(dir, { recursive: true, force: true });
    };
    return { dir, mcp, store, chat, faux, reply, asked, results, captured, cleanup };
  }

  test("the section names every server and tool; no MCP tool is offered until mcp_search loads it, then it is a real tool", async () => {
    const s = await setup();
    try {
      expect(s.mcp.sectionText()).toContain(
        "- fake: A fake issue tracker for tests (6 tools): list_issues, create_issue, delete_repo, dump_logs, always_fails, crash",
      );
      await s.mcp.prepare(s.store, s.chat, ctx);
      s.faux.setResponses([
        s.reply(fauxAssistantMessage(fauxToolCall("mcp_search", { query: "list open issues of a repository" }), { stopReason: "toolUse" })),
        s.reply(fauxAssistantMessage(fauxToolCall("mcp__fake__list_issues", { repo: "loki" }), { stopReason: "toolUse" })),
        s.reply(fauxAssistantMessage("two open issues")),
      ]);
      await (await s.chat.submit({ type: "input", content: "what's open on loki?" }, ctx)).wait(ctx);
      // The first request offered the search and no fake tool; the next one offered what it found.
      expect(s.asked[0]).toContain("mcp_search");
      expect(s.asked[0]).not.toContain("mcp__fake__");
      expect(s.asked[1]).toContain("mcp__fake__list_issues");
      expect(s.asked[1]).not.toContain("mcp__fake__delete_repo");
      const r = await s.results();
      expect(r[0]).toContain("Loaded");
      expect(r[1]).toContain('list_issues {\\"repo\\":\\"loki\\"}');
      expect(s.captured.map(([e]) => e)).toEqual(["mcp_search", "mcp_call"]);
      expect(s.captured[1][1]).toMatchObject({ server: "fake", tool: "list_issues", error: false, spilled: false });
      // Loaded tools stay for the chat: the next turn offers it from the start, and the filter keeps it after a prepare.
      await s.mcp.prepare(s.store, s.chat, ctx);
      s.faux.setResponses([s.reply(fauxAssistantMessage("still here"))]);
      await (await s.chat.submit({ type: "input", content: "again" }, ctx)).wait(ctx);
      expect(s.asked[3]).toContain("mcp__fake__list_issues");
      // /clear (and a compaction) unload them.
      await s.mcp.forget(s.chat, ctx);
      await s.mcp.prepare(s.store, s.chat, ctx);
      s.faux.setResponses([s.reply(fauxAssistantMessage("gone"))]);
      await (await s.chat.submit({ type: "input", content: "and now" }, ctx)).wait(ctx);
      expect(s.asked[4]).not.toContain("mcp__fake__");
    } finally {
      await s.cleanup();
    }
  });

  test("a hidden tool called by name without searching is refused, and the server is never asked", async () => {
    const s = await setup();
    try {
      await s.mcp.prepare(s.store, s.chat, ctx);
      s.faux.setResponses([
        s.reply(fauxAssistantMessage(fauxToolCall("mcp__fake__create_issue", { repo: "loki", title: "sneaky" }), { stopReason: "toolUse" })),
        s.reply(fauxAssistantMessage("could not")),
      ]);
      await (await s.chat.submit({ type: "input", content: "open an issue" }, ctx)).wait(ctx);
      const [r] = await s.results();
      expect(r).not.toContain("create_issue {");
      expect(JSON.parse(r)).toMatchObject({ isError: true });
      expect(s.captured.filter(([e]) => e === "mcp_call")).toEqual([]);
    } finally {
      await s.cleanup();
    }
  });

  test("a server's alwaysLoad tools are offered from the start; a tool that appears later starts hidden", async () => {
    const s = await setup({ alwaysLoad: ["list_issues"] });
    try {
      await s.mcp.prepare(s.store, s.chat, ctx);
      s.faux.setResponses([s.reply(fauxAssistantMessage("ok"))]);
      await (await s.chat.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);
      expect(s.asked[0]).toContain("mcp__fake__list_issues");
      expect(s.asked[0]).not.toContain("mcp__fake__create_issue");
      // Known tools stay known: a prepare with nothing new writes nothing.
      const before = await s.store.chatInfo(s.chat.id, ctx);
      expect(before?.mcpKnown).toHaveLength(6);
    } finally {
      await s.cleanup();
    }
  });

  test("a big result spills to the chat's folder; a failing tool says why; permissions follow the tools' hints", async () => {
    const s = await setup({ alwaysLoad: ["dump_logs", "always_fails"] });
    try {
      await s.mcp.prepare(s.store, s.chat, ctx);
      s.faux.setResponses([
        s.reply(fauxAssistantMessage(fauxToolCall("mcp__fake__dump_logs", {}), { stopReason: "toolUse" })),
        s.reply(fauxAssistantMessage(fauxToolCall("mcp__fake__always_fails", {}), { stopReason: "toolUse" })),
        s.reply(fauxAssistantMessage("done")),
      ]);
      await (await s.chat.submit({ type: "input", content: "logs?" }, ctx)).wait(ctx);
      const [dump, fail] = await s.results();
      expect(dump).toContain("too large for the conversation");
      // The saved file is the one file in the chat's folder, and the result names it (in JSON, a Windows path's
      // backslashes are doubled, so it is looked for by its name).
      const folder = join(s.dir, "tool-results", "c");
      const files = readdirSync(folder);
      expect(files).toHaveLength(1);
      expect(readFileSync(join(folder, files[0]), "utf8")).toBe("log line\n".repeat(8000));
      expect(dump).toContain(files[0]);
      expect(fail).toContain("the tracker is read-only today");
      expect(kindOf("mcp__fake__list_issues", s.mcp.annotations("mcp__fake__list_issues"))).toBe("read");
      expect(kindOf("mcp__fake__create_issue", s.mcp.annotations("mcp__fake__create_issue"))).toBe("command");
      expect(kindOf("mcp__fake__delete_repo", s.mcp.annotations("mcp__fake__delete_repo"))).toBe("command");
      expect(kindOf("mcp_search", s.mcp.annotations("mcp_search"))).toBe("read");
    } finally {
      await s.cleanup();
    }
  });
});

describe("MCP settings: the file, secrets, and per-agent switches", () => {
  test("an edit keeps what loki does not know; renames, removes, and refuses a file that is not JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-mcp-edit-"));
    const path = join(dir, "mcp.json");
    const read = () => JSON.parse(readFileSync(path, "utf8")) as { mcpServers: Record<string, { alwaysLoad?: unknown }> };
    try {
      writeFileSync(path, JSON.stringify({ note: "mine", mcpServers: { gh: { command: "old", timeout: 30, alwaysLoad: ["a"] } } }));
      editServer(path, "gh", { command: "github-mcp-server", args: ["stdio"], env: { T: "x" }, cwd: null });
      let raw = read();
      expect(raw).toEqual({
        note: "mine",
        mcpServers: { gh: { timeout: 30, alwaysLoad: ["a"], command: "github-mcp-server", args: ["stdio"], env: { T: "x" } } },
      });
      editServer(path, "gh", { url: "https://x.example/mcp", headers: {} }, { rename: "github" });
      raw = read();
      expect(raw.mcpServers).toEqual({ github: { timeout: 30, alwaysLoad: ["a"], url: "https://x.example/mcp" } });
      setAlwaysLoad(path, "github", ["b", "b"]);
      expect(read().mcpServers.github.alwaysLoad).toEqual(["b"]);
      editServer(path, "linear", { url: "https://l.example/mcp", headers: { A: "1" } });
      expect(() => editServer(path, "linear", { url: "https://l.example/mcp", headers: {} }, { rename: "github" })).toThrow(/already a server named github/);
      editServer(path, "github", null);
      expect(Object.keys(read().mcpServers)).toEqual(["linear"]);
      expect(() => editServer(path, "x", { url: "ftp://nope", headers: {} })).toThrow(/not an http/);
      if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
      writeFileSync(path, "{broken");
      expect(() => editServer(path, "x", null)).toThrow();
      expect(readFileSync(path, "utf8")).toBe("{broken"); // left for you to fix, not overwritten
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("${keychain:…} values are filled in when a server connects; a missing secret says which", async () => {
    const config = {
      kind: "local" as const,
      name: "gh",
      entry: "gh",
      command: "x",
      args: [],
      env: { TOKEN: "Bearer ${keychain:gh.TOKEN}", PLAIN: "p" },
      cwd: null,
      alwaysLoad: [],
    };
    const filled = await withSecrets(config, (n) => Promise.resolve(n === "gh.TOKEN" ? "s3cret" : null));
    expect(filled).toMatchObject({ env: { TOKEN: "Bearer s3cret", PLAIN: "p" } });
    await expect(withSecrets(config, () => Promise.resolve(null))).rejects.toThrow(/no secret named gh.TOKEN/);
    const seen: Array<Record<string, string>> = [];
    const mem = inMemory();
    const servers = new McpServers({
      connect: (c, client, err) => (seen.push(c.kind === "local" ? c.env : c.headers), mem.connect(c, client, err)),
      resolve: (c) => withSecrets(c, () => Promise.resolve("s3cret")),
    });
    try {
      servers.configure([config]);
      await until(() => servers.status()[0]?.state === "connected");
      expect(seen[0].TOKEN).toBe("Bearer s3cret");
      expect(servers.configs()[0]).toMatchObject({ env: { TOKEN: "Bearer ${keychain:gh.TOKEN}" } }); // the file's form is what is kept
    } finally {
      await servers.close();
    }
  });

  test("Settings sees each server with its tools and costs; edits, always-load and secrets go through; a switched-off server is gone for that agent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-mcp-view-"));
    const secrets = new Map<string, string>();
    const registry = createRegistry();
    const mem = inMemory();
    const mcp = new McpTools({
      registry,
      configPath: join(dir, "mcp.json"),
      lokiDir: dir,
      servers: new McpServers({ connect: mem.connect }),
      secrets: {
        get: (a) => Promise.resolve(secrets.get(a) ?? null),
        set: (a, v) => {
          secrets.set(a, v);
          return Promise.resolve();
        },
      },
    });
    try {
      mcp.setServer("fake", { command: "x", args: [], env: {}, cwd: null });
      await until(() => mcp.view().servers[0]?.state === "connected");
      const v = mcp.view();
      expect(v.servers[0]).toMatchObject({ name: "fake", entry: "fake", kind: "local", purpose: "A fake issue tracker for tests", off_for: [] });
      expect(v.servers[0].tools).toHaveLength(6);
      expect(v.servers[0].tools[0]).toMatchObject({ name: "list_issues", read_only: true, always_load: false });
      expect(v.servers[0].tokens).toBe(v.servers[0].tools.reduce((n, t) => n + t.tokens, 0));
      expect(v.servers[0].tools[0].tokens).toBeGreaterThan(10);
      mcp.setAlwaysLoad("fake", ["list_issues"]);
      await until(() => mcp.view().servers[0]?.tools[0]?.always_load);
      expect(await mcp.storeSecret("fake.TOKEN", "s3cret")).toBe("${keychain:fake.TOKEN}");
      expect(secrets.get("mcp.fake.TOKEN")).toBe("s3cret");
      // Switched off for one agent: out of that agent's section, while another agent still sees it.
      mcp.setAgentServer("agent-local-a", "fake", false);
      expect(mcp.view().servers[0].off_for).toEqual(["agent-local-a"]);
      expect(mcp.sectionText("agent-local-a")).toBeUndefined();
      expect(mcp.sectionText("agent-local-b")).toContain("- fake");
      expect(JSON.parse(readFileSync(join(dir, "state", "mcp-agents.json"), "utf8"))).toEqual({ off: { "agent-local-a": ["fake"] } });
      // …and out of that agent's chats: hidden by the filter, always-load tools too.
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      const store = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry }, ctx);
      await store.setAgent({ id: "agent-local-a", name: "Ada" }, ctx);
      const chat = await store.createChat("c", { agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } } }, ctx);
      await mcp.prepare(store, chat, ctx);
      const hidden = ((await store.agentSettings(chat.id, ctx)) as { tools: { remove: string[] } }).tools.remove;
      expect(hidden).toContain("mcp__fake__list_issues");
      mcp.setAgentServer("agent-local-a", "fake", true);
      await mcp.prepare(store, chat, ctx);
      const after = ((await store.agentSettings(chat.id, ctx)) as { tools: { remove: string[] } }).tools.remove;
      expect(after).not.toContain("mcp__fake__list_issues"); // always loaded again
      expect(after).toContain("mcp__fake__create_issue");
      await store.close(ctx);
      mcp.setServer("fake", null);
      expect(mcp.view().servers).toEqual([]);
    } finally {
      await mcp.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the servers an agent has on, for its chats on an ACP agent (plan 044)", () => {
  test("each passed as itself with its secrets filled in; one switched off, in its own folder or not found is left out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-mcp-acp-"));
    const reported: string[] = [];
    writeFileSync(
      join(dir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          tracker: { command: process.execPath, args: ["server.js"], env: { TOKEN: "${keychain:tracker.TOKEN}" } },
          notion: { url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer ${keychain:notion.TOKEN}" } },
          signin: { url: "https://signin.example.com/mcp" },
          folder: { command: process.execPath, cwd: dir },
          missing: { command: "no-such-command-anywhere" },
          quiet: { command: process.execPath },
        },
      }),
    );
    const secrets = new Map([
      ["mcp.tracker.TOKEN", "t0ken"],
      ["mcp.notion.TOKEN", "n0tion"],
    ]);
    const mcp = new McpTools({
      registry: createRegistry(),
      configPath: join(dir, "mcp.json"),
      lokiDir: dir,
      report: (m) => reported.push(m),
      servers: new McpServers({ connect: inMemory().connect }),
      secrets: { get: (a) => Promise.resolve(secrets.get(a) ?? null), set: () => Promise.resolve() },
    });
    try {
      mcp.start();
      await until(() => mcp.servers.tools().some((t) => t.server === "tracker"));
      mcp.setAgentServer("agent-local-a", "quiet", false);
      const servers = await mcp.acpServers("agent-local-a");
      expect(servers).toEqual([
        { name: "tracker", command: process.execPath, args: ["server.js"], env: [{ name: "TOKEN", value: "t0ken" }] },
        { type: "http", name: "notion", url: "https://mcp.example.com/mcp", headers: [{ name: "Authorization", value: "Bearer n0tion" }] },
        // No header of its own: the agent signs in to it itself.
        { type: "http", name: "signin", url: "https://signin.example.com/mcp", headers: [] },
      ]);
      expect(reported.filter((m) => m.includes("left out of ACP chats"))).toEqual([
        "MCP server folder left out of ACP chats: it runs in its own folder, which an ACP agent cannot be told",
        "MCP server missing left out of ACP chats: no-such-command-anywhere is not on the PATH",
      ]);
      // Its read-only tools run without asking, under the names the agent gives them; a switched-off server's do not.
      expect(mcp.acpReadOnly("agent-local-a")).toContain("mcp__tracker__list_issues");
      expect(mcp.acpReadOnly("agent-local-a").some((t) => t.startsWith("mcp__quiet__"))).toBe(false);
    } finally {
      await mcp.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
