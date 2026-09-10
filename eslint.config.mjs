// `bun run lint`. Two rule sets and nothing stylistic: typescript-eslint's recommended set, and the React hooks
// plugin, which since v6 carries the React Compiler's rules (refs, purity, immutability, set-state-in-effect).
// The compiler skips a function that breaks one of those silently at build time; here the same condition is a
// line in the editor and a red check in CI. Formatting is nobody's job here — tsc, react-doctor and taste.
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["node_modules/**", "**/dist/**", ".loki-build/**", "src-tauri/**", ".impeccable/**", "docs/**"] },
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    rules: {
      // Effects that copy a prop into state on change: a habit to unlearn file by file, not a reason to block a commit.
      "react-hooks/set-state-in-effect": "warn",
      // `_x` says "unused on purpose" (a destructure that strips a prop, a placeholder parameter).
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true }],
    },
  },
);
