import { mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { messageOf } from "../../core/errors.ts";
import { compareVersions, parseVersion } from "../../core/version.ts";
import type { Installer } from "./install.ts";
import { UPDATE_PUBLIC_KEY, updateVerifier, type UpdateVerifier } from "./minisign.ts";
import { disposePayload, fieldOf, UpdateFailure, type Found, type Remote, type UpdatePayload } from "./updates.ts";

export const CHECK_TIMEOUT_MS = 60 * 1000;
export const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

export type PlatformKey = "darwin-aarch64" | "windows-x86_64" | "linux-x86_64";

export interface Release {
  version: string;
  url: string;
  signature: string;
}

export type Fetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

export function platformKey(platform: NodeJS.Platform, arch: string): PlatformKey | null {
  if (platform === "darwin" && arch === "arm64") return "darwin-aarch64";
  if (platform === "win32" && arch === "x64") return "windows-x86_64";
  if (platform === "linux" && arch === "x64") return "linux-x86_64";
  return null;
}

export function newerRelease(desktopJson: unknown, current: string, key: PlatformKey | null): Release | null {
  const version = fieldOf(desktopJson, "version");
  if (typeof version !== "string" || !parseVersion(version)) throw new Error("desktop.json names no version");
  const order = compareVersions(version, current);
  if (order === null || order <= 0) return null;
  const entry = key ? fieldOf(fieldOf(desktopJson, "platforms"), key) : undefined;
  const [url, signature] = [fieldOf(entry, "url"), fieldOf(entry, "signature")];
  if (typeof url !== "string" || typeof signature !== "string") throw new Error(`desktop.json has no ${key ?? "update"} for this system`);
  return { version, url, signature };
}

async function readBody(
  response: Response,
  onChunk: (bytes: number, total: number | null) => void,
  verifier: UpdateVerifier,
  tempDir?: string,
): Promise<UpdatePayload> {
  const length = Number(response.headers.get("content-length"));
  const total = Number.isInteger(length) && length > 0 ? length : null;
  if (tempDir) {
    const dir = await mkdtemp(join(tempDir, "loki-dl-"));
    const path = join(dir, "update.bin");
    const dispose = () => rm(dir, { recursive: true, force: true });
    let handle;
    try {
      handle = await open(path, "w");
      if (!response.body) {
        const buf = new Uint8Array(await response.arrayBuffer());
        await handle.write(buf);
        verifier.update(buf);
        onChunk(buf.length, total);
      } else {
        for await (const chunk of response.body) {
          await handle.write(chunk);
          verifier.update(chunk);
          onChunk(chunk.length, total);
        }
      }
      await handle.close();
      handle = undefined;
      return { path, dispose };
    } catch (error) {
      await handle?.close().catch(() => {});
      await dispose().catch(() => {});
      throw error;
    }
  }
  const chunks: Uint8Array[] = [];
  const take = (chunk: Uint8Array) => {
    chunks.push(chunk);
    verifier.update(chunk);
    onChunk(chunk.length, total);
  };
  if (!response.body) take(new Uint8Array(await response.arrayBuffer()));
  else for await (const chunk of response.body) take(chunk);
  return Buffer.concat(chunks);
}

export interface RemoteOptions {
  fetch: Fetch;
  current: string;
  platform: PlatformKey | null;
  installer: Installer;
  publicKey?: string;
  tempDir?: string;
}

function found(release: Release, { fetch, current, installer, publicKey = UPDATE_PUBLIC_KEY, tempDir }: RemoteOptions): Found {
  const headers = { "user-agent": `loki/${current}` };
  return {
    version: release.version,
    installProblem: installer.problem,
    install: installer.install,
    download: async (onChunk) => {
      let verifier: UpdateVerifier;
      try {
        verifier = updateVerifier(release.signature, release.version, publicKey);
      } catch (error) {
        throw new UpdateFailure("signature", messageOf(error));
      }
      let payload: UpdatePayload;
      try {
        const response = await fetch(release.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), headers });
        if (!response.ok) throw new Error(`${release.url} answered ${response.status}`);
        payload = await readBody(response, onChunk, verifier, tempDir);
      } catch (error) {
        throw new UpdateFailure("download", messageOf(error));
      }
      try {
        verifier.verify(payload instanceof Uint8Array ? payload : payload.path);
      } catch (error) {
        await disposePayload(payload);
        throw new UpdateFailure("signature", messageOf(error));
      }
      return payload;
    },
  };
}

export function githubRemote(options: RemoteOptions): Remote {
  return {
    check: async (url) => {
      const response = await options.fetch(url, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), headers: { "user-agent": `loki/${options.current}` } });
      if (!response.ok) throw new Error(`${url} answered ${response.status}`);
      const release = newerRelease(await response.json(), options.current, options.platform);
      return release ? found(release, options) : null;
    },
  };
}
