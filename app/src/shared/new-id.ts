/**
 * A random id for something this tab starts (a held mail reply): 32 hex characters. `crypto.randomUUID` exists only on
 * a page served over https or from this machine, and a paired phone reaches loki over plain http on the Wi-Fi or the
 * tailnet, where calling it throws; `getRandomValues` is there on every page.
 */
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
