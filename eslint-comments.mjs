const OXLINT_DISABLE = /^\s*oxlint-disable(?:-next-line|-line)?\b/;
const ESLINT_DIRECTIVE = /^\s*eslint-(?:disable|enable)\b/;
const REASON = /\s--\s+\S/;
const TODO_COMMENT = /\b(?:TODO|FIXME)\b/;
const COMMENTED_CODE = /^\s*(?:export\s+)?(?:const|let|var|function|class|interface|type|import|return)\s+[A-Za-z_$][\w$]*\s*[=({:;]/;

export const commentsRule = {
  meta: {
    type: "suggestion",
    schema: [],
    messages: {
      reason: "An oxlint-disable gives its reason after ` -- ` (docs/style.md §5).",
      directive: "Do not use eslint-disable directives; fix the code or configure the rule explicitly.",
      todo: "Remove TODO/FIXME comments before landing (docs/style.md §5).",
      code: "Remove commented-out code instead of keeping dead code (docs/style.md §5).",
    },
  },
  create(context) {
    const source = context.sourceCode;
    return {
      Program() {
        for (const comment of source.getAllComments()) {
          const text = comment.value;
          const isJsDoc = comment.type === "Block" && text.startsWith("*");
          if (OXLINT_DISABLE.test(text)) {
            if (!REASON.test(text)) context.report({ loc: comment.loc, messageId: "reason" });
            continue;
          }
          if (ESLINT_DIRECTIVE.test(text)) {
            context.report({ loc: comment.loc, messageId: "directive" });
            continue;
          }
          if (TODO_COMMENT.test(text)) {
            context.report({ loc: comment.loc, messageId: "todo" });
            continue;
          }
          if (!isJsDoc && comment.type === "Line" && COMMENTED_CODE.test(text)) {
            context.report({ loc: comment.loc, messageId: "code" });
          }
        }
      },
    };
  },
};

export const plugin = { rules: { comments: commentsRule } };
