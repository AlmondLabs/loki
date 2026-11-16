import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["node_modules/**", "**/dist/**", ".loki-build/**", "src-tauri/**", ".impeccable/**", "docs/**", ".claude/**"] },
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  reactHooks.configs.flat.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["vitest.config.ts"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true, allowBoolean: true }],
      "@typescript-eslint/no-empty-function": ["error", { allow: ["arrowFunctions"] }],
      "@typescript-eslint/array-type": ["error", { default: "array-simple" }],
      "@typescript-eslint/prefer-nullish-coalescing": ["error", { ignorePrimitives: { string: true, boolean: true } }],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/dot-notation": ["error", { allowPrivateClassPropertyAccess: true, allowProtectedClassPropertyAccess: true }],
      "react-hooks/exhaustive-deps": "error",
      "react-hooks/set-state-in-effect": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true }],
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
      "no-restricted-exports": ["error", { restrictDefaultExports: { direct: true, named: true, defaultFrom: true, namedFrom: true, namespaceFrom: true } }],
    },
  },
  {
    files: ["**/*.config.{ts,mts,js,mjs}", "mod/index.ts", "mod/boot.ts"],
    rules: { "no-restricted-exports": "off" },
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
  {
    files: ["**/*.{js,mjs,cjs}"],
    ...tseslint.configs.disableTypeChecked,
  },
);
