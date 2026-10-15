/**
 * The value a test is sure is there, or a failure that says what was missing: the test suite's stand-in for `x!`,
 * which docs/STYLE.md §3 rules out. `must(tools.get("loki_task"), "the loki_task tool")` reads as the expectation it is.
 */
export function must<T>(value: T | null | undefined, what = "a value"): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}, got ${String(value)}`);
  return value;
}
