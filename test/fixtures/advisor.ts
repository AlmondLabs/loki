import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, MemoryStorage, type Conversation } from "@earendil-works/pi-durable";
import type { ChatEvent } from "../../core/attention/model.ts";
import { Advisors } from "../../daemon/advisor.ts";
import { Approvals } from "../../daemon/approvals.ts";
import { BackgroundTasks } from "../../daemon/background.ts";
import { ChatProjection } from "../../daemon/chats.ts";
import { builtinExtensions } from "../../daemon/extensions.ts";
import { AgentStore } from "../../daemon/kernel/index.ts";
import { StoreManager } from "../../daemon/kernel/stores.ts";
import { memoryRoot } from "../../daemon/memory.ts";
import { Schedules } from "../../daemon/schedule.ts";
import { writeRecord } from "../../daemon/store/agents.ts";
import { chatEnvs } from "../../daemon/tool-results.ts";

const ctx = BACKGROUND_CONTEXT;

export const AGENT = "agent-local-advised";

export interface ToolResult {
  name: string;
  text: string;
  failed: boolean;
}

interface RecordFields {
  model?: string | null;
  advisor_model?: string;
  advisor_reasoning_effort?: string;
}

export async function advisorSetup(fields: (handle: string) => RecordFields = () => ({})) {
  const root = mkdtempSync(join(tmpdir(), "loki-advisor-"));
  const home = join(root, "home");
  const dataDir = join(home, ".loki");
  const backend = join(dataDir, "backend");
  const folder = join(home, "work");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "a.ts"), "export const answer = 42;\n");
  mkdirSync(join(dataDir, "stores"), { recursive: true });
  writeFileSync(join(dataDir, "stores", `${AGENT}.sqlite`), "the person's whole thread\n");
  const memory = memoryRoot(backend, AGENT);
  mkdirSync(join(memory, "system"), { recursive: true });
  writeFileSync(join(memory, "system", "persona.md"), "I am Ada.\n");
  mkdirSync(join(memory, "skills", "review"), { recursive: true });
  writeFileSync(join(memory, "skills", "review", "SKILL.md"), "---\ndescription: review code\n---\nRead the diff first.\n");

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const handle = `${faux.provider.id}/${faux.getModel().id}`;
  writeRecord(backend, AGENT, { id: AGENT, name: "Ada", model: handle, ...fields(handle), model_settings: {}, tags: [] });

  const approvals = new Approvals({ advisorFolders: { dataDir, backendDir: backend, home } });
  const pushed: ChatEvent[] = [];
  approvals.attach((_a, _c, events) => pushed.push(...events));
  const chats = new ChatProjection(ctx, () => "Ada");
  const registry = createRegistry();
  for (const extension of builtinExtensions({
    approvals,
    backendDir: backend,
    background: new BackgroundTasks(() => {}),
    schedules: new Schedules(join(root, "crons.json"), () => Promise.resolve(null)),
    history: chats,
  }))
    registry.install(extension);
  const options = { models, registry, env: chatEnvs(dataDir) };
  const stores = new StoreManager(
    join(dataDir, "stores"),
    options,
    ctx,
    () => {},
    () => AgentStore.open({ storage: new MemoryStorage() }, options, ctx),
  );
  chats.follow(stores, () => {});
  const store = await stores.get(AGENT);
  await store.setAgent({ id: AGENT, name: "Ada" }, ctx);
  const model = { provider: faux.provider.id, modelId: faux.getModel().id };
  const reachable = new Set([handle]);
  const advisors = new Advisors({
    stores,
    registry,
    backendDir: backend,
    home,
    context: ctx,
    canRun: (h) => Promise.resolve(reachable.has(h)),
  });

  const turn = async (chat: Conversation, calls: Array<[name: string, args: Parameters<typeof fauxToolCall>[1]]>): Promise<ToolResult[]> => {
    faux.setResponses([
      fauxAssistantMessage(
        calls.map(([name, args], i) => fauxToolCall(name, args, { id: `call-${i}` })),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    const seen = (await store.entries(chat, ctx)).length;
    await (await chat.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
    const results = (await store.entries(chat, ctx)).slice(seen).filter((e) => e.kind === "pi.tool-result");
    const byId = new Map(
      results.map((e) => {
        const m = e.model?.[0] as { toolCallId?: string; toolName?: string; content?: Array<{ type: string; text?: string }>; isError?: boolean } | undefined;
        const text = (m?.content ?? []).map((p) => p.text ?? "").join("");
        return [m?.toolCallId ?? "", { name: m?.toolName ?? "", text, failed: m?.isError === true }];
      }),
    );
    return calls.map((_, i) => byId.get(`call-${i}`) ?? { name: "", text: "(no result)", failed: true });
  };

  const cleanup = async () => {
    await stores.closeAll();
    rmSync(root, { recursive: true, force: true });
  };

  return {
    root,
    home,
    dataDir,
    backend,
    folder,
    memory,
    faux,
    handle,
    model,
    reachable,
    approvals,
    pushed,
    chats,
    registry,
    stores,
    store,
    advisors,
    turn,
    cleanup,
  };
}
