import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { transform } from "esbuild";
import { messageOf } from "../../../core/errors.ts";
import { rewriteSharedImports } from "./rewrite.ts";

/**
 * A module widget's code as the frame runs it: `<rel>.js` names the widget's `.tsx` or `.jsx` under `widgetsDir`,
 * compiled with React's automatic runtime, its shared imports read from the frame's table. A widget that does not
 * compile becomes a module that throws its file and message; a path that leaves the folder, or names no widget, is null.
 */
export async function widgetModule(widgetsDir: string, rel: string): Promise<string | null> {
  if (rel.includes("..") || rel.startsWith("/") || rel.includes("\\") || rel.includes(":") || !rel.endsWith(".js")) return null;
  const stem = rel.slice(0, -3);
  for (const ext of ["tsx", "jsx"] as const) {
    const file = join(widgetsDir, `${stem}.${ext}`);
    if (!existsSync(file)) continue;
    try {
      const out = await transform(readFileSync(file, "utf8"), { loader: ext, jsx: "automatic", format: "esm", target: "es2022", sourcefile: file });
      return rewriteSharedImports(out.code);
    } catch (err) {
      return `throw new Error(${JSON.stringify(`${file}: ${messageOf(err)}`)});`;
    }
  }
  return null;
}
