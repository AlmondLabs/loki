import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { AgentStore } from "../daemon/kernel/index.ts";
import { ModRegistry } from "../daemon/mods/registry.ts";
import type { ModApi } from "../daemon/mods/api.ts";
import { fileToolsExtension } from "../daemon/tools.ts";
import { subagentExtension } from "../daemon/subagents.ts";
import { chatEnvs } from "../daemon/tool-results.ts";
import { scriptExtensions, scriptSandbox, SCRIPT_TOOL, withTimeLimit } from "../daemon/scripts.ts";

const ctx = BACKGROUND_CONTEXT;
const OWNER = "agent-local-owner";
const OTHER = "agent-local-other";

const open: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close();
});

/** Calls of the test's script-only tool, in order, and a way to hold one open until released. */
interface Echo {
  calls: string[];
  /** Called when the held call is reached, so a test waits on the event rather than on time. */
  reached?: () => void;
  /** The chat folder the last call was told. */
  cwd?: string;
  hold?: { at: number; released: Promise<void> };
}

/**
 * A daemon's tools as main.ts installs them, on a faux model: the coding tools (bash among them), loki's file tools,
 * helpers, scripts, and a mod with one script-only tool for OWNER's chats, `google_echo`, which echoes its text as an
 * object.
 */
async function daemon(opts: { sandbox?: CodemodeSandbox; timeLimitMs?: number; file?: string; echo?: Echo } = {}) {
  const sandbox = opts.sandbox ?? scriptSandbox();
  const scripts = scriptExtensions(sandbox, opts.timeLimitMs);
  const mods = new ModRegistry(() => {});
  for (const e of [CodingTools, fileToolsExtension(), subagentExtension(scripts), ...scripts]) mods.registry.install(e);
  const echo = opts.echo ?? { calls: [] };
  await mods.load({
    name: "echo",
    apiVersion: 1,
    activate: (api: ModApi) =>
      api.tools.register({
        name: "google_echo",
        description: "Echo some text back",
        parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        callers: ["tools"],
        outputSchema: { type: "object", properties: { said: { type: "string" } }, required: ["said"] },
        forAgent: (agentId) => agentId === OWNER,
        execute: async (args, c) => {
          const text = typeof args.text === "string" ? args.text : "";
          echo.calls.push(text);
          if (c.cwd !== undefined) echo.cwd = c.cwd;
          const hold = echo.hold?.at === echo.calls.length ? echo.hold.released : undefined;
          if (hold) echo.reached?.();
          if (hold)
            await Promise.race([hold, new Promise((_, reject) => c.signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true }))]);
          return { said: text };
        },
      }),
  });
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const lokiDir = folder();
  const store = await AgentStore.open(
    opts.file ? { file: opts.file } : { storage: new MemoryStorage() },
    { models, registry: mods.registry, env: chatEnvs(lokiDir) },
    ctx,
  );
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await sandbox.close();
    await store.close(ctx);
  };
  open.push(close);
  return { faux, store, mods, echo, sandbox, close, model: { provider: faux.provider.id, modelId: faux.getModel().id } };
}

type Daemon = Awaited<ReturnType<typeof daemon>>;

/** A chat of `agentId` in `cwd`, its tools set as before a turn on loki's engine; what each request sent is kept. */
async function chatOf(d: Daemon, agentId: string, cwd: string) {
  await d.store.setAgent({ id: agentId, name: agentId }, ctx);
  const chat = await d.store.createChat(`local-conv-${agentId}`, { agent: { model: d.model, cwd } }, ctx);
  await d.mods.prepare(d.store, chat, ctx);
  return chat;
}

const sent: string[] = [];
const reply = (m: ReturnType<typeof fauxAssistantMessage>) => (c: { systemPrompt?: string; messages: unknown[] }) => (sent.push(JSON.stringify(c)), m);
const script = (code: string) => reply(fauxAssistantMessage([fauxToolCall(SCRIPT_TOOL, { code })], { stopReason: "toolUse" }));

/** The text the model read back from each script, in order. */
async function scriptResults(d: Daemon, chat: Awaited<ReturnType<typeof chatOf>>): Promise<string[]> {
  return (await d.store.entries(chat, ctx))
    .filter((e) => e.kind === "pi.tool-result")
    .map((e) => JSON.stringify(e.model))
    .filter((r) => r.includes(`"toolName":"${SCRIPT_TOOL}"`));
}

async function run(d: Daemon, chat: Awaited<ReturnType<typeof chatOf>>, content: string): Promise<void> {
  await (await chat.submit({ type: "input", content }, ctx)).wait(ctx);
}

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "loki-scripts-"));
  open.push(() => Promise.resolve(rmSync(dir, { recursive: true, force: true })));
  return dir;
}

describe("scripts on loki's engine (plan 2026-11-11, U2)", () => {
  test("AE2: an agent with a script-only tool is offered the script tool and a section listing it; one without is offered neither", async () => {
    const d = await daemon();
    const dir = folder();
    const owner = await chatOf(d, OWNER, dir);
    const other = await chatOf(d, OTHER, dir);
    const offered = async (chat: typeof owner) => (await chat.agent(ctx)).tools.map((t) => t.name);
    expect(await offered(owner)).toContain(SCRIPT_TOOL);
    expect(await offered(owner)).not.toContain("google_echo");
    expect(await offered(other)).not.toContain(SCRIPT_TOOL);

    sent.length = 0;
    d.faux.setResponses([reply(fauxAssistantMessage("hi")), reply(fauxAssistantMessage("hi"))]);
    await run(d, owner, "hello");
    await run(d, other, "hello");
    const [ownerRequest, otherRequest] = sent;
    expect(ownerRequest).toContain("<codemode>");
    // The section names the namespace the tool is in; a script finds the tool itself with searchTools().
    expect(ownerRequest).toContain("Gmail, Drive, Sheets, Docs and Calendar");
    expect(otherRequest).not.toContain("<codemode>");
    expect(otherRequest).not.toContain("google_echo");
  });

  test("AE6: a script sees the script-only tools and the file tools, and has no bash, helpers, fetch or require", async () => {
    const d = await daemon();
    const owner = await chatOf(d, OWNER, folder());
    d.faux.setResponses([
      script(
        "let bash = 'callable'; try { await tools.bash({ command: 'echo hi' }) } catch (e) { bash = e.message.split('. ')[0] } return [ALL_TOOLS.map((t) => t.name).sort().join(' '), bash, typeof fetch, typeof require].join('|')",
      ),
      reply(fauxAssistantMessage("done")),
    ]);
    await run(d, owner, "check");
    const [result] = await scriptResults(d, owner);
    expect(result).toContain("edit find google_echo grep ls read write|tools.bash does not exist|undefined|undefined");
  });

  test("a script reads a file in the chat's folder and gets a typed tool's value as an object", async () => {
    const d = await daemon();
    const dir = folder();
    writeFileSync(join(dir, "note.txt"), "tea at four\n");
    const owner = await chatOf(d, OWNER, dir);
    d.faux.setResponses([
      script(
        "const note = await tools.read({ path: 'note.txt' }); const echoed = await tools.google_echo({ text: 'hi' }); return note.trim() + ' / ' + echoed.said",
      ),
      reply(fauxAssistantMessage("done")),
    ]);
    await run(d, owner, "read");
    const [result] = await scriptResults(d, owner);
    expect(result).toContain("tea at four / hi");
    expect(d.echo.calls).toEqual(["hi"]);
    expect(d.echo.cwd).toBe(dir);
  });

  test("R11: a script finds a tool the section does not list, and reads how to call it", async () => {
    const d = await daemon();
    const owner = await chatOf(d, OWNER, folder());
    d.faux.setResponses([script("return JSON.stringify([await searchTools('echo'), await describeTool('google_echo')])"), reply(fauxAssistantMessage("done"))]);
    await run(d, owner, "find");
    const [result] = await scriptResults(d, owner);
    expect(result).toContain("google_echo");
    expect(result).toContain("Echo some text back");
  });

  test("R5: a value one script stores, the next script of the chat loads", async () => {
    const d = await daemon();
    const owner = await chatOf(d, OWNER, folder());
    d.faux.setResponses([script("store('count', 41); return 'kept'"), script("return load('count') + 1"), reply(fauxAssistantMessage("done"))]);
    await run(d, owner, "count");
    const results = await scriptResults(d, owner);
    expect(results[1]).toContain("42");
  });

  test("R6: output past the budget is cut, and the model gets the path of the whole text", async () => {
    const d = await daemon();
    const owner = await chatOf(d, OWNER, folder());
    d.faux.setResponses([script("text('word '.repeat(30000)); return 'printed'"), reply(fauxAssistantMessage("done"))]);
    await run(d, owner, "print");
    const [result] = await scriptResults(d, owner);
    expect(result.length).toBeLessThan(80_000);
    expect(result).toMatch(/full output|complete/i);
  });

  test("R9: the script tool runs alone in a model round", async () => {
    const d = await daemon();
    const owner = await chatOf(d, OWNER, folder());
    const tool = (await owner.agent(ctx)).tools.find((t) => t.name === SCRIPT_TOOL);
    expect(tool?.executionMode).toBe("sequential");
  });

  test("AE7: a script that never ends stops at the time limit, and the agent is told so", async () => {
    const d = await daemon({ timeLimitMs: 300 });
    const owner = await chatOf(d, OWNER, folder());
    d.faux.setResponses([script("while (true) {}"), reply(fauxAssistantMessage("done"))]);
    await run(d, owner, "spin");
    const [result] = await scriptResults(d, owner);
    expect(result).toMatch(/time|timed out|deadline/i);
  });

  test("AE7: a script that builds past the memory cap ends with out of memory", async () => {
    const d = await daemon({ sandbox: scriptSandbox({ memoryLimitBytes: 8 * 1024 * 1024 }) });
    const owner = await chatOf(d, OWNER, folder());
    d.faux.setResponses([script("const a = []; while (true) a.push('x'.repeat(1000) + a.length); return a.length"), reply(fauxAssistantMessage("done"))]);
    await run(d, owner, "grow");
    const [result] = await scriptResults(d, owner);
    expect(result).toMatch(/out of memory/i);
  });

  test("a script past the daemon's cap on scripts at once is refused with the reason", async () => {
    const sandbox = scriptSandbox({ atOnce: 1, timeoutMs: 1000 });
    open.push(() => sandbox.close());
    const spinning = sandbox.execute("while (true) {}");
    const refused = await sandbox.execute("return 1");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toContain("1 scripts are already running");
    expect((await spinning).ok).toBe(false);
  });

  test("R1: a helper has no script tool, and a chat with a fixed tool list (a background pass's) gets no script section", async () => {
    const d = await daemon();
    const dir = folder();
    const owner = await chatOf(d, OWNER, dir);
    sent.length = 0;
    d.faux.setResponses([
      reply(fauxAssistantMessage([fauxToolCall("subagent", { prompt: "say hi" })], { stopReason: "toolUse" })),
      reply(fauxAssistantMessage("hi from the helper")),
      reply(fauxAssistantMessage("done")),
    ]);
    await run(d, owner, "ask a helper");
    const [parent, helper] = sent;
    expect(parent).toContain(`"name":"${SCRIPT_TOOL}"`);
    expect(helper).not.toContain(`"name":"${SCRIPT_TOOL}"`);
    expect(helper).not.toContain("<codemode>");

    const read = d.mods.registry
      .snapshot()
      .tools()
      .filter((t) => t.tool.name === "read")
      .map((t) => t.tool);
    const pass = await d.store.createChat("local-conv-pass", { agent: { model: d.model, cwd: dir, tools: read } }, ctx);
    await d.mods.prepare(d.store, pass, ctx);
    sent.length = 0;
    d.faux.setResponses([reply(fauxAssistantMessage("remembered"))]);
    await run(d, pass, "reflect");
    expect(sent[0]).not.toContain("<codemode>");
  });

  test("R8: a script cut off by a restart resumes without repeating its finished calls; the call in flight fails as interrupted", async () => {
    let release = () => {};
    let reached = () => {};
    const atThird = new Promise<void>((r) => (reached = r));
    const echo: Echo = { calls: [], reached, hold: { at: 3, released: new Promise<void>((r) => (release = r)) } };
    const file = join(folder(), "store.db");
    const first = await daemon({ echo, file });
    const owner = await chatOf(first, OWNER, folder());
    first.faux.setResponses([
      script(
        "const out = []; for (const text of ['a', 'b', 'c', 'd']) { try { out.push((await tools.google_echo({ text })).said) } catch (e) { out.push('failed: ' + e.message) } } return out.join(' ')",
      ),
    ]);
    const turn = await owner.submit({ type: "input", content: "echo four" }, ctx);
    // The third call is in flight: stop the daemon as a restart would, the sandbox before the store.
    await atThird;
    await first.close();
    release();
    void turn.wait(ctx).catch(() => {});

    const resumed = { calls: [] as string[] };
    const second = await daemon({ file, echo: resumed });
    // The model is asked again only once the resumed script's result is in the chat: that request is the event.
    let answered = () => {};
    const asked = new Promise<void>((r) => (answered = r));
    second.faux.setResponses([() => (answered(), fauxAssistantMessage("done"))]);
    const chat = await second.store.chat(`local-conv-${OWNER}`, ctx);
    if (!chat) throw new Error("the chat is gone after the restart");
    // The daemon resumes each store it opens (daemon/kernel/stores.ts); the cut-off turn then runs on.
    second.store.harness.resume();
    await asked;
    const result = (await scriptResults(second, chat)).at(0);
    if (result === undefined) throw new Error("the script did not finish after the restart");
    expect(resumed.calls).toEqual(["d"]);
    expect(result).toContain("a b failed: ");
    expect(result).toMatch(/interrupted/i);
    expect(result).toContain(" d");
  });
});

describe("a script's time limit", () => {
  test("a script without an options line gains one with the limit; its own token budget is kept", () => {
    expect(withTimeLimit("return 1", 600_000)).toBe('// @options: {"timeout_ms":600000}\nreturn 1');
    expect(withTimeLimit('// @options: {"max_output_tokens": 2000}\nreturn 1', 600_000)).toBe(
      '// @options: {"max_output_tokens":2000,"timeout_ms":600000}\nreturn 1',
    );
  });

  test("a shorter limit the agent set stays; a longer one is lowered; a source the parser refuses is left for Code Mode to report", () => {
    const short = '// @options: {"timeout_ms": 1000}\nreturn 1';
    expect(withTimeLimit(short, 600_000)).toBe(short);
    expect(withTimeLimit('// @options: {"timeout_ms": 9000000}\nreturn 1', 600_000)).toBe('// @options: {"timeout_ms":600000}\nreturn 1');
    expect(withTimeLimit("", 600_000)).toBe("");
  });
});
