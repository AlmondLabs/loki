import { afterAll, vi } from "vitest";

const cwd = process.cwd();
const env = { ...process.env };

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  // Outside (vitest): after resetModules source modules load again in the next file, so one file's vi.mock never
  // reaches another, while node_modules stay loaded.
  vi.resetModules();
  if (process.cwd() !== cwd) process.chdir(cwd);
  for (const k of Object.keys(process.env)) if (!(k in env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, env);
});
