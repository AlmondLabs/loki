// Test files share a process and its loaded modules (vitest.config.ts: isolate off), so after each file this puts back
// what a file may have changed: mocks and spies, stubbed globals and env, fake timers, mocked modules, the working
// folder and process.env. A file that changes anything else undoes it itself (AGENTS.md, "Tests").
import { afterAll, vi } from "vitest";

const cwd = process.cwd();
const env = { ...process.env };

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  // Source modules load again in the next file, so one file's vi.mock never reaches another; node_modules stay loaded.
  vi.resetModules();
  if (process.cwd() !== cwd) process.chdir(cwd);
  for (const k of Object.keys(process.env)) if (!(k in env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, env);
});
