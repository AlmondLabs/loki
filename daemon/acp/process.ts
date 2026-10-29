import { client, methods, ndJsonStream, PROTOCOL_VERSION, type ClientConnection } from "@agentclientprotocol/sdk";
import type * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type { AcpAgentConfig } from "./agents.ts";
import { messageOf } from "../../core/errors.ts";

/**
 * One ACP agent's process (plan 020): started on first use, spoken to over stdio with the ACP SDK, and started again
 * on the next use after it exits. loki offers it neither files nor terminals (KD8), so the agent reads, writes and
 * runs commands itself. Nothing here knows about chats: the sessions on it are AcpChats' (daemon/acp/chats.ts).
 */

/** What the agent asks of loki while it works: every session's updates, and permission for a tool call. */
export interface AcpHandlers {
  update(n: acp.SessionNotification): void;
  permission(r: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse>;
  /** The agent asks the person to open a page, such as an MCP server's sign-in (plan 044); a form it asks for is declined. */
  elicit(r: acp.CreateElicitationRequest): Promise<acp.CreateElicitationResponse>;
  /** Each line the agent writes to stderr, as it comes: the daemon's log keeps it, since the tail below is lost on a restart. */
  log?(line: string): void;
}

/** How much of the agent's stderr is kept, to say why it failed (R11). */
const STDERR_TAIL = 2000;
/** The longest stderr line passed to the log; a longer one (a dumped object, say) is cut there. */
const LOG_LINE_MAX = 1000;

/** A started agent: its connection, what it said it can do, and how to stop it. */
interface Running {
  connection: ClientConnection;
  init: acp.InitializeResponse;
  kill: () => void;
}

/**
 * Starts of every agent's process, counted across them all: an agent edited in Settings gets a new AcpProcess, and a
 * count of its own would hand the new process the epoch a session on the old one was opened at.
 */
let starts = 0;

/** The agent's process, as AcpChats uses it. */
export class AcpProcess {
  readonly config: AcpAgentConfig;
  private readonly handlers: AcpHandlers;
  private running: Promise<Running> | null = null;
  private stderrTail = "";
  /** Bumped on each start, so an old process's exit does not clear the new one. */
  private generation = 0;

  constructor(config: AcpAgentConfig, handlers: AcpHandlers) {
    this.config = config;
    this.handlers = handlers;
  }

  /** The last of what the agent wrote to stderr, for the chat to show when it fails. */
  stderr(): string {
    return this.stderrTail.trim();
  }

  /** The running agent, started (and initialized) if it is not running. */
  private started(): Promise<Running> {
    this.running ??= this.start();
    return this.running;
  }

  /** Which start of the process is the latest: a session opened on an earlier one is gone. */
  epoch(): number {
    return this.generation;
  }

  /** What the agent said it can do when it started; starts it if it is not running. */
  async capabilities(): Promise<acp.AgentCapabilities> {
    return (await this.started()).init.agentCapabilities ?? {};
  }

  private async start(): Promise<Running> {
    const generation = (this.generation = ++starts);
    this.stderrTail = "";
    // npx and other .cmd shims run only through a shell on Windows; a program named by its .exe runs as it is.
    const child = spawn(this.config.command, this.config.args, {
      env: { ...process.env, ...this.config.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" && !/\.exe$/i.test(this.config.command),
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
    const exited = new Promise<Error>((resolve) => {
      child.once("error", (e) => resolve(e));
      child.once("exit", (code, signal) => resolve(new Error(`${this.config.name} exited (${signal ?? `code ${code}`})`)));
    });
    const stream = ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
    const connection = client({ name: "loki" })
      .onRequest(methods.client.session.requestPermission, (ctx) => this.handlers.permission(ctx.params))
      // A page the agent asks the person to open. Its later `elicitation/complete` is left unhandled on purpose: the card
      // is already answered, and a second notification handler makes the SDK deliver `session/update`s out of order
      // with responses, so a loaded session's replayed history leaked into the next turn (found 2026-10-27).
      .onRequest(methods.client.elicitation.create, (ctx) => this.handlers.elicit(ctx.params))

      .onNotification(methods.client.session.update, (ctx) => {
        this.handlers.update(ctx.params);
      })
      .connect(stream);
    const kill = () => {
      connection.close();
      child.kill();
    };
    void exited.then((error) => connection.close(error));
    // The connection can close before the process says it exited (its stdout ends first): either way, the next use starts it again.
    void connection.closed.then(() => {
      if (this.generation === generation) this.running = null;
    });
    try {
      const init = await Promise.race([
        connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          // Pages to open (an MCP server's sign-in, plan 044), shown as a card; no forms.
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { url: {} } },
          clientInfo: { name: "loki", version: "1" },
        }),
        exited.then((e) => Promise.reject(e)),
      ]);
      // An agent that opens no session until asked to sign in (plan 048); it uses a login the person made with it.
      if (this.config.auth_method)
        await Promise.race([
          connection.agent.request(methods.agent.authenticate, { methodId: this.config.auth_method }),
          exited.then((e) => Promise.reject(e)),
        ]);
      return { connection, init, kill };
    } catch (error) {
      kill();
      if (this.generation === generation) this.running = null;
      throw this.failure(error);
    }
  }

  /** An error with what the agent last wrote to stderr, which usually says why (not signed in, Node missing). */
  failure(error: unknown): Error {
    const message = messageOf(error);
    const tail = this.stderr();
    return new Error(tail ? `${message}\n${tail.split("\n").slice(-5).join("\n")}` : message);
  }

  /** The agent's methods loki calls. */
  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    return (await this.started()).connection.agent.request(methods.agent.session.new, params);
  }

  async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    return (await this.started()).connection.agent.request(methods.agent.session.load, params);
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    return (await this.started()).connection.agent.request(methods.agent.session.prompt, params);
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

  /** Stop the agent; the next call starts it again. */
  async close(): Promise<void> {
    const running = this.running;
    this.running = null;
    this.generation++;
    if (running) (await running.catch(() => null))?.kill();
  }
}
