import { PHONE_FRAMES, frameEntry, type FrameName, type PushFrame } from "../core/frames.ts";
import type { Scope } from "../core/desk-core.ts";
import { errorMessage, fail, type FrameContext, type FrameHandlers, type Outcome } from "./frames/context.ts";
import type { Client, WsHandlers } from "./server.ts";

/**
 * The router for the mod's own socket (socket-free so it is testable). Every frame is declared in core/frames.ts;
 * each feature's frame handler (mod/frames/*) answers its own. For one incoming frame the router:
 *  1. looks it up in the table (an unknown name answers `error`);
 *  2. refuses it to a paired phone unless the table marks it for the phone;
 *  3. parses it (a malformed one answers `error`);
 *  4. calls its handler, sync or async;
 *  5. sends a request's reply under the table's name with its requestId, or `error` with the requestId when the
 *     handler failed, threw or rejected. A send's handler pushes what it causes; its failure answers `error`.
 * HTTP routes (agent faces, pairing, uploads, the /appserver tunnel) are mod/server.ts's and mod/lan.ts's.
 */
export interface BridgeDeps {
  /** The frame handlers (mod/frames/index.ts frameModules): each frame answered by exactly one. */
  modules: FrameHandlers[];
  /** What a socket is told when it opens (mod/frames/index.ts welcomeFrames). */
  welcome?: (scope: Scope) => PushFrame[];
  broadcast(msg: object, scope?: Scope): void;
  /** Analytics (mod/analytics.ts): an event this client caused, or a `capture` frame it sent about one the mod cannot see. */
  capture?: (client: Client, event: string, properties?: Record<string, unknown>) => void;
  appServerUrl?: () => string | null;
}

type Handler = (payload: never, ctx: FrameContext) => unknown;

/** Run a handler, sync or async, and hand its outcome or its failure on; nothing it does escapes unanswered. */
function settle(run: () => unknown, ok: (value: unknown) => void, bad: (err: unknown) => void): void {
  try {
    const r = run();
    if (r && typeof (r as Promise<unknown>).then === "function") (r as Promise<unknown>).then(ok, bad);
    else ok(r);
  } catch (err) {
    bad(err);
  }
}

export function createBridge(deps: BridgeDeps): WsHandlers {
  /** Which handler answers each frame: one per name, or the table and the modules disagree. */
  const handlers = new Map<FrameName, Handler>();
  for (const m of deps.modules) {
    for (const [name, h] of Object.entries(m) as Array<[FrameName, Handler]>) {
      if (handlers.has(name)) throw new Error(`two handlers for ${name}`);
      handlers.set(name, h);
    }
  }

  return {
    appServerUrl: () => deps.appServerUrl?.() ?? null,
    onConnect(client: Client) {
      for (const frame of deps.welcome?.(client.scope) ?? []) client.send(frame);
    },

    onMessage(client: Client, msg: Record<string, unknown>) {
      const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
      // A paired phone shares this router with the desktop but not its authority (core/frames.ts PHONE_FRAMES).
      if (client.deviceId && !PHONE_FRAMES.has(msg.type as FrameName)) {
        return client.send({ type: "error", requestId, message: `${String(msg.type)} is not available on the phone` });
      }
      const entry = frameEntry(msg.type);
      const handle = entry && entry.kind !== "push" ? handlers.get(msg.type as FrameName) : undefined;
      if (!entry || entry.kind === "push" || !handle) return client.send({ type: "error", requestId, message: `unsupported message type: ${String(msg.type)}` });
      const ctx: FrameContext = {
        client,
        push: (f) => client.send(f),
        broadcast: (f, scope) => deps.broadcast(f, scope),
        track: (event, properties) => deps.capture?.(client, event, properties),
      };
      const payload = entry.parse(msg);
      if (entry.kind === "request") {
        const answer = (out: Outcome<object>) => client.send(out.ok ? { ...out.reply, type: entry.reply, requestId } : { type: "error", requestId, message: out.message });
        if (typeof payload === "string") return answer(fail(payload));
        return settle(() => handle(payload as never, ctx), (out) => answer(out as Outcome<object>), (err) => answer(fail(errorMessage(err))));
      }
      if (typeof payload === "string") return client.send({ type: "error", message: payload });
      settle(() => handle(payload as never, ctx), () => {}, (err) => client.send({ type: "error", message: errorMessage(err) }));
    },
  };
}
