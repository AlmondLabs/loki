/** Plain frame data (maps, lists, strings, numbers) compared by content. */
function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a),
    kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameData((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** `next`, unless it holds what `prev` holds: then `prev`, so a repeated frame changes no reference. Plain data only: a Map or Set compares as empty. */
export function keepSame<T>(prev: T, next: T): T {
  return sameData(prev, next) ? prev : next;
}
