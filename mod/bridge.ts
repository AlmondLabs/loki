import { PEER_FRAMES, PHONE_FRAMES, frameEntry, type FrameName, type PushFrame } from "../core/frames.ts";
import type { Scope } from "../core/desk-core.ts";
import { errorMessage, fail, type FrameContext, type FrameHandlers, type Outcome } from "./frames/context.ts";
import type { Client, WsHandlers } from "./server.ts";
import type { Forwarded, Target } from "./chat-router.ts";

export interface BridgeDeps {
  modules: FrameHandlers[];
  welcome?: (scope: Scope) => PushFrame[];
  broadcast(msg: object, scope?: Scope): void;
  capture?: (client: Client, event: string, properties?: Record<string, unknown>) => void;
  route?: {
    target(msg: Record<string, unknown>): Target | Promise<Target>;
    redirect(msg: Record<string, unknown>): { message: string; moved_to: string | null } | null;
    forward(home: NonNullable<Target>, msg: Record<string, unknown>, kind: "request" | "send"): Promise<Forwarded>;
  };
}

type Handler = (payload: never, ctx: FrameContext) => unknown;

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
  const handlers = new Map<FrameName, Handler>();
  for (const m of deps.modules) {
    for (const [name, h] of Object.entries(m) as Array<[FrameName, Handler]>) {
      if (handlers.has(name)) throw new Error(`two handlers for ${name}`);
      handlers.set(name, h);
    }
  }

  return {
    onConnect(client: Client) {
      const ask = { type: "desk_get", scope: client.scope };
      const known = !client.peerId && deps.route ? deps.route.target(ask) : null;
      const home = known instanceof Promise ? null : known;
      for (const frame of deps.welcome?.(client.scope) ?? []) {
        if (home && frame.type === "desk" && frame.scope === client.scope) continue;
        client.send(frame);
      }
      if (home && deps.route)
        void deps.route.forward(home, ask, "send").then(
          (out) => {
            if (!out.ok) client.send({ type: "error", message: out.message });
          },
          (err: unknown) => client.send({ type: "error", message: errorMessage(err) }),
        );
    },

    onMessage(client: Client, msg: Record<string, unknown>) {
      const requestId = typeof msg.request_id === "string" ? msg.request_id : undefined;
      if (client.deviceId && !PHONE_FRAMES.has(msg.type as FrameName)) {
        return client.send({ type: "error", request_id: requestId, message: `${String(msg.type)} is not available on the phone` });
      }
      if (client.peerId && !PEER_FRAMES.has(msg.type as FrameName)) {
        return client.send({ type: "error", request_id: requestId, message: `${String(msg.type)} is not available to another Mac` });
      }
      const entry = frameEntry(msg.type);
      const route = deps.route;
      const redirect = client.peerId && route && entry?.kind === "request" ? route.redirect(msg) : null;
      if (redirect) return client.send({ type: "error", request_id: requestId, ...redirect });
      if (client.peerId || !route || !entry || entry.kind === "push" || typeof entry.parse(msg) === "string") return here(client, msg);
      const kind = entry.kind;
      const forward = (home: NonNullable<Target>) =>
        void route.forward(home, msg, kind).then(
          (out) => {
            if (!out.ok) return client.send({ type: "error", ...(kind === "request" ? { request_id: requestId } : {}), message: out.message });
            if (kind === "request" && out.reply) client.send({ ...out.reply, request_id: requestId });
          },
          (err: unknown) => client.send({ type: "error", ...(kind === "request" ? { request_id: requestId } : {}), message: errorMessage(err) }),
        );
      const home = route.target(msg);
      if (!(home instanceof Promise)) return home ? forward(home) : here(client, msg);
      void home.then(
        (h) => (h ? forward(h) : here(client, msg)),
        () => here(client, msg),
      );
    },
  };

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
