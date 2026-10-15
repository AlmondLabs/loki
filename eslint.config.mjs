// `npm run lint`: the rules in docs/STYLE.md §2–§4 that a tool can check. typescript-eslint's strict and stylistic sets
// with type information (no `any`, no `x!`, no floating promises, no dead conditions, one way to write a type), tuned
// where a rule's noise outweighs its catch, and the React hooks plugin, which carries the React Compiler's rules (the
// compiler skips a function that breaks one silently; here it is a red check). Layout is Prettier's, not ESLint's.
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
    // Plain JavaScript has no types to check against.
    files: ["**/*.{js,mjs,cjs}"],
    ...tseslint.configs.disableTypeChecked,
  },
);
