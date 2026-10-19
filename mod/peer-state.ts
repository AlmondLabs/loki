import type { LabelColorsSnapshot } from "../daemon/labels.ts";
import type { PeerLink } from "./peer-link.ts";
import type { PinChange } from "./pins.ts";
import type { RecallSnapshot } from "./recall-sync.ts";
import type { MarksSnapshot } from "./seen.ts";
import type { McpSnapshot } from "../daemon/config-sync.ts";
import { log } from "./log.ts";

/**
 * The person's own state the same on every paired Mac (plan 023, U8, KTD9, R19): the Inbox's marks and focus, pins,
 * label colours and Learn. A Mac sends all of it when asked (`peer_state_get`); when something of it changes here,
 * paired Macs are told (`state_changed`, a moment later, once per burst) and ask. Each part merges by its own rule,
 * so asking again after nothing changed changes nothing.
 */

/** Everything of the person's a Mac sends another. */
export interface PersonState {
  marks: MarksSnapshot;
  pins: Record<string, PinChange>;
  labels: LabelColorsSnapshot;
  learn: RecallSnapshot;
  /** loki's own config (U10): its MCP servers and its mods. */
  mcp: McpSnapshot;
  mods: RecallSnapshot;
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
    snapshot: () => PersonState;
    apply: (macId: string, theirs: PersonState) => StateMoved;
    link: (macId: string) => PeerLink | null;
    /** Tell paired Macs this Mac's state changed. */
    tell: () => void;
    debounceMs?: number;
  };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: PeerState["opts"]) {
    this.opts = opts;
  }

  /** This Mac's state, for a paired Mac's `peer_state_get`. */
  snapshotNow(): PersonState {
    return this.opts.snapshot();
  }

  /** Something of the person's changed here: tell paired Macs once the burst settles. */
  changed(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.opts.tell();
    }, this.opts.debounceMs ?? 800);
    this.timer.unref();
  }

  /** Ask a Mac for its state and take it, one Mac at a time. */
  pull(macId: string): Promise<StateMoved | null> {
    const run = this.queue.then(async () => {
      const link = this.opts.link(macId);
      if (!link) return null;
      let reply: Record<string, unknown>;
      try {
        reply = await link.request({ type: "peer_state_get" }, 30_000);
      } catch {
        return null;
      }
      const theirs = reply as Partial<PersonState>;
      if (!theirs.marks || !theirs.pins || !theirs.labels || !theirs.learn || !theirs.mcp || !theirs.mods) return null;
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
    this.queue = run.catch(() => undefined);
    return run;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
