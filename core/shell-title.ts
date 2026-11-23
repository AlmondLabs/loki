interface Span {
  start: number;
  end: number;
}

const splitTop = (text: string, from: number, to: number, breakAt: (i: number) => number): Span[] => {
  const spans: Span[] = [];
  let start = from;
  let quote = "";
  let depth = 0;
  const close = (end: number) => {
    let a = start;
    let b = end;
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    if (b > a) spans.push({ start: a, end: b });
  };
  for (let i = from; i < to; i++) {
    const c = text[i];
    if (c === "\\" && quote !== "'") i++;
    else if (quote) quote = c === quote ? "" : quote;
    else if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      const size = breakAt(i);
      if (size) {
        close(i);
        start = i + size;
        i += size - 1;
      }
    }
  }
  close(to);
  return spans;
};

interface Clause extends Span {
  words: string[];
  wordSpans: Span[];
}

const clausesOf = (command: string): Clause[] =>
  splitTop(command, 0, command.length, (i) => (command.startsWith("&&", i) ? 2 : command[i] === ";" ? 1 : 0)).map((span) => {
    const wordSpans = splitTop(command, span.start, span.end, (i) => (/\s/.test(command[i]) ? 1 : 0));
    return { ...span, wordSpans, words: wordSpans.map((w) => command.slice(w.start, w.end)) };
  });

const isAssignment = (word: string) => /^[A-Za-z_]\w*=/.test(word);

const setupWords = (words: string[]): number => {
  let i = 0;
  if (words[0] === "env") {
    i = 1;
    if (words[1] === "-i") i = 2;
  }
  while (i < words.length && isAssignment(words[i])) i++;
  return i;
};

const DUP = /^(?:\d|&)?>&(?:\d+|-)$/;
const TO_FILE = /^(?:\d|&)?>>?(.*)$/;

const redirectsOf = (words: string[]): { from: number; files: string[] } => {
  const files: string[] = [];
  let from = words.length;
  while (from > 1) {
    const last = words[from - 1];
    if (DUP.test(last)) {
      from -= 1;
      continue;
    }
    const attached = TO_FILE.exec(last)?.[1];
    if (attached) {
      files.push(attached);
      from -= 1;
      continue;
    }
    if (from > 2 && TO_FILE.exec(words[from - 2])?.[1] === "") {
      files.push(last);
      from -= 2;
      continue;
    }
    break;
  }
  return { from, files };
};

const readsBack = (clause: Clause) => (clause.words[0] === "tail" || clause.words[0] === "cat" ? clause.words.slice(1).filter((w) => !w.startsWith("-")) : []);

export function shellTitle(command: string): string {
  const clauses = clausesOf(command);
  const readBack = new Set(clauses.flatMap(readsBack));
  const written = new Set(clauses.flatMap((c) => redirectsOf(c.words).files));
  const isTrailer = (c: Clause) =>
    c.words[0] === "exit" ||
    c.words[0] === "tail" ||
    (c.words.length === 1 && /^[A-Za-z_]\w*=\$\?$/.test(c.words[0])) ||
    (c.words[0] === "cat" && readsBack(c).length > 0 && readsBack(c).every((f) => written.has(f)));

  let first = 0;
  let last = clauses.length - 1;
  while (first < last && (clauses[first].words[0] === "cd" || setupWords(clauses[first].words) === clauses[first].words.length)) first++;
  while (last > first && isTrailer(clauses[last])) last--;
  if (first > last) return command;

  const head = clauses[first];
  const skip = setupWords(head.words);
  const start = skip < head.words.length ? head.wordSpans[skip].start : head.start;

  const tail = clauses[last];
  const redirects = redirectsOf(tail.words);
  const dropRedirects = redirects.files.length > 0 && redirects.files.every((f) => f === "/dev/null" || readBack.has(f));
  const kept = dropRedirects && (first < last || redirects.from > skip) ? redirects.from : tail.words.length;
  const end = tail.wordSpans[kept - 1].end;

  const title = command.slice(start, end).trim();
  return title || command;
}
