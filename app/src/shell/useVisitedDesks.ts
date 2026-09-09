import { useEffect, useState } from "react";

const VISITED_KEY = "loki.visited";

/**
 * Desk scopes in visit order, most recent first: the switcher's "recent" and its starting row. Kept for
 * the window in sessionStorage, capped at fifty; the current desk moves to the head whenever it changes.
 */
export function useVisitedDesks(scope: string): string[] {
  const [visited, setVisited] = useState<string[]>(() => {
    try {
      const v = JSON.parse(sessionStorage.getItem(VISITED_KEY) ?? "[]") as unknown;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 50) : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    setVisited((v) => [scope, ...v.filter((sc) => sc !== scope)].slice(0, 50));
  }, [scope]);
  useEffect(() => {
    sessionStorage.setItem(VISITED_KEY, JSON.stringify(visited));
  }, [visited]);
  return visited;
}
