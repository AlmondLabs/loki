export interface Burst {
  schedule(): void;
  flush(): void;
  cancel(): void;
}

export interface BurstOptions {
  unref?: boolean;
}

export function coalesce(fn: () => void, ms: number, opts: BurstOptions = {}): Burst {
  return burst(fn, ms, false, opts);
}

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
