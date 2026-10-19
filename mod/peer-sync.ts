import type { PushName, Pushes } from "../core/frames.ts";

/**
 * What keeps this Mac current with the paired ones (plan 023): each syncer says what wakes it, a paired Mac coming
 * into reach or one of that Mac's pushes, and which syncer it waits for. The links (mod/peer-link.ts) hand every
 * status and push here; nothing else knows the triggers or their order. Agents come before their memory, and their
 * memory before the chats that move with them; syncers that wait for none run side by side.
 *
 * A syncer runs once the one it waits for has settled, whether that one succeeded or not: what it failed to bring is
 * brought at the next contact or push. A failure is reported and stops no other syncer.
 */

/**
 * A push from a paired Mac, as the frame table describes it. Another Mac's pushes reach here unparsed, so a handler
 * checks the fields it reads.
 */
export type PeerPush<K extends PushName> = { type: K } & Pushes[K];

/** One syncer: its name, the one it waits for, and what it does when a Mac comes into reach or sends a push. */
export interface PeerSyncer {
  name: string;
  /** The syncer this one runs after, on reach and on a push both handle; it must come earlier in the list. */
  after?: string;
  /** A paired Mac came into reach: take what changed there while it was not. */
  reached?: (macId: string) => unknown;
  /** The pushes from a paired Mac that wake it, by name. */
  pushes?: { [K in PushName]?: (macId: string, frame: PeerPush<K>) => unknown };
}

/** The syncers between this Mac and the paired ones, run in their declared order. */
export class PeerSync {
  private readonly syncers: PeerSyncer[];
  private readonly report: (syncer: string, macId: string, err: unknown) => void;

  /** Throws when a syncer waits for one that is not earlier in the list, or two share a name. */
  constructor(syncers: PeerSyncer[], report: (syncer: string, macId: string, err: unknown) => void) {
    const seen = new Set<string>();
    for (const s of syncers) {
      if (seen.has(s.name)) throw new Error(`two syncers named ${s.name}`);
      if (s.after && !seen.has(s.after)) throw new Error(`${s.name} waits for ${s.after}, which does not come before it`);
      seen.add(s.name);
    }
    this.syncers = syncers;
    this.report = report;
  }

  /** A paired Mac came into reach: every syncer that takes what changed, in order. Resolves when all have settled. */
  reached(macId: string): Promise<void> {
    return this.run(macId, (s) => (s.reached ? () => s.reached?.(macId) : null));
  }

  /** A push from a paired Mac: the syncers it wakes, in order. Resolves when all have settled. */
  heard(macId: string, frame: Record<string, unknown>): Promise<void> {
    if (typeof frame.type !== "string") return Promise.resolve();
    const type = frame.type as PushName;
    return this.run(macId, (s) => {
      const handle = s.pushes?.[type] as ((macId: string, frame: unknown) => unknown) | undefined;
      return handle ? () => handle(macId, frame) : null;
    });
  }

  /** Run each syncer's step, once the step of the syncer it waits for has settled (or at once, when that one has none). */
  private async run(macId: string, step: (s: PeerSyncer) => (() => unknown) | null): Promise<void> {
    const settled = new Map<string, Promise<void>>();
    for (const s of this.syncers) {
      const work = step(s);
      if (!work) continue;
      const before = (s.after && settled.get(s.after)) || Promise.resolve();
      settled.set(
        s.name,
        before.then(work).then(
          () => undefined,
          (err: unknown) => this.report(s.name, macId, err),
        ),
      );
    }
    await Promise.all(settled.values());
  }
}
