import { PEER_FRAMES, PHONE_FRAMES, frameEntry, type FrameName, type PushFrame } from "../core/frames.ts";
import type { Scope } from "../core/desk-core.ts";
import { errorMessage, fail, type FrameContext, type FrameHandlers, type Outcome } from "./frames/context.ts";
import type { Client, WsHandlers } from "./server.ts";
import type { Forwarded, Target } from "./chat-router.ts";

/**
 * The router for the mod's own socket (socket-free so it is testable). Every frame is declared in core/frames.ts;
 * each feature's frame handler (mod/frames/*) answers its own. For one incoming frame the router:
 *  1. looks it up in the table (an unknown name answers `error`);
 *  2. refuses it to a paired phone unless the table marks it for the phone, and to a paired Mac unless it marks it for
 *     Macs;
 *  3. parses it (a malformed one answers `error`);
 *  3½. sends it on, as it is, when it is about a chat or desk that lives on another paired Mac (mod/chat-router.ts),
 *     answering with that Mac's reply;
 *  4. calls its handler, sync or async;
 *  5. sends a request's reply under the table's name with its request_id, or `error` with the request_id when the
 *     handler failed, threw or rejected. A send's handler pushes what it causes; its failure answers `error`.
 * HTTP routes (agent faces, pairing, uploads) are mod/server.ts's and mod/lan.ts's.
 */

/** What the router is built from: the frame handlers, the welcome, and the host's broadcast and analytics. */
export interface BridgeDeps {
  /** The frame handlers (mod/frames/index.ts frameModules): each frame answered by exactly one. */
  modules: FrameHandlers[];
  /** What a socket is told when it opens (mod/frames/index.ts welcomeFrames). */
  welcome?: (scope: Scope) => PushFrame[];
  broadcast(msg: object, scope?: Scope): void;
  /** Analytics (mod/analytics.ts): an event this client caused, or a `capture` frame it sent about one the mod cannot see. */
  capture?: (client: Client, event: string, properties?: Record<string, unknown>) => void;
  /** Chats that live on another paired Mac (plan 023, U5): which Mac a frame is about, and sending it there. */
  route?: {
    /** The Mac a frame is about; a promise while a chat no Mac claimed yet is asked for (addendum B2). */
    target(msg: Record<string, unknown>): Target | Promise<Target>;
    /** The error that redirects a paired Mac's frame for a chat that left here (addendum B3), or null. */
    redirect(msg: Record<string, unknown>): { message: string; moved_to: string | null } | null;
    forward(home: NonNullable<Target>, msg: Record<string, unknown>, kind: "request" | "send"): Promise<Forwarded>;
  };
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

/**
 * The router over the given frame handlers, as the handlers the desktop's /ws and the phone listener both serve.
 * Throws at once when two handlers answer the same frame.
 */
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
    onConnect(client: Client) {
      // A tab opened on another Mac's chat: that Mac sends its desk (its agent, title and canvas), not an empty one from here.
      const ask = { type: "desk_get", scope: client.scope };
      // A desk is never asked for (chat-router.ts): this answer is what is known now.
      const known = !client.peerId && deps.route ? deps.route.target(ask) : null;
      const home = known instanceof Promise ? null : known;
      for (const frame of deps.welcome?.(client.scope) ?? []) {
        if (home && frame.type === "desk" && frame.scope === client.scope) continue;
        client.send(frame);
      }
      if (home && deps.route)
        void deps.route.forward(home, ask, "send").then((out) => {
          if (!out.ok) client.send({ type: "error", message: out.message });
        });
    },

    onMessage(client: Client, msg: Record<string, unknown>) {
      const requestId = typeof msg.request_id === "string" ? msg.request_id : undefined;
      // A paired phone shares this router with the desktop but not its authority (core/frames.ts PHONE_FRAMES).
      if (client.deviceId && !PHONE_FRAMES.has(msg.type as FrameName)) {
        return client.send({ type: "error", request_id: requestId, message: `${String(msg.type)} is not available on the phone` });
      }
      // Another Mac is trusted with its own list only (core/frames.ts PEER_FRAMES), never the desktop's authority.
      if (client.peerId && !PEER_FRAMES.has(msg.type as FrameName)) {
        return client.send({ type: "error", request_id: requestId, message: `${String(msg.type)} is not available to another Mac` });
      }
      const entry = frameEntry(msg.type);
      const route = deps.route;
      // A paired Mac's frame for a chat that no longer lives here: tell it where the chat went (addendum B3).
      const redirect = client.peerId && route && entry?.kind === "request" ? route.redirect(msg) : null;
      if (redirect) return client.send({ type: "error", request_id: requestId, ...redirect });
      // Another Mac's chat: that Mac answers. A paired Mac's own frames are answered here, never sent on. A malformed
      // frame is answered here like any other, without bothering the other Mac.
      if (client.peerId || !route || !entry || entry.kind === "push" || typeof entry.parse(msg) === "string") return here(client, msg);
      const kind = entry.kind;
      const forward = (home: NonNullable<Target>) =>
        void route.forward(home, msg, kind).then((out) => {
          if (!out.ok) return client.send({ type: "error", ...(kind === "request" ? { request_id: requestId } : {}), message: out.message });
          if (kind === "request" && out.reply) client.send({ ...out.reply, request_id: requestId });
        });
      const home = route.target(msg);
      if (!(home instanceof Promise)) return home ? forward(home) : here(client, msg);
      void home.then(
        (h) => (h ? forward(h) : here(client, msg)),
        () => here(client, msg),
      );
    },
  };

  /** Answer a frame on this Mac, by the handler that owns it. */
  function here(client: Client, msg: Record<string, unknown>): void {
    const requestId = typeof msg.request_id === "string" ? msg.request_id : undefined;
    const entry = frameEntry(msg.type);
    const handle = entry && entry.kind !== "push" ? handlers.get(msg.type as FrameName) : undefined;
    if (!entry || entry.kind === "push" || !handle)
      return client.send({ type: "error", request_id: requestId, message: `unsupported message type: ${String(msg.type)}` });
    const ctx: FrameContext = {
      client,
      push: (f) => client.send(f),
      broadcast: (f, scope) => deps.broadcast(f, scope),
      track: (event, properties) => deps.capture?.(client, event, properties),
    };
    // Parsing runs inside settle too: a frame that trips its parser is answered like any other failure.
    const run = () => {
      const payload = entry.parse(msg);
      if (typeof payload === "string") {
        if (entry.kind === "request") return fail(payload);
        throw new Error(payload);
      }
      return handle(payload as never, ctx);
    };
    if (entry.kind === "request") {
      const answer = (out: Outcome<object>) =>
        client.send(out.ok ? { ...out.reply, type: entry.reply, request_id: requestId } : { type: "error", request_id: requestId, message: out.message });
      return settle(
        run,
        (out) => answer(out as Outcome<object>),
        (err) => answer(fail(errorMessage(err))),
      );
    }
    settle(
      run,
      () => {},
      (err) => client.send({ type: "error", message: errorMessage(err) }),
    );
  }
}
