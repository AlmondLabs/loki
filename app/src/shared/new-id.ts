// Outside (HTML): `crypto.randomUUID` exists only on a page served over https or from this machine, and a paired phone
// reaches loki over plain http, where it throws; `getRandomValues` is there on every page.
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
