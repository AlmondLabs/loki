export const LINK_CLOSED = "the link to loki closed before it answered";

interface Waiting<S> {
  answer: (msg: Record<string, unknown>) => void;
  socket: S | null;
  unsent: object | null;
}

export class RequestWaiters<S> {
  private readonly waiting = new Map<string, Waiting<S>>();

  wait(id: string, answer: (msg: Record<string, unknown>) => void): void {
    this.waiting.set(id, { answer, socket: null, unsent: null });
  }

  sent(id: string, socket: S): void {
    const w = this.waiting.get(id);
    if (!w) return;
    w.socket = socket;
    w.unsent = null;
  }

  hold(id: string, frame: object): void {
    const w = this.waiting.get(id);
    if (w) w.unsent = frame;
  }

  flush(socket: S, send: (frame: object) => void): void {
    for (const [id, w] of this.waiting) {
      if (!w.unsent) continue;
      send(w.unsent);
      this.sent(id, socket);
    }
  }

  drop(id: string): void {
    this.waiting.delete(id);
  }

  answer(id: string, msg: Record<string, unknown>): boolean {
    const w = this.waiting.get(id);
    if (!w) return false;
    this.waiting.delete(id);
    w.answer(msg);
    return true;
  }

  closed(socket: S): void {
    const lost = [...this.waiting].filter(([, w]) => w.socket === socket).map(([id]) => id);
    for (const id of lost) this.answer(id, { type: "error", request_id: id, message: LINK_CLOSED });
  }
}
