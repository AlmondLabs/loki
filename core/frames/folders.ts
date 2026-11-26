import { strOr, type Raw } from "./primitives.ts";
import { BY_HOME, PHONE, request } from "./types.ts";

export const foldersFrames = {
  folders_get: request("folders", "the folders each agent and conversation has worked in", (m: Raw) => ({ home: strOr(m.home, null) }), PHONE, BY_HOME),
  folder_complete: request(
    "folder_matches",
    "folders completing a typed prefix",
    (m: Raw) => ({ prefix: strOr(m.prefix, null), home: strOr(m.home, null) }),
    false,
    BY_HOME,
  ),
  folder_check: request(
    "folder_status",
    "whether a path is a folder a chat can work in, and its git branch",
    (m: Raw) => ({ path: strOr(m.path, null), home: strOr(m.home, null) }),
    false,
    BY_HOME,
  ),
  folder_pick: request("folder_picked", "the system folder picker (null when cancelled)", (m: Raw) => ({ default_path: strOr(m.default_path, undefined) })),
} as const;
