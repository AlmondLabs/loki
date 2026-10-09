import type { Scope } from "../../core/desk-core.ts";
import type { PayloadOf, PushFrame, ReplyOf, RequestName, SendName } from "../../core/frames.ts";
import type { Client } from "../server.ts";

/**
 * What a frame handler (GLOSSARY.md) works with: the client the frame came from, the pushes it may send, and the
 * analytics it may record. The router (mod/bridge.ts) builds one per frame; handlers never send a request's reply
 * themselves, they return it.
 */
export interface FrameContext {
  client: Client;
  /** A push to the client that sent the frame. */
  push(frame: PushFrame): void;
  /** A push to every socket, or to the tabs on one desk. */
  broadcast(frame: PushFrame, scope?: Scope): void;
  /** An analytics event this frame caused (mod/analytics.ts). */
  track(event: string, properties?: Record<string, unknown>): void;
}

/** A request's answer: its reply, or why not. The router sends the reply under the table's name, or `error`. */
export type Outcome<R> = { ok: true; reply: R } | { ok: false; message: string };
export const reply = <R>(r: R): Outcome<R> => ({ ok: true, reply: r });
export const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });
export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

type Maybe<T> = T | Promise<T>;
export type RequestHandler<N extends RequestName> = (payload: PayloadOf<N>, ctx: FrameContext) => Maybe<Outcome<ReplyOf<N>>>;
export type SendHandler<N extends SendName> = (payload: PayloadOf<N>, ctx: FrameContext) => Maybe<void>;

/** One feature's handlers, by frame name: what a module under mod/frames/ exports. */
export type FrameHandlers = { [N in RequestName]?: RequestHandler<N> } & { [N in SendName]?: SendHandler<N> };
