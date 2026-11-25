export const PARENT_CHECK_MS = 2000;

type Signal = (pid: number, signal: 0) => true;

export function alive(pid: number, signal: Signal = (p, s) => process.kill(p, s)): boolean {
  try {
    return signal(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const everyInterval = (fn: () => void): (() => void) => {
  const timer = setInterval(fn, PARENT_CHECK_MS);
  timer.unref();
  return () => clearInterval(timer);
};

export function watchParent(opts: { pid: number; gone: () => void; alive?: (pid: number) => boolean; every?: (fn: () => void) => () => void }): () => void {
  const isAlive = opts.alive ?? ((pid: number) => alive(pid));
  let done = false;
  const stop = (opts.every ?? everyInterval)(() => {
    if (done || isAlive(opts.pid)) return;
    done = true;
    stop();
    opts.gone();
  });
  return () => {
    done = true;
    stop();
  };
}
