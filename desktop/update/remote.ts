import { messageOf } from "../../core/errors.ts";
import { compareVersions, parseVersion } from "../../core/version.ts";
import type { Installer } from "./install.ts";
import { UPDATE_PUBLIC_KEY, updateVerifier, type UpdateVerifier } from "./minisign.ts";
import { fieldOf, UpdateFailure, type Found, type Remote } from "./updates.ts";

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

async function readBody(response: Response, onChunk: (bytes: number, total: number | null) => void, verifier: UpdateVerifier): Promise<Uint8Array> {
  const length = Number(response.headers.get("content-length"));
  const total = Number.isInteger(length) && length > 0 ? length : null;
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
}

function found(release: Release, { fetch, current, installer, publicKey = UPDATE_PUBLIC_KEY }: RemoteOptions): Found {
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
      let bytes: Uint8Array;
      try {
        const response = await fetch(release.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), headers });
        if (!response.ok) throw new Error(`${release.url} answered ${response.status}`);
        bytes = await readBody(response, onChunk, verifier);
      } catch (error) {
        throw new UpdateFailure("download", messageOf(error));
      }
      try {
        verifier.verify(bytes);
      } catch (error) {
        throw new UpdateFailure("signature", messageOf(error));
      }
      return bytes;
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
