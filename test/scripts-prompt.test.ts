import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
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

const ctx = BACKGROUND_CONTEXT;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * What one model request carries for an agent: its system prompt and its tool definitions, as JSON, with the Google
 * tools registered and the agent owning a Google account or not.
 */
async function request(owns: boolean): Promise<{ prompt: string; tools: string }> {
  const dir = mkdtempSync(join(tmpdir(), "loki-scripts-prompt-"));
  dirs.push(dir);
  const accounts = new Accounts({ file: join(dir, "accounts.json"), secrets: memorySecrets(), agentExists: () => true });
  if (owns)
    await accounts.add({ account_id: "gmail:ada@acme.com", provider: "gmail", address: "ada@acme.com", owner_agent_id: "agent-local-a", services: ["gmail"] });
  const sandbox = scriptSandbox();
  const mods = new ModRegistry(() => {});
  for (const e of [fileToolsExtension(), ...scriptExtensions(sandbox)]) mods.registry.install(e);
  const auth = (id: string) => new GoogleAuth({ accounts, account_id: id });
  await mods.load({
    name: "google",
    apiVersion: 1,
    activate: (api: ModApi) =>
      registerGoogleTools(api, { accounts, auth, gmail: (id) => new GmailClient({ accounts, account_id: id, auth: auth(id) }), resultsDir: () => dir }),
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

describe("what scripts cost an agent's prompt (plan 2026-11-11, U9, Success Criteria)", () => {
  test("an owning agent pays for the script tool and the google listing, under the 1,000-token target; any other agent pays nothing", async () => {
    const [owner, other] = [await request(true), await request(false)];
    const added = tokens(owner.prompt) - tokens(other.prompt) + (tokens(owner.tools) - tokens(other.tools));
    expect(other.prompt).not.toContain("<codemode>");
    expect(other.tools).not.toContain("codemode");
    // The section names the google namespace; a script finds its tools with searchTools() (SCRIPT_LISTING_TOKENS).
    expect(owner.prompt).toContain("Gmail, Drive, Sheets, Docs and Calendar of the Google accounts");
    expect(added, `scripts add ${added} tokens a turn`).toBeLessThan(1000);
  });
});
