import type { LabelColorsSnapshot } from "../daemon/labels.ts";
import type { PeerLink } from "./peer-link.ts";
import type { PinChange } from "./pins.ts";
import type { RecallSnapshot } from "./recall-sync.ts";
import type { MarksSnapshot } from "./seen.ts";
import type { McpSnapshot } from "../daemon/config-sync.ts";
import { STATE_FOLDERS, type StateFolder } from "../core/frames.ts";
import { log } from "./log.ts";
import { serialQueue } from "../core/serial.ts";
import { coalesce, type Burst } from "../core/timers.ts";

export interface PersonState {
  marks: MarksSnapshot;
  pins: Record<string, PinChange>;
  labels: LabelColorsSnapshot;
  learn?: RecallSnapshot;
  mcp: McpSnapshot;
  mods?: RecallSnapshot;
}

export interface StateMoved {
  marks: boolean;
  pins: boolean;
  labels: boolean;
  learn: boolean;
  mcp: boolean;
  mods: boolean;
}

export class PeerState {
  private readonly opts: {
    snapshot: (folders: readonly StateFolder[]) => PersonState;
    apply: (macId: string, theirs: PersonState) => StateMoved;
    link: (macId: string) => PeerLink | null;
    tell: (folders: StateFolder[]) => void;
    debounceMs?: number;
  };
  private folders = new Set<StateFolder>();
  private readonly telling: Burst;
  private readonly serial = serialQueue();

  constructor(opts: PeerState["opts"]) {
    this.opts = opts;
    this.telling = coalesce(
      () => {
        const folders = [...this.folders];
        this.folders.clear();
        this.opts.tell(folders);
      },
      opts.debounceMs ?? 800,
      { unref: true },
    );
  }

  snapshotNow(folders: readonly StateFolder[] = STATE_FOLDERS): PersonState {
    return this.opts.snapshot(folders);
  }

  changed(folder?: StateFolder): void {
    if (folder) this.folders.add(folder);
    this.telling.schedule();
  }

  pull(macId: string, folders?: readonly StateFolder[]): Promise<StateMoved | null> {
    return this.serial(async () => {
      const link = this.opts.link(macId);
      if (!link) return null;
      let reply: Record<string, unknown>;
      try {
        reply = await link.request({ type: "peer_state_get", ...(folders ? { folders } : {}) }, 30_000);
      } catch {
        return null;
      }
      const theirs = reply as Partial<PersonState>;
      if (!theirs.marks || !theirs.pins || !theirs.labels || !theirs.mcp) return null;
      const moved = this.opts.apply(macId, {
        marks: theirs.marks,
        pins: theirs.pins,
        labels: theirs.labels,
        learn: theirs.learn,
        mcp: theirs.mcp,
        mods: theirs.mods,
      });
      if (Object.values(moved).some(Boolean)) log("peers:state", { from: macId, ...moved });
      return moved;
    });
  }

  stop(): void {
    this.telling.cancel();
  }
}
