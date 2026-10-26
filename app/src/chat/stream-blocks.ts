/** A fence line: three or more backticks or tildes, indented at most three spaces (CommonMark). */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * A reply still being written, cut into the blocks markdown would make of it (plan 039): at blank lines, never inside
 * a fenced code block, whether that block is closed yet or not. Every block but the last is finished, so the
 * transcript draws each on its own and parses only the last one again as words arrive.
 */
export function streamBlocks(text: string): string[] {
  const blocks: string[] = [];
  let lines: string[] = [];
  /** The open fence's character and length; a fence closes with the same character, at least as many. */
  let fence: { char: string; length: number } | null = null;
  for (const line of text.split("\n")) {
    const mark = FENCE.exec(line)?.[1];
    if (fence) {
      // A closing fence: the opening's character, at least as long, and nothing after it.
      const closes = mark?.startsWith(fence.char) && mark.length >= fence.length && !line.slice(line.indexOf(mark) + mark.length).trim();
      if (closes) fence = null;
    } else if (mark) fence = { char: mark[0], length: mark.length };
    else if (!line.trim()) {
      if (lines.length) blocks.push(lines.join("\n"));
      lines = [];
      continue;
    }
    lines.push(line);
  }
  if (lines.length) blocks.push(lines.join("\n"));
  return blocks;
}
