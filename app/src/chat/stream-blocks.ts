const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export interface StreamBlock {
  at: number;
  text: string;
}

export function streamBlocks(text: string): StreamBlock[] {
  const blocks: StreamBlock[] = [];
  let lines: string[] = [];
  let start = 0;
  let offset = 0;
  let fence: { char: string; length: number } | null = null;
  for (const line of text.split("\n")) {
    const at = offset;
    offset += line.length + 1;
    const mark = FENCE.exec(line)?.[1];
    if (fence) {
      const closes = mark?.startsWith(fence.char) && mark.length >= fence.length && !line.slice(line.indexOf(mark) + mark.length).trim();
      if (closes) fence = null;
    } else if (mark) fence = { char: mark[0], length: mark.length };
    else if (!line.trim()) {
      if (lines.length) blocks.push({ at: start, text: lines.join("\n") });
      lines = [];
      continue;
    }
    if (!lines.length) start = at;
    lines.push(line);
  }
  if (lines.length) blocks.push({ at: start, text: lines.join("\n") });
  return blocks;
}
