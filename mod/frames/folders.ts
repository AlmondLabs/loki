import type { FolderCheck, RecentFolders } from "../../core/frame-types.ts";
import { reply, type FrameHandlers } from "./context.ts";

export interface FoldersDeps {
  /** Working folders for a new chat (mod/folders.ts). */
  folders?: {
    recent: () => RecentFolders;
    complete: (prefix: string) => string[];
    check: (path: string) => FolderCheck;
    pick: (defaultPath?: string) => Promise<string | null>;
  };
}

/** The folders a new chat may work in: recent ones, completions, a check, and the system picker. */
export function foldersFrames({ folders }: FoldersDeps): FrameHandlers {
  return {
    folders_get: () => reply(folders?.recent() ?? { byAgent: {}, byConversation: {} }),
    folder_complete: ({ prefix }) => reply({ matches: prefix !== null ? (folders?.complete(prefix) ?? []) : [] }),
    folder_check: ({ path }) => reply(path !== null && folders ? folders.check(path) : { ok: false, path: path ?? "", branch: null, reason: "no path" }),
    folder_pick: async ({ defaultPath }) => reply({ path: (await folders?.pick(defaultPath)) ?? null }),
  };
}
