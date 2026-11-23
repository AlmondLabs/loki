import type { Context } from "@earendil-works/chord";
import {
  defineExtension,
  section,
  wrapSection,
  type Conversation,
  type Extension,
  type RegistryReader,
  type ToolRegistration,
  type Wrap,
} from "@earendil-works/pi-durable";
import { advisorChatId } from "../core/advisor.ts";
import type { LocalAgent } from "../core/frame-types.ts";
import { harnessOf, type ReasoningEffort } from "../core/models.ts";
import { keyedQueue } from "../core/serial.ts";
import { readLocalAgent } from "../mod/agents.ts";
import { ADVISOR_TOOLS } from "./advisor-gate.ts";
import type { MovedAdvisor } from "./chat-move.ts";
import { ADVISOR_EXTENSION, AgentInfoDoc, type AgentStore } from "./kernel/index.ts";
import { modelRef, thinkingLevel } from "./loki-engine.ts";
import { memoryRoot, memorySection } from "./memory.ts";
import { sections } from "./section-cache.ts";
import { fileTools } from "./tools.ts";

const DIRECT_HISTORY = ["history_search", "history_read"];

export const LEFT_OUT_SECTIONS: readonly string[] = ["replies", "canvas", "accounts", "mcp"];

const PROFILE = "Agents › Profile";

export const ADVISOR_PROMPT = [
  "You are this agent, advising on the work of one of the person's chats: a second opinion from a model that has not taken on that chat's framing.",
  "You never see that chat. You know only the consults sent to you here, what the person writes to you here, and what you read yourself.",
  "You read and never change anything: you read and search files, run commands that only read, read the folder's git changes with changes_read, search the web, and read your memory and skills. Any other call is refused.",
  "Check what a consult claims against the files and changes themselves before you agree or disagree, and say plainly what you could not check.",
  "Answer with your findings grouped by severity, most severe first, each with its file and line, what is wrong and what would fix it. Then, when you have any:",
  "Not asked, but noticed: problems outside what you were asked about.",
  "Could not check: what you could not verify, and what would settle it.",
  "When you raise nothing new, end your answer with this line alone:",
  "Nothing new.",
].join("\n");

export function advisorExtension(backendDir: string): Extension {
  const history = DIRECT_HISTORY.map((name): Wrap => ({
    tool: name,
    wrap: (tool: ToolRegistration): ToolRegistration => ({ ...tool, callers: ["model", "tools"] }),
  }));
  const files = fileTools({ followLinks: false }).map((own): Wrap => ({ tool: own.name, wrap: (): ToolRegistration => own }));
  const leftOut = LEFT_OUT_SECTIONS.map((key) => wrapSection(key, (s) => ({ ...s, render: () => undefined })));
  const memory = wrapSection("memory", (s) => ({
    ...s,
    render: async (input, context) => {
      const agent = await input.read.snapshot(AgentInfoDoc, context);
      if (!agent?.id) return undefined;
      const root = memoryRoot(backendDir, agent.id);
      return sections.get(`memory-read\u0000${root}`, () => memorySection(root, "read"));
    },
  }));
  return defineExtension({ name: ADVISOR_EXTENSION, sections: [section("advisor", () => ADVISOR_PROMPT)], wraps: [...history, ...files, ...leftOut, memory] });
}

export type AdvisorModel = { handle: string; effort: ReasoningEffort | null } | { refused: string };

export async function advisorModel(agent: LocalAgent | null, canRun: (handle: string) => Promise<boolean>): Promise<AdvisorModel> {
  const own = agent?.model && harnessOf(agent.model) === null ? agent.model : null;
  const handle = agent?.advisor_model ?? own;
  if (!handle || !modelRef(handle))
    return { refused: `This agent has no advisor model, and its own model is not one of loki's: set an advisor model in ${PROFILE}.` };
  if (!(await canRun(handle)))
    return {
      refused: `${handle} cannot be reached on this Mac: connect its provider in Preferences › Providers, or pick another advisor model in ${PROFILE}.`,
    };
  return { handle, effort: agent?.advisor_model ? agent.advisor_reasoning_effort : null };
}

export type AdvisorOpen = { chat: Conversation; advisorId: string; created: boolean } | { refused: string };

export interface AdvisorDeps {
  stores: { get(agentId: string): Promise<AgentStore> };
  registry: RegistryReader;
  backendDir: string;
  home: string;
  context: Context;
  canRun(handle: string): Promise<boolean>;
}

export class Advisors {
  private readonly deps: AdvisorDeps;
  private readonly queue = keyedQueue();

  constructor(deps: AdvisorDeps) {
    this.deps = deps;
  }

  open(agentId: string, chatId: string): Promise<AdvisorOpen> {
    return this.queue(`${agentId}\u0000${chatId}`, () => this.openNow(agentId, chatId));
  }

  private async openNow(agentId: string, chatId: string): Promise<AdvisorOpen> {
    const { context } = this.deps;
    const store = await this.deps.stores.get(agentId);
    const advisorId = advisorChatId(chatId);
    const known = await store.chat(advisorId, context);
    if (known) return { chat: known, advisorId, created: false };
    const advised = await store.chat(chatId, context);
    if (!advised) return { refused: "The chat this advisor would work for is gone." };
    const choice = await advisorModel(readLocalAgent(agentId, this.deps.backendDir), (handle) => this.deps.canRun(handle));
    if ("refused" in choice) return choice;
    const model = modelRef(choice.handle);
    const chat = await this.make(store, chatId, {
      ...(model ? { model } : {}),
      ...(choice.effort ? { effort: choice.effort } : {}),
      cwd: (await advised.agent(context)).cwd ?? this.deps.home,
    });
    return { chat, advisorId, created: true };
  }

  private async make(store: AgentStore, chatId: string, agent: MovedAdvisor["agent"], createdAt?: string): Promise<Conversation> {
    const snapshot = this.deps.registry.snapshot();
    const advisor = snapshot.extension(ADVISOR_EXTENSION);
    if (!advisor) throw new Error(`loki's ${ADVISOR_EXTENSION} extension is not installed`);
    const registered = new Map<string, ToolRegistration>(snapshot.tools().map(({ tool }) => [tool.name, tool]));
    const tools = ADVISOR_TOOLS.flatMap((name) => registered.get(name) ?? []);
    const level = thinkingLevel(agent.effort ?? null);
    return store.createChat(
      advisorChatId(chatId),
      {
        title: "Advisor",
        hidden: true,
        mode: "standard",
        advisor_for: chatId,
        ...(createdAt ? { createdAt } : {}),
        agent: {
          tools,
          modelTools: tools,
          extensions: { add: [advisor] },
          ...(agent.model ? { model: agent.model } : {}),
          ...(level ? { thinkingLevel: level } : {}),
          cwd: agent.cwd ?? this.deps.home,
        },
      },
      this.deps.context,
    );
  }

  adopt(agentId: string, chatId: string, moved: MovedAdvisor): Promise<void> {
    return this.queue(`${agentId}\u0000${chatId}`, async () => {
      const { context } = this.deps;
      const store = await this.deps.stores.get(agentId);
      const advisorId = advisorChatId(chatId);
      if (await store.chat(advisorId, context)) await store.retireChat(advisorId, context);
      const chat = await this.make(store, chatId, moved.agent, moved.created_at);
      try {
        await store.importEntries(chat, moved.entries, context);
        if (moved.archived) await store.updateChat(advisorId, { archived: true }, context);
      } catch (error) {
        await store.retireChat(advisorId, context).catch(() => false);
        throw error;
      }
    });
  }

  async followFolder(agentId: string, chatId: string): Promise<void> {
    const { context } = this.deps;
    const store = await this.deps.stores.get(agentId);
    const advisor = await store.chat(advisorChatId(chatId), context);
    const advised = await store.chat(chatId, context);
    if (!advisor || !advised) return;
    const cwd = (await advised.agent(context)).cwd ?? this.deps.home;
    if ((await advisor.agent(context)).cwd !== cwd) await advisor.configure({ cwd }, context);
  }
}
