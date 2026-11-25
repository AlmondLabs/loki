import { watch } from "node:fs";

interface Watcher {
  close: () => void;
}

export interface PageReloadHost {
  watch: (dir: string, listener: (event: string, name: string | null) => void) => Watcher;
  later: (fn: () => void) => () => void;
}

const SETTLE_MS = 300;

const host: PageReloadHost = {
  watch: (dir, listener) => watch(dir, (event, name) => listener(event, name)),
  later: (fn) => {
    const timer = setTimeout(fn, SETTLE_MS);
    return () => clearTimeout(timer);
  },
};

export function watchPageBuild(dir: string, entry: string, reload: () => void, h: PageReloadHost = host): () => void {
  let cancel: (() => void) | null = null;
  const watcher = h.watch(dir, (_event, name) => {
    if (name !== entry) return;
    cancel?.();
    cancel = h.later(() => {
      cancel = null;
      reload();
    });
  });
  return () => {
    cancel?.();
    watcher.close();
  };
}
