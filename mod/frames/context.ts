import type { Scope } from "../../core/desk-core.ts";
import type { PayloadOf, PushFrame, ReplyOf, RequestName, SendName } from "../../core/frames.ts";
import type { Client } from "../server.ts";
import { messageOf } from "../../core/errors.ts";

export interface FrameContext {
  client: Client;
  push(frame: PushFrame): void;
  broadcast(frame: PushFrame, scope?: Scope): void;
  track(event: string, properties?: Record<string, unknown>): void;
}

export type Outcome<R> = { ok: true; reply: R } | { ok: false; message: string };
export const reply = <R>(r: R): Outcome<R> => ({ ok: true, reply: r });
export const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });
export const errorMessage = (err: unknown): string => messageOf(err);

type Maybe<T> = T | Promise<T>;
export type RequestHandler<N extends RequestName> = (payload: PayloadOf<N>, ctx: FrameContext) => Maybe<Outcome<ReplyOf<N>>>;
export type SendHandler<N extends SendName> = (payload: PayloadOf<N>, ctx: FrameContext) => Maybe<void>;

export type FrameHandlers = { [N in RequestName]?: RequestHandler<N> } & { [N in SendName]?: SendHandler<N> };
