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
    // Files share each worker's loaded modules instead of loading the app again per file: about half the suite's time,
    // most of it on Windows. The setup file puts back what a file may change, and files run in a random order (its
    // seed printed at the start) so one that leaks state into the next fails somewhere instead of passing by luck.
    // Tests inside a file keep their order: several build one fixture in beforeAll and go through it step by step.
    isolate: false,
    setupFiles: ["./test/fixtures/reset-after-file.ts"],
    sequence: { shuffle: { files: true, tests: false } },
    testTimeout: 20_000,
  },
});
