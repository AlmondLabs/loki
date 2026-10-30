import type * as acp from "@agentclientprotocol/sdk";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { EnginesView, EngineView } from "../../core/frame-types.ts";
import { REASONING_EFFORTS, type ChatEngineView, type ModelEntry, type ReasoningEffort } from "../../core/models.ts";
import type { ChatEngine } from "../kernel/index.ts";
import { builtInAgent, commandFound, readAcpAgents, writeAcpAgents, type AcpAgentConfig } from "./agents.ts";

/**
 * The ACP agents loki knows, apart from running them (plan 020): which there are and how each starts (Settings ›
 * Engines edits them), how each last went, and what each offered in its last session (its models, modes, commands
 * and effort levels), kept so the model picker and a chat's menus have them before the agent next starts. The chats
 * themselves (daemon/acp/chats.ts) run the agents, and tell this what a session offered and how a turn went.
 */

/** What an agent offered in its last session: the model picker's and the mode chip's choices, and its commands. */
export interface Offered {
  models: Array<{ value: string; name: string; description: string | null }>;
  modes: ChatEngineView["modes"];
  commands: ChatEngineView["commands"];
  /**
   * Each model's effort levels, by the model's value, as its `thought_level` option listed them (plan 021, R4). A
   * session reports only its current model's, so they gather as models are used; absent from a cache written
   * before this field.
   */
  efforts?: Record<string, string[]>;
}

/** How an agent last went: a message through, a start, or a failure with its reason. */
export interface AgentHealth {
  status: "ready" | "started" | "failed";
  detail: string | null;
}

/** What the catalog is made with: the agents, and the files that keep them and what they offered. */
export interface AcpCatalogDeps {
  /** The ACP agents loki knows (daemon/acp/agents.ts), read on each use so an added agent needs no restart. */
  agents: () => AcpAgentConfig[];
  /** The person's agents file (`state/acp.json`), which Settings › Engines edits; absent, the agents cannot be edited. */
  configFile?: string;
  /** Where what each agent last offered is kept; absent, it is kept only while the daemon runs. */
  cacheFile?: string;
}

/** An agent's effort levels that loki has words for, least to most; its own "default" and any others are left out. */
function knownEfforts(levels: string[] | undefined): ReasoningEffort[] {
  return REASONING_EFFORTS.filter((e) => levels?.includes(e));
}

/** A select option list, its groups flattened. */
export function selectOptions(option: acp.SessionConfigOption | undefined): Offered["models"] {
  if (option?.type !== "select") return [];
  return option.options.flatMap((o) => ("options" in o ? o.options : [o])).map((o) => ({ value: o.value, name: o.name, description: o.description ?? null }));
}

/** The ACP agents loki knows, how each stands, and what each offered. */
export class AcpCatalog {
  private readonly deps: AcpCatalogDeps;
  private readonly offered: Map<string, Offered>;
  private readonly health = new Map<string, AgentHealth>();

  constructor(deps: AcpCatalogDeps) {
    this.deps = deps;
    this.offered = new Map(Object.entries(this.readCache()));
  }

  /** The agent named `id`, if loki knows it. */
  agent(id: string): AcpAgentConfig | undefined {
    return this.deps.agents().find((a) => a.id === id);
  }

  /** What the agent offered in its last session, if it has run. */
  offeredBy(agent: string): Offered | undefined {
    return this.offered.get(agent);
  }

  /** What a session of the agent offers now: kept, and written to the cache when it changed. */
  offer(agent: string, next: Offered): void {
    if (JSON.stringify(next) === JSON.stringify(this.offered.get(agent))) return;
    this.offered.set(agent, next);
    if (!this.deps.cacheFile) return;
    try {
      mkdirSync(dirname(this.deps.cacheFile), { recursive: true });
      writeFileSync(this.deps.cacheFile, `${JSON.stringify(Object.fromEntries(this.offered), null, 2)}\n`);
    } catch {
      // Only a convenience: the next session offers them again.
    }
  }

  /** How the agent went just now (Settings › Engines shows it). */
  went(agent: string, health: AgentHealth): void {
    this.health.set(agent, health);
  }

  /** How the agent last went, if it has been asked anything since the daemon started. */
  healthOf(agent: string): AgentHealth | undefined {
    return this.health.get(agent);
  }

  /** Settings › Engines: every agent, how it starts and how it stands. */
  engines(): EnginesView {
    return {
      engines: this.deps.agents().map((a): EngineView => {
        const shipped = builtInAgent(a.id);
        const builtin = shipped !== undefined;
        const health = this.health.get(a.id);
        const failed = health?.status === "failed" ? (health.detail ?? "") : null;
        // An agent that needs signing in says so in its own words; loki only tells the two kinds of failure apart.
        const signedOut = failed !== null && /auth|sign.?in|log.?in|credential/i.test(failed);
        const status: EngineView["status"] = !commandFound(a.command, { ...process.env, ...a.env })
          ? "not_found"
          : signedOut
            ? "signed_out"
            : (health?.status ?? "unknown");
        const detail =
          status === "not_found"
            ? `${a.command} is not on loki's PATH${a.command === "npx" ? "; install Node" : ""}`
            : status === "signed_out"
              ? a.login
                ? `run ${a.login} in a terminal, then send again`
                : `sign in to ${a.name}, then send again`
              : (health?.detail ?? null);
        const changed = builtin && JSON.stringify(a) !== JSON.stringify(shipped);
        return { id: a.id, name: a.name, command: a.command, args: a.args, builtin, changed, status, detail };
      }),
      config_path: this.deps.configFile ?? "",
    };
  }

  /**
   * Add an agent, or change how one starts (a built-in one's change is kept as an override of it). What Settings does
   * not show (its environment, its sign-in method and command) is kept from the agent as it was.
   */
  set(agent: AcpAgentConfig): void {
    this.edit((agents) => {
      const { env, auth_method, login } = agents.find((a) => a.id === agent.id) ?? {};
      const kept = { ...(env ? { env } : {}), ...(auth_method ? { auth_method } : {}), ...(login ? { login } : {}) };
      return [...agents.filter((a) => a.id !== agent.id), { ...kept, ...agent }];
    }, agent.id);
  }

  /** Remove an agent; a built-in one goes back to how loki ships it. */
  remove(id: string): void {
    const shipped = builtInAgent(id);
    this.edit((agents) => [...(shipped ? [shipped] : []), ...agents.filter((a) => a.id !== id)], id);
  }

  /** The chat's engine as the app shows it: the agent's name, the model, and its modes and commands. */
  view(engine: Pick<ChatEngine, "agent" | "model">): ChatEngineView {
    const offered = this.offered.get(engine.agent);
    return {
      agent: engine.agent,
      name: this.agent(engine.agent)?.name ?? engine.agent,
      model: engine.model,
      modes: offered?.modes ?? [],
      commands: offered?.commands ?? [],
    };
  }

  /**
   * Each ACP agent's models for the model picker: what it offered last, or its default before it has run. Its
   * default is featured, so the agent is among the quick picks. A model whose effort levels are known is one entry
   * per level, as loki's own presets are (plan 021, R4). An agent that has never run and is not installed is left out,
   * so a built-in one the person does not have is no quick pick (plan 048).
   */
  models(): ModelEntry[] {
    return this.deps.agents().flatMap((agent) => {
      const offered = this.offered.get(agent.id);
      if (!offered && !commandFound(agent.command, { ...process.env, ...agent.env })) return [];
      const models = offered?.models ?? [];
      const choices = models.some((m) => m.value === "default") ? models : [{ value: "default", name: "Default", description: null }, ...models];
      return choices.flatMap((m) => {
        const handle = `acp:${agent.id}/${m.value}`;
        const entry: ModelEntry = {
          id: handle,
          handle,
          label: m.value === "default" ? agent.name : `${agent.name} · ${m.name}`,
          // Its default says what the agent is; its other models are under the agent's tab, so need no such line.
          ...(m.description ? { description: m.description } : m.value === "default" ? { description: `runs on ${agent.name}, signed in as you` } : {}),
          ...(m.value === "default" ? { is_featured: true } : {}),
        };
        const efforts = knownEfforts(offered?.efforts?.[m.value]);
        return efforts.length ? efforts.map((e): ModelEntry => ({ ...entry, id: `${handle}@${e}`, reasoning_effort: e })) : [entry];
      });
    });
  }

  /** The agents file changed; how the agent went before no longer says how it goes now. */
  private edit(change: (agents: AcpAgentConfig[]) => AcpAgentConfig[], id: string): void {
    if (!this.deps.configFile) throw new Error("this daemon keeps no agents file");
    writeAcpAgents(this.deps.configFile, change(readAcpAgents(this.deps.configFile)));
    this.health.delete(id);
  }

  private readCache(): Record<string, Offered> {
    try {
      const parsed: unknown = this.deps.cacheFile ? JSON.parse(readFileSync(this.deps.cacheFile, "utf8")) : null;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, Offered>) : {};
    } catch {
      return {};
    }
  }
}
