export const SHARED_SPECIFIERS = ["react", "react/jsx-runtime", "react-dom", "recharts", "@loki/kit"] as const;

export function rewriteSharedImports(code: string): string {
  return code
    .split("\n")
    .map((line) => rewriteImportLine(line.trimStart()) ?? line)
    .join("\n");
}

function rewriteImportLine(line: string): string | null {
  if (!line.startsWith("import ")) return null;
  const from = line.lastIndexOf(" from ");
  if (from < 0) return null;
  const spec = line
    .slice(from + 6)
    .trim()
    .replace(/;$/, "")
    .replace(/^["']|["']$/g, "");
  if (!(SHARED_SPECIFIERS as readonly string[]).includes(spec)) return null;
  const clause = line.slice(7, from).trim();
  const table = `window.__lokiShared[${JSON.stringify(spec)}]`;
  if (clause.startsWith("* as ")) return `const ${clause.slice(5).trim()} = ${table};`;
  const stmts: string[] = [];
  let rest = clause;
  const brace = rest.indexOf("{");
  if (brace >= 0) {
    const close = rest.lastIndexOf("}");
    if (close < brace) return null;
    const defaultPart = rest.slice(0, brace).trim().replace(/,$/, "").trim();
    if (defaultPart) stmts.push(`const ${defaultPart} = ${table}.default ?? ${table};`);
    const bindings = rest
      .slice(brace + 1, close)
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean)
      .map((n) => {
        const [a, b] = n.split(/\s+as\s+/);
        return b ? `${a.trim()}: ${b.trim()}` : n;
      });
    if (bindings.length) stmts.push(`const { ${bindings.join(", ")} } = ${table};`);
    rest = "";
  }
  if (rest) stmts.push(`const ${rest.trim()} = ${table}.default ?? ${table};`);
  return stmts.join(" ");
}
