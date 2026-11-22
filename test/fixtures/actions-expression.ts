export type Value = string | number | boolean | null;
export type Context = Record<string, Value>;

const TOKEN = /\s*(\(|\)|==|!=|&&|\|\||!|'(?:[^']|'')*'|[A-Za-z_][\w.-]*|\d+)/y;

function tokenize(expr: string): string[] {
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < expr.trimEnd().length) {
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(expr);
    if (!m?.[1]) throw new Error(`cannot read the expression at ${at}: ${expr}`);
    tokens.push(m[1]);
  }
  return tokens;
}

const truthy = (v: Value): boolean => v !== false && v !== 0 && v !== "" && v !== null;
const equalIgnoringCase = (a: Value, b: Value): boolean => (typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b);

export function evaluate(expr: string, context: Context): Value {
  const tokens = tokenize(expr);
  let i = 0;
  const peek = () => tokens[i];
  const next = () => {
    if (i >= tokens.length) throw new Error(`the expression ends early: ${expr}`);
    return tokens[i++];
  };
  const or = (): Value => {
    let v = and();
    while (peek() === "||") {
      next();
      const r = and();
      v = truthy(v) ? v : r;
    }
    return v;
  };
  const and = (): Value => {
    let v = eq();
    while (peek() === "&&") {
      next();
      const r = eq();
      v = truthy(v) ? r : v;
    }
    return v;
  };
  const eq = (): Value => {
    let v = unary();
    while (peek() === "==" || peek() === "!=") {
      const op = next();
      const r = unary();
      v = op === "==" ? equalIgnoringCase(v, r) : !equalIgnoringCase(v, r);
    }
    return v;
  };
  const unary = (): Value => {
    if (peek() === "!") {
      next();
      return !truthy(unary());
    }
    return primary();
  };
  const primary = (): Value => {
    const t = next();
    if (t === "(") {
      const v = or();
      if (next() !== ")") throw new Error(`a parenthesis is not closed: ${expr}`);
      return v;
    }
    if (t.startsWith("'")) return t.slice(1, -1).replaceAll("''", "'");
    if (/^\d+$/.test(t)) return Number(t);
    if (t === "true" || t === "false") return t === "true";
    if (t === "null") return null;
    if (!(t in context)) throw new Error(`the context has no ${t} (in ${expr})`);
    return context[t] ?? null;
  };
  const v = or();
  if (i !== tokens.length) throw new Error(`the expression goes on after its end: ${expr}`);
  return v;
}

const WRAPPED = /\$\{\{([\s\S]*?)\}\}/g;

// Outside (GitHub Actions): one expression filling a whole field gives its value, as for `cancel-in-progress`;
// expressions inside other text are written into it, as for a concurrency group.
export function field(text: unknown, context: Context): Value {
  if (typeof text === "boolean" || typeof text === "number" || text === null) return text;
  if (typeof text !== "string") throw new Error(`not a workflow field: ${JSON.stringify(text)}`);
  const whole = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(text);
  if (whole?.[1] !== undefined && !whole[1].includes("}}")) return evaluate(whole[1], context);
  return text.replace(WRAPPED, (_, e: string) => String(evaluate(e, context)));
}

// Outside (GitHub Actions): an `if:` may leave out the `${{ }}` around its expression.
export function holds(condition: string | undefined, context: Context): boolean {
  if (condition === undefined) return true;
  const whole = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(condition);
  return truthy(evaluate(whole?.[1] ?? condition, context));
}
