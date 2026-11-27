import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import type { Message } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Approvals } from "../daemon/approvals.ts";
import { BackgroundTasks } from "../daemon/background.ts";
import { memorySecrets } from "../daemon/credentials.ts";
import { builtinExtensions } from "../daemon/extensions.ts";
import { AgentStore } from "../daemon/kernel/index.ts";
import type { ModApi } from "../daemon/mods/api.ts";
import { ModRegistry } from "../daemon/mods/registry.ts";
import { Schedules } from "../daemon/schedule.ts";
import { scriptExtensions, scriptSandbox } from "../daemon/scripts.ts";
import { registerAccountScriptTools } from "../mod/account-ops/script-tools.ts";
import { AccountThreads } from "../mod/account-threads.ts";
import { Accounts } from "../mod/accounts.ts";
import { CanvasStore } from "../mod/canvas-store.ts";
import { GmailClient } from "../mod/gmail.ts";
import { GoogleAuth } from "../mod/google-auth.ts";
import { registerGoogleTools } from "../mod/google-tools/index.ts";
import { registerTools } from "../mod/tools.ts";

const ctx = BACKGROUND_CONTEXT;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const unused = (): never => {
  throw new Error("not called");
};

const tokens = (text: string): number => Math.ceil(text.length / 4);

async function request(owns: "gmail" | "slack" | null): Promise<{ prompt: string; tools: string[]; total: number }> {
  const dir = mkdtempSync(join(tmpdir(), "loki-scripts-prompt-"));
  dirs.push(dir);
  const accounts = new Accounts({ file: join(dir, "accounts.json"), secrets: memorySecrets(), agentExists: () => true });
  if (owns === "gmail")
    await accounts.add({ account_id: "gmail:ada@acme.com", provider: "gmail", address: "ada@acme.com", owner_agent_id: "agent-local-a", services: ["gmail"] });
  if (owns === "slack") await accounts.add({ account_id: "slack:T1:U1", provider: "slack", address: "Acme", owner_agent_id: "agent-local-a" });
  const sandbox = scriptSandbox();
  const mods = new ModRegistry(() => {});
  const builtins = builtinExtensions({
    approvals: new Approvals(),
    backendDir: dir,
    background: new BackgroundTasks(() => {}),
    schedules: new Schedules(join(dir, "crons.json"), () => Promise.resolve(null)),
    history: { thread: () => [], compactedSince: () => false },
    scripts: scriptExtensions(sandbox),
  });
  for (const e of builtins) mods.registry.install(e);
  const auth = (id: string) => new GoogleAuth({ accounts, account_id: id });
  await mods.load({
    name: "loki",
    apiVersion: 1,
    activate: (api: ModApi) => [
      ...registerTools(api, {
        store: new CanvasStore(),
        widgets: { entries: () => [], get: () => undefined, setRuntimeError: () => false, rescan: () => Promise.resolve(), close: () => {} },
        widgetsDir: "/home/loki/.loki/widgets",
        activeScope: () => "c",
        broadcast: () => {},
        chats: { suggestions: { add: unused }, agents: () => [], chats: () => [], passChat: () => false, messages: { send: unused, linksOf: unused } },
      }),
      ...registerGoogleTools(api, { accounts, auth, gmail: (id) => new GmailClient({ accounts, account_id: id, auth: auth(id) }), resultsDir: () => dir }),
      ...registerAccountScriptTools(api, {
        accounts,
        threads: new AccountThreads({ dir: join(dir, "account-threads"), accounts }),
        slack: unused,
        jira: unused,
      }),
    ],
  });
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const store = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry: mods.registry }, ctx);
  try {
    await store.setAgent({ id: "agent-local-a", name: "Ada" }, ctx);
    const chat = await store.createChat("c", { agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id }, cwd: dir } }, ctx);
    await mods.prepare(store, chat, ctx);
    let messages: Message[] = [];
    faux.setResponses([(c: { messages: Message[] }) => ((messages = c.messages), fauxAssistantMessage("hi"))]);
    await (await chat.submit({ type: "input", content: "hello" }, ctx)).wait(ctx);
    const prompt = getCurrentSystemPrompt(messages);
    const tools = getCurrentTools(messages);
    const definitions = tools.map((t) => JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }));
    return { prompt, tools: tools.map((t) => t.name), total: tokens(prompt) + definitions.reduce((sum, d) => sum + tokens(d), 0) };
  } finally {
    await sandbox.close();
    await store.close(ctx);
  }
}

const BEFORE = { none: 3927, gmail: 4533, slack: 4486 } as const;

const AFTER = { none: 3918, gmail: 4123, slack: 4050 } as const;
const SLACK = 50;

const MOVED = ["history_search", "history_read", "schedule_create", "schedule_list", "schedule_delete", "canvas_read", "canvas_focus", "chat_list"];

describe("what an agent's prompt costs a turn (plan 099, R7)", () => {
  test.each([
    ["no account", null, BEFORE.none, AFTER.none],
    ["a Google owner", "gmail", BEFORE.gmail, AFTER.gmail],
    ["a Slack owner", "slack", BEFORE.slack, AFTER.slack],
  ] as const)("%s pays less than before plan 099, and no more than measured with it", async (_who, owns, before, after) => {
    const { total } = await request(owns);
    expect(total, `${total} tokens a turn`).toBeLessThan(before);
    expect(total, `${total} tokens a turn`).toBeLessThanOrEqual(after + SLACK);
  });

  test("an agent with no account has the script tool and loki's four namespaces, and none of the moved tools as its model's", async () => {
    const { prompt, tools } = await request(null);
    expect(tools).toContain("codemode");
    expect(tools.filter((t) => MOVED.includes(t))).toEqual([]);
    for (const namespace of ["## history", "## schedule", "## canvas", "## chat"]) expect(prompt).toContain(namespace);
    expect(prompt).not.toContain("## google");
    expect(prompt).toContain("writing files, never through a tool");
  });

  test("a Google owner sees its own namespaces beside loki's", async () => {
    const { prompt } = await request("gmail");
    expect(prompt).toContain("Gmail, Drive, Sheets, Docs and Calendar of the Google accounts");
    expect(prompt).toContain("Your accounts");
  });
});
