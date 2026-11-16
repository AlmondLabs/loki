import { useEffect, useState } from "react";
import type { OutsideSeed } from "../../../core/frame-types.ts";
import { useOutsideReply } from "../shared/outside-replies";
import { freshSeeds, withSeeds } from "./outside-words";

export function useSeededReply(seeds: readonly OutsideSeed[] | undefined, keep: string | null, held: boolean): [string, (text: string) => void] {
  const [localText, setLocalText] = useState("");
  const [keptText, setKeptText] = useOutsideReply(keep);
  const [seeded, setSeeded] = useState<readonly string[]>([]);
  const [seededText, setSeededText] = useState<string | null>(null);
  const ownText = seededText ?? (keep ? keptText : localText);
  const setOwnText = (next: string) => {
    setSeededText(null);
    (keep ? setKeptText : setLocalText)(next);
  };
  const fresh = held ? [] : freshSeeds(seeds, seeded);
  if (fresh.length > 0) {
    setSeeded([...seeded, ...fresh.map((s) => s.id)]);
    const missing = fresh.filter((s) => !ownText.includes(s.text));
    if (missing.length > 0) setSeededText(withSeeds(ownText, missing));
  }
  useEffect(() => {
    if (keep && seededText !== null) setKeptText(seededText);
  }, [keep, seededText, setKeptText]);
  return [ownText, setOwnText];
}
