import { useEffect, useState } from "react";

/**
 * The clock, as state: a component that shows "due in 3 min" or "ran 2 h ago" reads this instead of calling
 * Date.now() while rendering. Render stays pure (the compiler may memoise it, and a label that read the clock
 * directly would then freeze), and the label refreshes itself every `everyMs`.
 */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
