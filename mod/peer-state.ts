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

/**
 * The person's own state the same on every paired Mac (plan 023, U8, KTD9, R19): the Inbox's marks and focus, pins,
 * label colours and Learn. A Mac sends it when asked (`peer_state_get`); when something of it changes here, paired
 * Macs are told (`state_changed`, a moment later, once per burst) and ask. Each part merges by its own rule, so asking
 * again after nothing changed changes nothing.
 *
 * The small parts always travel; Learn's and the mods' files (STATE_FOLDERS) only when the burst named them, or when
 * the asking Mac wants everything: on reaching a Mac, every few minutes, and on a loki from before plan 040.
 */

/** What of the person's a Mac sends another: the folders' files only when they were asked for. */
export interface PersonState {
  marks: MarksSnapshot;
  pins: Record<string, PinChange>;
  labels: LabelColorsSnapshot;
  learn?: RecallSnapshot;
  /** loki's own config (U10): its MCP servers and its mods. */
  mcp: McpSnapshot;
  mods?: RecallSnapshot;
}

/** Which parts moved when a paired Mac's state was taken. */
export interface StateMoved {
  marks: boolean;
  pins: boolean;
  labels: boolean;
  learn: boolean;
  mcp: boolean;
  mods: boolean;
}

/** Pulls and applies the person's state between this Mac and its paired Macs. */
export class PeerState {
  private readonly opts: {
    /** The small parts and the folders named. */
    snapshot: (folders: readonly StateFolder[]) => PersonState;
    /** Take the parts that came; a folder not sent is left as it is. */
    apply: (macId: string, theirs: PersonState) => StateMoved;
    link: (macId: string) => PeerLink | null;
    /** Tell paired Macs this Mac's state changed, and which folders with it. */
    tell: (folders: StateFolder[]) => void;
    debounceMs?: number;
  };
  /** The folders changed in the burst being told. */
  private folders = new Set<StateFolder>();
  /** Paired Macs told once per burst of changes. */
  private readonly telling: Burst;
  /** Pulls run one at a time, one Mac after another. */
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

  /** This Mac's state, for a paired Mac's `peer_state_get`: every folder unless it named some. */
  snapshotNow(folders: readonly StateFolder[] = STATE_FOLDERS): PersonState {
    return this.opts.snapshot(folders);
  }

  /** Something of the person's changed here, a folder's files too when named: tell paired Macs once the burst settles. */
  changed(folder?: StateFolder): void {
    if (folder) this.folders.add(folder);
    this.telling.schedule();
  }

  /** Ask a Mac for its state with the folders named (every one when `folders` is left out), and take it, one Mac at a time. */
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
