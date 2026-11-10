import { useEffect, useState } from "react";
import type { OutsideSeed } from "../../../core/frame-types.ts";
import { useOutsideReply } from "../shared/outside-replies";
import { freshSeeds, withSeeds } from "./outside-words";

/**
 * The text of a reply box that keeps its own, with the Jira comments the person approved for the agent added to it
 * once, after what is there (KTD18). The phone's box keeps its text in React; with `keep` it outlives the box. A box the
 * deck holds (`held`) takes in nothing here, since the deck adds the comments to its own text.
 *
 * Each comment is taken in by its proposal id, so it is added once even after the person edits it away, and the text it
 * made stands until the person next edits it. It is taken in as the box renders, the way React adjusts state to new
 * props, so the box shows it from its first paint; one whose words the text already holds was taken in before the box
 * last left the screen.
 */
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
  // Kept text lives in a store outside React, which learns the comments once the box is on screen.
  useEffect(() => {
    if (keep && seededText !== null) setKeptText(seededText);
  }, [keep, seededText, setKeptText]);
  return [ownText, setOwnText];
}
