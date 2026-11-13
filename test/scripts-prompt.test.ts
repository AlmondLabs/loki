import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { memorySecrets } from "../daemon/credentials.ts";
import { AgentStore } from "../daemon/kernel/index.ts";
import type { ModApi } from "../daemon/mods/api.ts";
import { ModRegistry } from "../daemon/mods/registry.ts";
import { scriptExtensions, scriptSandbox } from "../daemon/scripts.ts";
import { fileToolsExtension } from "../daemon/tools.ts";
import { Accounts } from "../mod/accounts.ts";
import { GmailClient } from "../mod/gmail.ts";
import { GoogleAuth } from "../mod/google-auth.ts";
import { registerGoogleTools } from "../mod/google-tools/index.ts";
import { registerAccountScriptTools } from "../mod/account-ops/script-tools.ts";
import { AccountThreads } from "../mod/account-threads.ts";

const ctx = BACKGROUND_CONTEXT;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * What one model request carries for an agent: its system prompt and its tool definitions, as JSON, with the Google
 * tools registered and the agent owning a Google account or not.
 */
async function request(owns: "gmail" | "slack" | null): Promise<{ prompt: string; tools: string }> {
  const dir = mkdtempSync(join(tmpdir(), "loki-scripts-prompt-"));
  dirs.push(dir);
  const accounts = new Accounts({ file: join(dir, "accounts.json"), secrets: memorySecrets(), agentExists: () => true });
  if (owns === "gmail")
    await accounts.add({ account_id: "gmail:ada@acme.com", provider: "gmail", address: "ada@acme.com", owner_agent_id: "agent-local-a", services: ["gmail"] });
  if (owns === "slack") await accounts.add({ account_id: "slack:T1:U1", provider: "slack", address: "Acme", owner_agent_id: "agent-local-a" });
  const sandbox = scriptSandbox();
  const mods = new ModRegistry(() => {});
  // Every chat has the coding tools, so both agents' requests carry a tool list; loki's file tools are scripts' only.
  for (const e of [CodingTools, fileToolsExtension(), ...scriptExtensions(sandbox)]) mods.registry.install(e);
  const auth = (id: string) => new GoogleAuth({ accounts, account_id: id });
  await mods.load({
    name: "google",
    apiVersion: 1,
    activate: (api: ModApi) => [
      ...registerGoogleTools(api, { accounts, auth, gmail: (id) => new GmailClient({ accounts, account_id: id, auth: auth(id) }), resultsDir: () => dir }),
      // The account reads and the "Your accounts" section, as mod/index.ts registers them (plan 097).
      ...registerAccountScriptTools(api, {
        accounts,
        threads: new AccountThreads({ dir: join(dir, "account-threads"), accounts }),
        slack: () => {
          throw new Error("not called");
        },
        jira: () => {
          throw new Error("not called");
        },
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
    let prompt = "";
    faux.setResponses([(c: { messages: unknown[] }) => ((prompt = JSON.stringify(c.messages)), fauxAssistantMessage("hi"))]);
    await (await chat.submit({ type: "input", content: "hello" }, ctx)).wait(ctx);
    // The tool definitions the model is offered, as a provider sends them.
    const tools = JSON.stringify((await chat.agent(ctx)).tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })));
    return { prompt, tools };
  } finally {
    await sandbox.close();
    await store.close(ctx);
  }
}

/** Tokens, estimated as Code Mode estimates them: four characters each. */
const tokens = (text: string): number => Math.ceil(text.length / 4);

describe("what scripts cost an agent's prompt (plan 2026-11-11, U9, Success Criteria; plan 097, R7)", () => {
  // Measured on 2026-11-13 before plan 097: the owner's account_list, account_read and account_search cost about 492
  // tokens a turn, and the "Your accounts" section about 64, on top of what scripts cost a Google owner.
  const ACCOUNT_TOOLS_BEFORE = 492 + 64;

  test("a Google owner pays for the script tool, the google and flow listings and its accounts section, under the 1,100-token target; any other agent pays nothing", async () => {
    const [owner, other] = [await request("gmail"), await request(null)];
    const added = tokens(owner.prompt) - tokens(other.prompt) + (tokens(owner.tools) - tokens(other.tools));
    expect(other.prompt).not.toContain("<codemode>");
    expect(other.tools).not.toContain("codemode");
    // The section names the google namespace; a script finds its tools with searchTools() (SCRIPT_LISTING_TOKENS).
    expect(owner.prompt).toContain("Gmail, Drive, Sheets, Docs and Calendar of the Google accounts");
    expect(owner.prompt).toContain("Your accounts");
    expect(added, `scripts add ${added} tokens a turn`).toBeLessThan(1100);
  });

  test("a Google owner now pays less than scripts and the account tools cost together before (R7)", async () => {
    const [owner, other] = [await request("gmail"), await request(null)];
    const added = tokens(owner.prompt) - tokens(other.prompt) + (tokens(owner.tools) - tokens(other.tools));
    expect(added).toBeLessThan(991 + ACCOUNT_TOOLS_BEFORE - 400);
  });

  test("a Slack or Jira owner without Google pays for the script machinery, about 500 tokens more than the account tools cost (accepted on 2026-11-13)", async () => {
    const [owner, other] = [await request("slack"), await request(null)];
    const added = tokens(owner.prompt) - tokens(other.prompt) + (tokens(owner.tools) - tokens(other.tools));
    expect(owner.tools).toContain("codemode");
    expect(owner.prompt).toContain("slack_read");
    // Measured 1,050 on 2026-11-13; the person chose this over giving such agents direct tools again (plan 097, R7).
    expect(added, `scripts add ${added} tokens a turn`).toBeLessThan(1100);
  });
});
