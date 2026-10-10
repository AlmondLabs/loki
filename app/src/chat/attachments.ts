import type { FileAttachment, ImageAttachment } from "../../../core/attention/content.ts";
import { inLan, injectedToken, modBase } from "../desk/env";

const MAX_EDGE = 1600;

/** Read an image blob, shrink it if it is large, and return it as a base64 attachment. */
export async function imageFromBlob(blob: Blob): Promise<ImageAttachment> {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const keepPng = blob.type === "image/png" && scale === 1 && blob.size < 1_500_000;
  let url: string;
  let mediaType: string;
  if (keepPng) {
    url = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
    mediaType = "image/png";
  } else {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    url = canvas.toDataURL("image/jpeg", 0.85);
    mediaType = "image/jpeg";
  }
  bitmap.close();
  return { id: `img-${Math.random().toString(36).slice(2, 9)}`, mediaType, data: url.slice(url.indexOf(",") + 1), url };
}

/** The upload limit (mod/uploads.ts UPLOAD_MAX_BYTES): checked here too, before a long upload. */
export const FILE_MAX_BYTES = 25 * 1024 * 1024;

/** Every file out of a paste or drop, split into images (sent inside the message) and the rest (uploaded). */
export function droppedFiles(dt: DataTransfer | null): { images: Blob[]; files: File[] } {
  if (!dt) return { images: [], files: [] };
  const all: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== "file") continue;
    const f = item.getAsFile();
    if (f) all.push(f);
  }
  if (!all.length) all.push(...Array.from(dt.files ?? []));
  return { images: all.filter(isInlineImage), files: all.filter((f) => !isInlineImage(f)) };
}

/** An image the agent can see inside the message; SVG and odd types go as files. */
export const isInlineImage = (f: Blob): boolean => /^image\/(png|jpe?g|gif|webp|heic|heif|bmp|tiff)$/i.test(f.type);

/** "482 KB", "3.1 MB". */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** The mod's /uploads with its credential: the desktop token as ?t=, or on the LAN the device cookie. */
function uploadsUrl(query: Record<string, string>): string {
  const token = injectedToken() ?? readToken();
  const q = new URLSearchParams({ ...query, ...(token ? { t: token } : {}) });
  return `${modBase()}/uploads?${q}`;
}

function readToken(): string | null {
  try {
    return localStorage.getItem("loki.token");
  } catch {
    return null;
  }
}

/** Put a file on the Mac (mod/uploads.ts), reporting progress 0–1; resolves to the attachment the message will carry. */
export function uploadFile(file: File, onProgress?: (share: number) => void): Promise<FileAttachment> {
  if (file.size > FILE_MAX_BYTES) return Promise.reject(new Error(`${fileSize(file.size)} is over the ${fileSize(FILE_MAX_BYTES)} limit`));
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", uploadsUrl({ name: file.name || "file", type: file.type || "application/octet-stream" }));
    xhr.withCredentials = inLan;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: { path?: string; name?: string; size?: number; mime?: string; error?: string } = {};
      try {
        body = JSON.parse(xhr.responseText) as typeof body;
      } catch {
        // not JSON: the status says enough
      }
      if (xhr.status !== 200 || !body.path) return reject(new Error(body.error ?? `upload failed (${xhr.status})`));
      resolve({ id: `file-${Math.random().toString(36).slice(2, 9)}`, kind: "file", path: body.path, name: body.name ?? file.name, size: body.size ?? file.size, mime: body.mime ?? file.type });
    };
    xhr.onerror = () => reject(new Error("couldn't reach loki on the Mac"));
    xhr.send(file);
  });
}

/** A file taken off the message before it was sent: removed from the Mac again. Failing is harmless. */
export function discardUpload(path: string): void {
  void fetch(uploadsUrl({ path }), { method: "DELETE", credentials: inLan ? "include" : "same-origin" }).catch(() => undefined);
}
