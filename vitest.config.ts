// `npm test`: the suite (test/), on Node, the runtime loki's daemon and mod run on. test-node/ keeps the few
// tests that need Node's own test runner (a child process killed mid-turn, the mod folder's reloads): `npm run test:node`.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // The app's own alias (app/vite.config.ts).
  resolve: { alias: { "@loki/kit": here("./app/src/kit/index.tsx") } },
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", ".claude/**"],
    environment: "node",
    // Each file in its own process: the daemon's pieces spawn children, chdir and listen on ports.
    pool: "forks",
  },
});
