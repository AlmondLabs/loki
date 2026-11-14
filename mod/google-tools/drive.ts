import { basename } from "node:path";
import type { GoogleAuth } from "../google-auth.ts";
import { count, fileTypeOf, flag, listing, md5, optText, readInChat, rec, str, textArg, writeInChat, type GoogleCall, type GoogleToolDef } from "./core.ts";

/**
 * Drive for scripts (plan 2026-11-11 scripts, U7): list, download or export to the chat's folder, upload from it, and
 * change files (folders, names, moves, copies, trash, delete). Every write answers with the file as Drive stored it,
 * and every transfer with its MD5 against Drive's own (R21).
 */

/** Drive's API. */
export const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
/** The fields a file is answered with. */
const FILE_FIELDS = "id,name,mimeType,parents,modifiedTime,size,md5Checksum,webViewLink,trashed";
/** Above this a file goes up in a resumable upload, in one PUT after its session; below it, in one multipart POST. */
const MULTIPART_MAX = 5 * 1024 * 1024;
/** How long one transfer may take. */
export const TRANSFER_MS = 5 * 60_000;
/** What a Google-native file is exported as when the script names no type. */
const EXPORTS: Record<string, string> = {
  "application/vnd.google-apps.document": "application/pdf",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "application/pdf",
  "application/vnd.google-apps.drawing": "image/png",
};
/** Every Drive call reaches shared drives too. */
const ALL_DRIVES = { supportsAllDrives: "true" };

/** A file as Drive answers it, trimmed to what a script uses. */
export function fileOf(v: unknown): Record<string, unknown> {
  const f = rec(v);
  return {
    id: str(f.id),
    name: str(f.name),
    mime_type: str(f.mimeType),
    parents: Array.isArray(f.parents) ? f.parents : [],
    modified: str(f.modifiedTime),
    ...(f.size === undefined ? {} : { size: Number(f.size) }),
    ...(typeof f.md5Checksum === "string" ? { md5: f.md5Checksum } : {}),
    ...(typeof f.webViewLink === "string" ? { link: f.webViewLink } : {}),
    ...(f.trashed === true ? { trashed: true } : {}),
  };
}

/** A file's metadata. */
async function metadata(auth: GoogleAuth, id: string): Promise<Record<string, unknown>> {
  return rec(
    await auth.json({ service: "drive", method: "GET", url: `${DRIVE}/files/${encodeURIComponent(id)}`, query: { fields: FILE_FIELDS, ...ALL_DRIVES } }),
  );
}

/**
 * Put bytes in Drive as a new file, in `folder` when given, converted to a Google type when `convertTo` names one.
 * Answers with the stored file and whether its MD5 matches what was sent (a converted file has none to match).
 */
export async function uploadToDrive(
  auth: GoogleAuth,
  input: { data: Uint8Array<ArrayBuffer>; name: string; mimeType: string; folder?: string; convertTo?: string },
): Promise<Record<string, unknown>> {
  const meta = { name: input.name, ...(input.folder ? { parents: [input.folder] } : {}), ...(input.convertTo ? { mimeType: input.convertTo } : {}) };
  const query = { fields: FILE_FIELDS, ...ALL_DRIVES };
  let stored: unknown;
  if (input.data.byteLength <= MULTIPART_MAX) {
    const boundary = `loki-${md5(input.data).slice(0, 12)}`;
    const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${input.mimeType}\r\n\r\n`;
    const body = Buffer.concat([Buffer.from(head), input.data, Buffer.from(`\r\n--${boundary}--`)]);
    stored = await auth.json({
      service: "drive",
      method: "POST",
      url: UPLOAD,
      query: { uploadType: "multipart", ...query },
      body: { data: new Uint8Array(body), type: `multipart/related; boundary=${boundary}` },
      timeoutMs: TRANSFER_MS,
    });
  } else {
    const session = await auth.send({
      service: "drive",
      method: "POST",
      url: UPLOAD,
      query: { uploadType: "resumable", ...query },
      json: meta,
      headers: { "x-upload-content-type": input.mimeType, "x-upload-content-length": String(input.data.byteLength) },
    });
    const location = session.headers.get("location");
    if (!location) throw new Error("Drive did not open an upload");
    stored = await auth.json({ service: "drive", method: "PUT", url: location, body: { data: input.data, type: input.mimeType }, timeoutMs: TRANSFER_MS });
  }
  const file = fileOf(stored);
  const sent = md5(input.data);
  return { ...file, sent_md5: sent, ...(typeof file.md5 === "string" ? { md5_matches: file.md5 === sent } : {}) };
}

const list: GoogleToolDef = {
  name: "google_drive_list",
  description:
    "List Drive files: by `query` (Drive's search syntax, e.g. \"name contains 'invoice'\"), or in `folder` (an id). One page, or with `all_pages` every page saved to a file, answered with its path and the first 20.",
  properties: {
    query: { type: "string" },
    folder: { type: "string", description: "A folder's id: its files, trashed ones left out" },
    all_pages: { type: "boolean" },
    page: { type: "string", description: "next_page from an earlier answer" },
    page_size: { type: "integer", description: "Up to 1000; default 100" },
  },
  service: "drive",
  reads: true,
  run: (call) => {
    const folder = optText(call.args, "folder");
    const query = [optText(call.args, "query"), folder ? `'${folder.replace(/'/g, "\\'")}' in parents and trashed = false` : undefined]
      .filter(Boolean)
      .join(" and ");
    const pageSize = String(count(call.args, "page_size", 100, 1000));
    return listing(
      call,
      "google_drive_list",
      flag(call.args, "all_pages"),
      async (token) => {
        const r = rec(
          await call.auth.json({
            service: "drive",
            method: "GET",
            url: `${DRIVE}/files`,
            query: {
              fields: `nextPageToken,files(${FILE_FIELDS})`,
              pageSize,
              includeItemsFromAllDrives: "true",
              ...ALL_DRIVES,
              ...(query ? { q: query } : {}),
              ...(token ? { pageToken: token } : {}),
            },
          }),
        );
        return { items: (Array.isArray(r.files) ? r.files : []).map(fileOf), next: str(r.nextPageToken) || undefined };
      },
      optText(call.args, "page"),
    );
  },
};

const download: GoogleToolDef = {
  name: "google_drive_download",
  description:
    "Save a Drive file to `path` in this chat's folder. A Google Doc, Sheet or Slides file is exported, as `export_as` (a MIME type such as text/csv or application/pdf) or a default. Answers with the path, size and MD5, and whether it matches Drive's.",
  properties: {
    file: { type: "string", description: "The file's id" },
    path: { type: "string" },
    export_as: { type: "string" },
  },
  required: ["file", "path"],
  service: "drive",
  reads: true,
  run: async (call) => saveDriveFile(call, textArg(call.args, "file"), textArg(call.args, "path"), optText(call.args, "export_as")),
};

/** A Drive file's bytes saved in the chat's folder, exported when it is a Google one, with its checksum against Drive's. */
async function saveDriveFile(call: GoogleCall, id: string, path: string, exportAs: string | undefined): Promise<Record<string, unknown>> {
  const meta = await metadata(call.auth, id);
  const type = str(meta.mimeType);
  const native = type.startsWith("application/vnd.google-apps.");
  const as = exportAs ?? EXPORTS[type];
  if (native && !as) throw new Error(`${str(meta.name)} is a ${type} file, which Drive cannot export without \`export_as\``);
  const data = await call.auth.bytes(
    native && as
      ? { service: "drive", method: "GET", url: `${DRIVE}/files/${encodeURIComponent(id)}/export`, query: { mimeType: as }, timeoutMs: TRANSFER_MS }
      : { service: "drive", method: "GET", url: `${DRIVE}/files/${encodeURIComponent(id)}`, query: { alt: "media", ...ALL_DRIVES }, timeoutMs: TRANSFER_MS },
  );
  const full = await writeInChat(call.ctx, path, data);
  const sum = md5(data);
  const drive = typeof meta.md5Checksum === "string" ? meta.md5Checksum : null;
  return {
    path: full,
    name: str(meta.name),
    size: data.byteLength,
    md5: sum,
    // A Google Doc, Sheet or Slides file is made on export and has no checksum of its own to match.
    ...(drive ? { md5_matches: drive === sum } : { md5_matches: null, why: "an exported Google file has no checksum in Drive" }),
  };
}

const upload: GoogleToolDef = {
  name: "google_drive_upload",
  description:
    "Upload a file from `path` in this chat's folder to Drive, into `folder` (an id) when given, named `name` or the file's own name. `convert_to` (e.g. application/vnd.google-apps.spreadsheet) makes it a Google file. Answers with the stored file and whether its MD5 matches the file sent.",
  properties: {
    path: { type: "string" },
    folder: { type: "string" },
    name: { type: "string" },
    convert_to: { type: "string" },
  },
  required: ["path"],
  service: "drive",
  reads: false,
  run: async (call) => {
    const path = textArg(call.args, "path");
    const { full, data } = await readInChat(call.ctx, path);
    const name = optText(call.args, "name") ?? basename(full);
    const folder = optText(call.args, "folder");
    const convertTo = optText(call.args, "convert_to");
    return uploadToDrive(call.auth, { data, name, mimeType: fileTypeOf(full), ...(folder ? { folder } : {}), ...(convertTo ? { convertTo } : {}) });
  },
};

const change: GoogleToolDef = {
  name: "google_drive_change",
  description:
    "Change Drive files. `action`: create_folder (name, folder), rename (file, name), move (file, folder), copy (file, name?, folder?), trash (file), delete (file, for good). Answers with the file as Drive stored it; a copy with both files' MD5.",
  properties: {
    action: { type: "string", enum: ["create_folder", "rename", "move", "copy", "trash", "delete"] },
    file: { type: "string" },
    name: { type: "string" },
    folder: { type: "string", description: "A folder's id: where a new folder, a moved file or a copy goes" },
  },
  required: ["action"],
  service: "drive",
  reads: false,
  run: async (call) => {
    const action = textArg(call.args, "action");
    const fields = { fields: FILE_FIELDS, ...ALL_DRIVES };
    const url = (id: string, suffix = "") => `${DRIVE}/files/${encodeURIComponent(id)}${suffix}`;
    switch (action) {
      case "create_folder": {
        const folder = optText(call.args, "folder");
        const made = await call.auth.json({
          service: "drive",
          method: "POST",
          url: `${DRIVE}/files`,
          query: fields,
          json: { name: textArg(call.args, "name"), mimeType: "application/vnd.google-apps.folder", ...(folder ? { parents: [folder] } : {}) },
        });
        return fileOf(made);
      }
      case "rename":
        return fileOf(
          await call.auth.json({
            service: "drive",
            method: "PATCH",
            url: url(textArg(call.args, "file")),
            query: fields,
            json: { name: textArg(call.args, "name") },
          }),
        );
      case "move": {
        const id = textArg(call.args, "file");
        const before = await metadata(call.auth, id);
        const from = (Array.isArray(before.parents) ? before.parents : []).filter((p): p is string => typeof p === "string").join(",");
        const moved = fileOf(
          await call.auth.json({
            service: "drive",
            method: "PATCH",
            url: url(id),
            query: { ...fields, addParents: textArg(call.args, "folder"), ...(from ? { removeParents: from } : {}) },
            json: {},
          }),
        );
        // A move keeps the file's bytes: its checksum is the one it had.
        return { ...moved, ...(typeof before.md5Checksum === "string" ? { md5_matches: moved.md5 === before.md5Checksum } : {}) };
      }
      case "copy": {
        const id = textArg(call.args, "file");
        const before = await metadata(call.auth, id);
        const name = optText(call.args, "name");
        const folder = optText(call.args, "folder");
        const copy = fileOf(
          await call.auth.json({
            service: "drive",
            method: "POST",
            url: url(id, "/copy"),
            query: fields,
            json: { ...(name ? { name } : {}), ...(folder ? { parents: [folder] } : {}) },
          }),
        );
        return {
          ...copy,
          source_md5: str(before.md5Checksum) || null,
          ...(typeof copy.md5 === "string" ? { md5_matches: copy.md5 === before.md5Checksum } : {}),
        };
      }
      case "trash":
        return fileOf(
          await call.auth.json({ service: "drive", method: "PATCH", url: url(textArg(call.args, "file")), query: fields, json: { trashed: true } }),
        );
      case "delete": {
        const id = textArg(call.args, "file");
        await call.auth.json({ service: "drive", method: "DELETE", url: url(id), query: ALL_DRIVES });
        return { id, deleted: true };
      }
      default:
        throw new Error(`\`action\` must be create_folder, rename, move, copy, trash or delete, not ${action}`);
    }
  },
};

/** The Drive tools. */
export const driveTools: GoogleToolDef[] = [list, download, upload, change];
