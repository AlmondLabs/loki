import { client, methods, ndJsonStream, PROTOCOL_VERSION, type ClientConnection } from "@agentclientprotocol/sdk";
import type * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type { AcpAgentConfig } from "./agents.ts";
import { messageOf } from "../../core/errors.ts";
import { killTree } from "../tree-kill.ts";

export interface AcpHandlers {
  update(n: acp.SessionNotification): void;
  permission(r: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse>;
  elicit(r: acp.CreateElicitationRequest): Promise<acp.CreateElicitationResponse>;
  log?(line: string): void;
}

const STDERR_TAIL = 2000;
const LOG_LINE_MAX = 1000;

interface Running {
  connection: ClientConnection;
  init: acp.InitializeResponse;
  kill: () => void;
}

export const START_TIMEOUT_MS = 180_000;

export class AcpProcess {
  readonly config: AcpAgentConfig;
  private readonly handlers: AcpHandlers;
  private running: Promise<Running> | null = null;
  private stderrTail = "";
  private generation: symbol;
  private kill: (() => void) | null = null;
  private readonly startTimeoutMs: number;
  private readonly clientVersion: string;

  constructor(config: AcpAgentConfig, handlers: AcpHandlers, startTimeoutMs = START_TIMEOUT_MS, clientVersion = "1") {
    this.config = config;
    this.handlers = handlers;
    this.startTimeoutMs = startTimeoutMs;
    this.clientVersion = clientVersion;
    this.generation = Symbol(config.name);
  }

  stderr(): string {
    return this.stderrTail.trim();
  }

  private started(): Promise<Running> {
    this.running ??= this.start();
    return this.running;
  }

  epoch(): symbol {
    return this.generation;
  }

  async capabilities(): Promise<acp.AgentCapabilities> {
    return (await this.started()).init.agentCapabilities ?? {};
  }

  private async start(): Promise<Running> {
    const generation = (this.generation = Symbol(this.config.name));
    this.stderrTail = "";
    // Outside (Windows): npx and other .cmd shims run only through a shell; a program named by its .exe runs as it is.
    const child = spawn(this.config.command, this.config.args, {
      env: { ...process.env, ...this.config.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" && !/\.exe$/i.test(this.config.command),
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    child.stderr.setEncoding("utf8");
    let partial = "";
    child.stderr.on("data", (text: string) => {
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL);
      const lines = (partial + text).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) this.handlers.log?.(line.slice(0, LOG_LINE_MAX));
    });
    child.stderr.on("end", () => {
      if (partial.trim()) this.handlers.log?.(partial.slice(0, LOG_LINE_MAX));
      partial = "";
    });
    const exited = new Promise<Error>((resolve) => {
      child.once("error", (e) => resolve(e));
      child.once("exit", (code, signal) => resolve(new Error(`${this.config.name} exited (${signal ?? `code ${code}`})`)));
    });
    const stream = ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
    const connection = client({ name: "loki" })
      .onRequest(methods.client.session.requestPermission, (ctx) => this.handlers.permission(ctx.params))
      // Outside (ACP): the later `elicitation/complete` is left unhandled, as a second notification handler makes the SDK
      // deliver `session/update`s out of order with responses, and a loaded session's replayed history leaked into the
      // next turn.
      .onRequest(methods.client.elicitation.create, (ctx) => this.handlers.elicit(ctx.params))

      .onNotification(methods.client.session.update, (ctx) => {
        this.handlers.update(ctx.params);
      })
      .connect(stream);
    const kill = () => {
      connection.close();
      if (child.pid === undefined) child.kill();
      else killTree(child.pid);
    };
    this.kill = kill;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${this.config.name} did not start within ${Math.round(this.startTimeoutMs / 1000)} s`)), this.startTimeoutMs);
      timer.unref();
    });
    void exited.then((error) => connection.close(error));
    // Outside (Node): a child's stdout can end, closing the connection, before the child says it exited.
    void connection.closed.then(() => {
      if (this.generation === generation) this.running = null;
    });
    try {
      const init = await Promise.race([
        connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            elicitation: { url: {} },
            session: { compaction: {}, notices: {} },
          },
          clientInfo: { name: "loki", version: this.clientVersion },
        }),
        exited.then((e) => Promise.reject(e)),
        timedOut,
      ]);
      if (init.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(`${this.config.name} asked for ACP protocol version ${String(init.protocolVersion)}, not ${PROTOCOL_VERSION}`);
      }
      if (this.config.auth_method) {
        const offered = init.authMethods;
        if (offered && !offered.some((m) => m.id === this.config.auth_method)) {
          throw new Error(`${this.config.name} does not offer sign-in method ${this.config.auth_method}`);
        }
        await Promise.race([
          connection.agent.request(methods.agent.authenticate, { methodId: this.config.auth_method }),
          exited.then((e) => Promise.reject(e)),
          timedOut,
        ]);
      }
      return { connection, init, kill };
    } catch (error) {
      kill();
      if (this.generation === generation) this.running = null;
      throw this.failure(error);
    } finally {
      clearTimeout(timer);
    }
  }

  failure(error: unknown): Error {
    const message = messageOf(error);
    const tail = this.stderr();
    return new Error(tail ? `${message}\n${tail.split("\n").slice(-5).join("\n")}` : message);
  }

  async newSession(params: acp.NewSessionRequest, cancellationSignal?: AbortSignal): Promise<acp.NewSessionResponse> {
    return (await this.started()).connection.agent.request(methods.agent.session.new, params, cancellationSignal ? { cancellationSignal } : undefined);
  }

  async loadSession(params: acp.LoadSessionRequest, cancellationSignal?: AbortSignal): Promise<acp.LoadSessionResponse> {
    return (await this.started()).connection.agent.request(methods.agent.session.load, params, cancellationSignal ? { cancellationSignal } : undefined);
  }

  async resumeSession(params: acp.ResumeSessionRequest, cancellationSignal?: AbortSignal): Promise<acp.ResumeSessionResponse> {
    return (await this.started()).connection.agent.request(methods.agent.session.resume, params, cancellationSignal ? { cancellationSignal } : undefined);
  }

  async closeSession(params: acp.CloseSessionRequest): Promise<acp.CloseSessionResponse> {
    return (await this.started()).connection.agent.request(methods.agent.session.close, params);
  }

  async prompt(params: acp.PromptRequest, cancellationSignal?: AbortSignal): Promise<acp.PromptResponse> {
    return (await this.started()).connection.agent.request(methods.agent.session.prompt, params, cancellationSignal ? { cancellationSignal } : undefined);
  }

  async cancel(sessionId: string): Promise<void> {
    if (!this.running) return;
    await (await this.running).connection.agent.notify(methods.agent.session.cancel, { sessionId });
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await (await this.started()).connection.agent.request(methods.agent.session.setMode, { sessionId, modeId });
  }

  async setConfigOption(sessionId: string, configId: string, value: string): Promise<acp.SetSessionConfigOptionResponse> {
    return (await this.started()).connection.agent.request(methods.agent.session.setConfigOption, { sessionId, configId, value });
  }

  async close(): Promise<void> {
    const running = this.running;
    const kill = this.kill;
    this.running = null;
    this.kill = null;
    this.generation = Symbol(this.config.name);
    kill?.();
    await running?.catch(() => null);
  }
}
