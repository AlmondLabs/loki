/**
 * The one way loki turns a burst of calls into one run (plan 054). Two kinds, by what the burst should wait for:
 *  - coalesce: the first call starts the clock and later ones join it, so a steady stream still runs every `ms`
 *    (a streamed reply redrawn, marks written, paired Macs told);
 *  - debounce: each call starts the clock again, so it runs once the stream has gone quiet (a folder still being
 *    written to, a title still settling). Per desk, mod/lifecycle-events.ts's ScopeDebouncer is built on it.
 */

/** A pending run: `schedule` asks for it, `flush` runs it now if one is waiting, `cancel` drops it. */
export interface Burst {
  schedule(): void;
  flush(): void;
  cancel(): void;
}

/** Options for both kinds. */
export interface BurstOptions {
  /** In Node, let the process exit while a run waits (a daemon's timers must not hold it open). */
  unref?: boolean;
}

/** Run `fn` once, `ms` after the first of a burst of calls. */
export function coalesce(fn: () => void, ms: number, opts: BurstOptions = {}): Burst {
  return burst(fn, ms, false, opts);
}

/** Run `fn` once, `ms` after the last of a burst of calls. */
export function debounce(fn: () => void, ms: number, opts: BurstOptions = {}): Burst {
  return burst(fn, ms, true, opts);
}

function burst(fn: () => void, ms: number, restart: boolean, opts: BurstOptions): Burst {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    timer = null;
    fn();
  };
  return {
    schedule() {
      if (timer && !restart) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(fire, ms);
      if (opts.unref) unref(timer);
    },
    flush() {
      if (!timer) return;
      clearTimeout(timer);
      fire();
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/** Node's timers can be let go; a browser's are numbers, with nothing to let go. */
function unref(timer: unknown): void {
  if (lettable(timer)) timer.unref();
}

const lettable = (t: unknown): t is { unref: () => void } => typeof t === "object" && t !== null && "unref" in t && typeof t.unref === "function";
