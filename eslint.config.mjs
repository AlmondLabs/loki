// The two rules oxlint (.oxlintrc.json) has no version of: identifiers' case (docs/style.md) and the few patterns that
// have a helper of their own. Neither needs type information, so this runs in seconds.
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "**/dist/**", ".loki-build/**", "src-tauri/**", ".impeccable/**", "docs/**", ".claude/**"] },
  {
    files: ["**/*.{ts,tsx,mts,cts,js,mjs,cjs}"],
    languageOptions: { parser: tseslint.parser },
    plugins: { "@typescript-eslint": tseslint.plugin },
    // The code's disable comments are oxlint's to judge, for its rules.
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: {
      "@typescript-eslint/naming-convention": [
        "error",
        { selector: "default", format: ["strictCamelCase"], leadingUnderscore: "allow" },
        { selector: ["variable", "parameter"], modifiers: ["destructured"], format: null },
        { selector: "variable", filter: { regex: "^__[A-Z_]+__$", match: true }, format: null },
        { selector: "variable", format: ["strictCamelCase", "StrictPascalCase", "UPPER_CASE"], leadingUnderscore: "allow" },
        { selector: "function", format: ["strictCamelCase", "StrictPascalCase"] },
        { selector: "parameter", format: ["strictCamelCase", "StrictPascalCase"], leadingUnderscore: "allow" },
        { selector: "typeLike", format: ["StrictPascalCase"] },
        { selector: "interface", format: ["StrictPascalCase"], custom: { regex: "^I[A-Z]", match: false } },
        { selector: "typeParameter", format: ["StrictPascalCase"] },
        { selector: ["objectLiteralProperty", "typeProperty", "objectLiteralMethod", "typeMethod"], format: null },
        { selector: "import", format: null },
      ],
    },
  },
  {
    files: ["core/**/*.ts", "daemon/**/*.ts", "mod/**/*.ts", "app/src/**/*.{ts,tsx}", "site/src/**/*.{ts,tsx}"],
    ignores: ["core/listeners.ts", "core/errors.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='Set'][typeArguments.params.0.type='TSFunctionType']",
          message: "A set of listeners is a Listeners (core/listeners.ts): add returns the way to stop, emit tells them.",
        },
        {
          selector: "ConditionalExpression[test.operator='instanceof'][test.right.name='Error'][consequent.property.name='message']",
          message: "An error in words is messageOf(err) (core/errors.ts).",
        },
      ],
    },
  },
);
