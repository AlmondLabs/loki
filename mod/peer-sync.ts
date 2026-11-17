import type { PushName, Pushes } from "../core/frames.ts";

export type PeerPush<K extends PushName> = { type: K } & Pushes[K];

export interface PeerSyncer {
  name: string;
  after?: string;
  reached?: (macId: string) => unknown;
  pushes?: { [K in PushName]?: (macId: string, frame: PeerPush<K>) => unknown };
}

export class PeerSync {
  private readonly syncers: PeerSyncer[];
  private readonly report: (syncer: string, macId: string, err: unknown) => void;

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

  reached(macId: string): Promise<void> {
    return this.run(macId, (s) => (s.reached ? () => s.reached?.(macId) : null));
  }

  heard(macId: string, frame: Record<string, unknown>): Promise<void> {
    if (typeof frame.type !== "string") return Promise.resolve();
    const type = frame.type as PushName;
    return this.run(macId, (s) => {
      const handle = s.pushes?.[type] as ((macId: string, frame: unknown) => unknown) | undefined;
      return handle ? () => handle(macId, frame) : null;
    });
  }

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
