import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import type { AdvisorConsult } from "../../core/advisor.ts";
import { contentText } from "../../core/harness.ts";
import { Advisors } from "../../daemon/advisor.ts";
import { AdvisorConsults, type Advice } from "../../daemon/advisor-consults.ts";
import { Approvals } from "../../daemon/approvals.ts";
import { BackgroundTasks } from "../../daemon/background.ts";
import { DaemonChats } from "../../daemon/chat-backend.ts";
import { ChatProjection } from "../../daemon/chats.ts";
import { KeychainCredentials, memorySecrets } from "../../daemon/credentials.ts";
import { builtinExtensions } from "../../daemon/extensions.ts";
import { AgentStore } from "../../daemon/kernel/index.ts";
import { StoreManager } from "../../daemon/kernel/stores.ts";
import { ModRegistry } from "../../daemon/mods/registry.ts";
import { Providers } from "../../daemon/providers.ts";
import { Schedules } from "../../daemon/schedule.ts";
import { writeRecord } from "../../daemon/store/agents.ts";
import { chatEnvs } from "../../daemon/tool-results.ts";
import { must } from "./must.ts";

const ctx = BACKGROUND_CONTEXT;

export const AGENT = "agent-local-consulting";

type Reply = (text: string) => ReturnType<FauxResponseFactory>;

export const until = async (check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
};

export function gate(): { wait: Promise<void>; open: () => void } {
  let open = () => {};
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

function lastUserText(messages: ReadonlyArray<{ role: string; content: unknown }>): string {
  const last = [...messages].reverse().find((m) => m.role === "user");
  return last ? contentText(last.content) : "";
}

function surviving(storage: Storage): Storage {
  return new Proxy(storage, {
    get: (target, prop, receiver) => {
      if (prop === "close") return () => Promise.resolve();
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

interface DaemonOptions {
  deliver?: (advice: Advice, real: () => Promise<void>) => Promise<void>;
  restartLimit?: number;
  apart?: boolean;
  changes?: ConstructorParameters<typeof DaemonChats>[0]["changes"];
}

export async function consultSetup(firstOptions: DaemonOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "loki-consult-"));
  const home = join(root, "home");
  const dataDir = join(home, ".loki");
  const backend = join(dataDir, "backend");
  const folder = join(home, "work");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "a.ts"), "export const answer = 42;\n");

  const faux = fauxProvider({ models: [{ id: "main" }, { id: "advice" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const main = `${faux.provider.id}/main`;
  const advice = `${faux.provider.id}/advice`;
  writeRecord(backend, AGENT, { id: AGENT, name: "Ada", model: main, advisor_model: advice, model_settings: {}, tags: [] });
  mkdirSync(join(backend, "memfs", AGENT), { recursive: true });

  const seen = { chat: [] as string[], chatContexts: [] as string[], advisor: [] as string[], advisorContexts: [] as string[] };
  const replies: { chat: Reply; advisor: Reply } = {
    chat: () => fauxAssistantMessage("Taken up."),
    advisor: (text) => fauxAssistantMessage(`Advice on: ${text.slice(0, 60)}`),
  };
  const router: FauxResponseFactory = (context, _options, _state, model) => {
    const text = lastUserText(context.messages);
    if (model.id === "advice") {
      seen.advisor.push(text);
      seen.advisorContexts.push(JSON.stringify(context));
      return replies.advisor(text);
    }
    seen.chat.push(text);
    seen.chatContexts.push(JSON.stringify(context.messages));
    return replies.chat(text);
  };
  faux.setResponses(Array.from({ length: 500 }, () => router));

  const storage = surviving(new MemoryStorage());
  const clock = { now: Date.parse("2026-11-22T10:00:00Z") };
  let ids = 0;

  const daemon = async ({ deliver, restartLimit, apart, changes }: DaemonOptions = {}) => {
    const own = apart ? new MemoryStorage() : storage;
    const approvals = new Approvals({ advisorFolders: { dataDir, backendDir: backend, home } });
    const mods = new ModRegistry(() => {});
    const history = new ChatProjection(ctx, () => "Ada");
    for (const extension of builtinExtensions({
      approvals,
      backendDir: backend,
      background: new BackgroundTasks(() => {}),
      schedules: new Schedules(join(root, "crons.json"), () => Promise.resolve(null)),
      history,
    }))
      mods.registry.install(extension);
    const options = {
      models,
      registry: mods.registry,
      env: chatEnvs(dataDir),
      settings: { retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }, ...(restartLimit === undefined ? {} : { restartLimit }) },
    };
    const stores = new StoreManager(
      join(dataDir, "stores"),
      options,
      ctx,
      () => {},
      () => AgentStore.open({ storage: own }, options, ctx),
    );
    history.follow(stores, () => {});
    const reports: string[] = [];
    const consults: AdvisorConsults = new AdvisorConsults({
      advisors: new Advisors({ stores, registry: mods.registry, backendDir: backend, home, context: ctx, canRun: () => Promise.resolve(true) }),
      stores,
      agents: () => [AGENT],
      context: ctx,
      deliver: (agentId, chatId, a) => {
        const real = () => chats.advise(agentId, chatId, a);
        return deliver ? deliver(a, real) : real();
      },
      now: () => clock.now,
      newId: () => `consult-${++ids}`,
      report: (m) => reports.push(m),
    });
    const chats: DaemonChats = new DaemonChats({
      stores,
      mods,
      approvals,
      providers: new Providers(models, new KeychainCredentials(memorySecrets())),
      models,
      backendDir: backend,
      context: ctx,
      now: () => clock.now,
      advisors: consults,
      ...(changes ? { changes } : {}),
    });
    chats.attach(() => {});
    const store = await stores.get(AGENT);
    await store.setAgent({ id: AGENT, name: "Ada" }, ctx);
    return { approvals, stores, store, chats, consults, reports };
  };

  const first = await daemon(firstOptions);
  const made = await first.chats.create(AGENT, folder, "Work");
  const chatId = made.conversationId;

  const ledger = async (d: { store: AgentStore }): Promise<AdvisorConsult[]> => {
    const chat = must(await d.store.chat(chatId, ctx), "the chat");
    return (await d.store.chatInfo(chat.id, ctx))?.advisor_consults ?? [];
  };
  const userTexts = async (d: { store: AgentStore }, id = chatId): Promise<string[]> => {
    const chat = must(await d.store.chat(id, ctx), `chat ${id}`);
    return (await d.store.entries(chat, ctx)).filter((e) => e.kind === "pi.user").map((e) => contentText(e.model?.[0]?.content));
  };
  const answers = async (d: { store: AgentStore }) => (await userTexts(d)).filter((t) => t.includes("<loki-advisor-answer"));
  const settled = (d: { store: AgentStore }) =>
    until(async () => {
      const list = await ledger(d);
      return list.length > 0 && list.every((c) => c.state !== "queued" && c.state !== "running");
    });

  const cleanup = async (...daemons: Array<{ stores: StoreManager }>) => {
    for (const d of daemons) await d.stores.closeAll();
    await first.stores.closeAll();
    rmSync(root, { recursive: true, force: true });
  };

  return { root, folder, faux, main, advice, seen, replies, clock, chatId, first, daemon, ledger, userTexts, answers, settled, cleanup };
}
