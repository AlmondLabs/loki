import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The canvas is a Vite dev server: it compiles whatever the agent writes into
 * app/src/widgets and hot-replaces it in the open tab. The mod adopts a running
 * server if one answers, otherwise spawns one detached so it survives /reload.
 */

export interface DevServerInfo {
  url: string;
  port: number;
  adopted: boolean;
  pid?: number;
}

export async function probeDevServer(port: number, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    return (await res.text()).includes("loci");
  } catch {
    return false;
  }
}

export interface EnsureOptions {
  port: number;
  modPort: number;
  viteBin: string;
  viteConfig: string;
  cwd: string;
  logPath: string;
  widgetsDir: string;
  timeoutMs?: number;
}

export async function ensureDevServer(opts: EnsureOptions): Promise<DevServerInfo> {
  const url = `http://127.0.0.1:${opts.port}`;
  if (await probeDevServer(opts.port)) return { url, port: opts.port, adopted: true };

  mkdirSync(dirname(opts.logPath), { recursive: true });
  const fd = openSync(opts.logPath, "a");
  const child = spawn(
    process.execPath,
    [opts.viteBin, "--config", opts.viteConfig, "--port", String(opts.port), "--strictPort", "--host", "127.0.0.1"],
    {
      cwd: opts.cwd,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: {
        ...process.env,
        // Under the desktop app process.execPath is Electron; this makes it run as Node.
        ELECTRON_RUN_AS_NODE: "1",
        LOCI_PORT: String(opts.modPort),
        LOCI_WIDGETS_DIR: opts.widgetsDir,
        FORCE_COLOR: "0",
      },
    },
  );
  child.unref();

  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    if (await probeDevServer(opts.port)) return { url, port: opts.port, adopted: false, pid: child.pid };
  }
  throw new Error(`vite did not answer on ${opts.port} within ${opts.timeoutMs ?? 20_000}ms — see ${opts.logPath}`);
}
