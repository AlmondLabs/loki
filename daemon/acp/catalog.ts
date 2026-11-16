import type * as acp from "@agentclientprotocol/sdk";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { EnginesView, EngineView } from "../../core/frame-types.ts";
import { REASONING_EFFORTS, type ChatEngineView, type ModelEntry, type ReasoningEffort } from "../../core/models.ts";
import type { ChatEngine } from "../kernel/index.ts";
import { builtInAgent, commandFound, readAcpAgents, writeAcpAgents, type AcpAgentConfig } from "./agents.ts";

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

export interface AgentHealth {
  status: "ready" | "started" | "failed";
  detail: string | null;
}

export interface AcpCatalogDeps {
  agents: () => AcpAgentConfig[];
  configFile?: string;
  cacheFile?: string;
}

function knownEfforts(levels: string[] | undefined): ReasoningEffort[] {
  return REASONING_EFFORTS.filter((e) => levels?.includes(e));
}

export function selectOptions(option: acp.SessionConfigOption | undefined): Offered["models"] {
  if (option?.type !== "select") return [];
  return option.options.flatMap((o) => ("options" in o ? o.options : [o])).map((o) => ({ value: o.value, name: o.name, description: o.description ?? null }));
}

export class AcpCatalog {
  private readonly deps: AcpCatalogDeps;
  private readonly offered: Map<string, Offered>;
  private readonly health = new Map<string, AgentHealth>();

  constructor(deps: AcpCatalogDeps) {
    this.deps = deps;
    this.offered = new Map(Object.entries(this.readCache()));
  }

  agent(id: string): AcpAgentConfig | undefined {
    return this.deps.agents().find((a) => a.id === id);
  }

  offeredBy(agent: string): Offered | undefined {
    return this.offered.get(agent);
  }

  offer(agent: string, next: Offered): void {
    if (JSON.stringify(next) === JSON.stringify(this.offered.get(agent))) return;
    this.offered.set(agent, next);
    if (!this.deps.cacheFile) return;
    try {
      mkdirSync(dirname(this.deps.cacheFile), { recursive: true });
      writeFileSync(this.deps.cacheFile, `${JSON.stringify(Object.fromEntries(this.offered), null, 2)}\n`);
    } catch {}
  }

  went(agent: string, health: AgentHealth): void {
    this.health.set(agent, health);
  }

  healthOf(agent: string): AgentHealth | undefined {
    return this.health.get(agent);
  }

  engines(): EnginesView {
    return {
      engines: this.deps.agents().map((a): EngineView => {
        const shipped = builtInAgent(a.id);
        const builtin = shipped !== undefined;
        const health = this.health.get(a.id);
        const failed = health?.status === "failed" ? (health.detail ?? "") : null;
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

  set(agent: AcpAgentConfig): void {
    this.edit((agents) => {
      const { env, auth_method, login } = agents.find((a) => a.id === agent.id) ?? {};
      const kept = { ...(env ? { env } : {}), ...(auth_method ? { auth_method } : {}), ...(login ? { login } : {}) };
      return [...agents.filter((a) => a.id !== agent.id), { ...kept, ...agent }];
    }, agent.id);
  }

  remove(id: string): void {
    const shipped = builtInAgent(id);
    this.edit((agents) => [...(shipped ? [shipped] : []), ...agents.filter((a) => a.id !== id)], id);
  }

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
          ...(m.description ? { description: m.description } : m.value === "default" ? { description: `runs on ${agent.name}, signed in as you` } : {}),
          ...(m.value === "default" ? { is_featured: true } : {}),
        };
        const efforts = knownEfforts(offered?.efforts?.[m.value]);
        return efforts.length ? efforts.map((e): ModelEntry => ({ ...entry, id: `${handle}@${e}`, reasoning_effort: e })) : [entry];
      });
    });
  }

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
