import { relative, sep } from "node:path";

export const OUTSIDE = [
  "ACP",
  "Android",
  "Base UI",
  "bash",
  "Bun",
  "Chrome",
  "Claude Code",
  "CSS",
  "DuckDuckGo",
  "Electron",
  "esbuild",
  "git",
  "GitHub",
  "GitHub Actions",
  "Gmail",
  "Google",
  "Homebrew",
  "HTML",
  "iOS",
  "Jira",
  "Letta",
  "libsodium",
  "linuxdeploy",
  "macOS",
  "MCP",
  "Node",
  "npm",
  "oxlint",
  "pi-ai",
  "pi-codemode",
  "pi-durable",
  "React",
  "React Compiler",
  "React Scan",
  "Safari",
  "shadcn",
  "Slack",
  "SQLite",
  "Tailscale",
  "Tailwind",
  "Tauri",
  "tsgolint",
  "TypeScript",
  "Vite",
  "vitest",
  "WebKit",
  "Windows",
  "zsh",
];

const MARKER = /^Outside \(([^)]+)\): \S/;
export const LINK = /https?:\/\//;
const LICENCE = /licen[cs]e|copyright|spdx-license-identifier/i;
const DOC_AREAS = /^(core|daemon|desktop|mod|app\/src)\//;
const OXLINT_DIRECTIVE = /^\s*oxlint-(disable|enable)/;
const REASON = /\s--\s+\S/;
const LONE_DIRECTIVES = [/^\s*react-doctor-(disable|enable)/, /^\s*@ts-expect-error\b/, /^\s*prettier-ignore\s*$/, /^\s*@vite-ignore\s*$/];

export const isDirective = (text) => OXLINT_DIRECTIVE.test(text) || LONE_DIRECTIVES.some((d) => d.test(text));

export function markerVerdict(firstLine) {
  const marker = MARKER.exec(firstLine.trimStart());
  if (!marker) return "none";
  return OUTSIDE.includes(marker[1]) ? "listed" : marker[1];
}

function groupsOf(comments, ownLine) {
  const groups = [];
  for (const comment of comments) {
    const last = groups.at(-1)?.at(-1);
    const joins =
      last &&
      ownLine(last) &&
      ownLine(comment) &&
      last.type === "Line" &&
      comment.type === "Line" &&
      comment.loc.start.line === last.loc.end.line + 1 &&
      !isDirective(last.value) &&
      !isDirective(comment.value);
    if (joins) groups.at(-1).push(comment);
    else groups.push([comment]);
  }
  return groups;
}

export const commentsRule = {
  meta: {
    type: "suggestion",
    schema: [],
    messages: {
      comment:
        "Say this with a name, an extracted function or a type instead (docs/style.md §5). A comment stays only as `Outside (<what>): …` for a constraint from outside loki, a link, an `oxlint-disable … -- reason`, `prettier-ignore`, `@vite-ignore`, `@ts-expect-error`, a react-doctor directive, a licence header, or a `/** */` doc comment in core/, daemon/, desktop/, mod/ or app/src/.",
      unlisted: "`{{name}}` is not on the list of outside things in eslint-comments.mjs: use a listed name, or add this one to the list in review.",
      reason: "An oxlint-disable gives its reason after ` -- ` (docs/style.md §5).",
    },
  },
  create(context) {
    const source = context.sourceCode;
    const path = relative(context.cwd, context.filename).split(sep).join("/");
    const firstToken = source.ast.tokens[0];
    const firstCode = firstToken ? firstToken.range[0] : Infinity;
    return {
      Program() {
        const ownLine = (comment) => source.lines[comment.loc.start.line - 1].slice(0, comment.loc.start.column).trim() === "";
        for (const group of groupsOf(source.getAllComments(), ownLine)) {
          const [first] = group;
          const text = group.map((c) => c.value).join("\n");
          if (OXLINT_DIRECTIVE.test(first.value)) {
            if (!REASON.test(first.value)) context.report({ loc: first.loc, messageId: "reason" });
            continue;
          }
          if (LONE_DIRECTIVES.some((d) => d.test(first.value))) continue;
          if (first.type === "Block" && first.value.startsWith("*") && DOC_AREAS.test(path)) continue;
          if (LINK.test(text)) continue;
          if (group.at(-1).range[1] <= firstCode && LICENCE.test(text)) continue;
          const marker = markerVerdict(first.value);
          if (marker === "listed") continue;
          const loc = { start: first.loc.start, end: group.at(-1).loc.end };
          if (marker === "none") context.report({ loc, messageId: "comment" });
          else context.report({ loc, messageId: "unlisted", data: { name: marker } });
        }
      },
    };
  },
};

export const plugin = { rules: { comments: commentsRule } };
