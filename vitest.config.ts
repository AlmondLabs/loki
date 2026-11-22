import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: { alias: { "@loki/kit": here("./app/src/kit/index.tsx"), "@": here("./app/src") } },
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", ".claude/**"],
    environment: "node",
    pool: "forks",
    isolate: false,
    setupFiles: ["./test/fixtures/reset-after-file.ts"],
    sequence: { shuffle: { files: true, tests: false } },
    testTimeout: 20_000,
  },
});
