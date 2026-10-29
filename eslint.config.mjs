// `npm run lint`: the rules in docs/style.md §2–§4 that a tool can check. typescript-eslint's strict and stylistic sets
// with type information (no `any`, no `x!`, no floating promises, no dead conditions, one way to write a type), tuned
// where a rule's noise outweighs its catch, and the React hooks plugin, which carries the React Compiler's rules (the
// compiler skips a function that breaks one silently; here it is a red check). Layout is Prettier's, not ESLint's.
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import jsdoc from "eslint-plugin-jsdoc";

export default tseslint.config(
  { ignores: ["node_modules/**", "**/dist/**", ".loki-build/**", "src-tauri/**", ".impeccable/**", "docs/**", ".claude/**"] },
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  reactHooks.configs.flat.recommended,
  {
    languageOptions: {
      parserOptions: {
        // tsconfig.json's files, plus the few config files no tsconfig includes.
        projectService: { allowDefaultProject: ["vitest.config.ts"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `() => void send()` says "fire and forget" where it happens (STYLE §3).
      "@typescript-eslint/no-confusing-void-expression": "off",
      // `${count} tasks` reads fine; objects and nullables in a template are still caught.
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true, allowBoolean: true }],
      // `const noop = () => {}` is a deliberate no-op; an empty method or function declaration is not.
      "@typescript-eslint/no-empty-function": ["error", { allow: ["arrowFunctions"] }],
      // `T[]` for a simple element, `Array<T>` when the element type is itself complex.
      "@typescript-eslint/array-type": ["error", { default: "array-simple" }],
      // `name || "untitled"` treats an empty string as missing on purpose; `??` would keep the empty string.
      "@typescript-eslint/prefer-nullish-coalescing": ["error", { ignorePrimitives: { string: true, boolean: true } }],
      "@typescript-eslint/consistent-type-imports": "error",
      // `runner["deps"]` is how a test reaches a private member; TypeScript allows it with brackets only.
      "@typescript-eslint/dot-notation": ["error", { allowPrivateClassPropertyAccess: true, allowProtectedClassPropertyAccess: true }],
      // Hook dependencies and effects that copy props into state are errors, not a warning count to live with.
      "react-hooks/exhaustive-deps": "error",
      "react-hooks/set-state-in-effect": "error",
      // `_x` says "unused on purpose" (a destructure that strips a prop, a placeholder parameter).
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true }],
      // Identifiers (docs/style.md §2): camelCase values, PascalCase types and components, UPPER_CASE constants, acronyms
      // as words (agentUrl, McpTools). Object and type properties are data (snake_case wire and file names, headers),
      // so they are left as the data has them.
      "@typescript-eslint/naming-convention": [
        "error",
        { selector: "default", format: ["strictCamelCase"], leadingUnderscore: "allow" },
        // A name taken apart from data or a module keeps the name it had there (`const { agent_id } = runtime`).
        { selector: ["variable", "parameter"], modifiers: ["destructured"], format: null },
        // Vite's build-time globals (`__LOKI_VERSION__`), named as build tools name them.
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
      // Named exports only (STYLE §2); the excepted files are below.
      "no-restricted-exports": ["error", { restrictDefaultExports: { direct: true, named: true, defaultFrom: true, namedFrom: true, namespaceFrom: true } }],
    },
  },
  {
    // Tools that import their config by default, and the mod's entry points, which the mod loader imports by default.
    files: ["**/*.config.{ts,mts,js,mjs}", "mod/index.ts", "mod/boot.ts"],
    rules: { "no-restricted-exports": "off" },
  },
  {
    // Every export outside the tests says what it is (STYLE §5): functions, components, classes, interfaces, type aliases
    // and constants alike. A `/** … */` comment, so editors show it where the export is used.
    files: ["**/*.{ts,tsx,mts}"],
    ignores: ["test/**", "test-node/**", "**/*.config.ts", "**/*.d.mts"],
    plugins: { jsdoc },
    rules: {
      "jsdoc/require-jsdoc": [
        "error",
        {
          publicOnly: true,
          require: { FunctionDeclaration: true, ClassDeclaration: true, ArrowFunctionExpression: true, FunctionExpression: true },
          contexts: ["TSInterfaceDeclaration", "TSTypeAliasDeclaration", "ExportNamedDeclaration > VariableDeclaration"],
          checkConstructors: false,
        },
      ],
    },
  },
  {
    // One way per job (docs/architecture.md, plans 054 and 059): the copies a selector can recognise point to the
    // helper. A serial queue or a burst timer written by hand has no shape that is not also ordinary code, so those
    // two stay a convention.
    files: ["core/**/*.ts", "daemon/**/*.ts", "mod/**/*.ts", "app/src/**/*.{ts,tsx}"],
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
    // Plain JavaScript has no types to check against.
    files: ["**/*.{js,mjs,cjs}"],
    ...tseslint.configs.disableTypeChecked,
  },
);
