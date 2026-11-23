import { useEffect, useState } from "react";

// Outside (React Compiler): a label that read Date.now() while rendering would freeze once the compiler memoised it,
// so the clock is state that refreshes every `everyMs`.
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
