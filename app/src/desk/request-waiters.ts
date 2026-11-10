/** What a request is answered with when the socket it went out on closes first, in the shape of the mod's own `error`. */
export const LINK_CLOSED = "the link to loki closed before it answered";

/** One request waiting: how to answer it, and the socket it went out on, or null while it waits to be sent. */
interface Waiting<S> {
  answer: (msg: Record<string, unknown>) => void;
  socket: S | null;
}

/**
 * The requests a tab has asked the mod and not yet heard back on, by request_id. An answer comes back on the socket its
 * request went out on and no other, so when that socket closes (a drop, or the switch to another chat, which opens a
 * socket of its own) every request sent on it is answered with an error at once. Left waiting, each would sit out its
 * whole timeout, up to minutes, for an answer that can no longer come. A request not yet sent stays: it goes out on
 * the next socket.
 */
export class RequestWaiters<S> {
  private readonly waiting = new Map<string, Waiting<S>>();

  /** Wait for the answer to `id`; `answer` is called once with the frame that carries it. */
  wait(id: string, answer: (msg: Record<string, unknown>) => void): void {
    this.waiting.set(id, { answer, socket: null });
  }

  /** The request went out on `socket`. */
  sent(id: string, socket: S): void {
    const w = this.waiting.get(id);
    if (w) w.socket = socket;
  }

  /** Stop waiting for `id`: it was answered, or its time ran out. */
  drop(id: string): void {
    this.waiting.delete(id);
  }

  /** A frame with a request_id arrived: hand it to whoever asked. False when no one waits for it any more. */
  answer(id: string, msg: Record<string, unknown>): boolean {
    const w = this.waiting.get(id);
    if (!w) return false;
    this.waiting.delete(id);
    w.answer(msg);
    return true;
  }

  /** `socket` closed: every request that went out on it is answered with an error now. */
  closed(socket: S): void {
    const lost = [...this.waiting].filter(([, w]) => w.socket === socket).map(([id]) => id);
    for (const id of lost) this.answer(id, { type: "error", request_id: id, message: LINK_CLOSED });
  }
}
