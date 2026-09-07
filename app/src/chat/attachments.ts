import type { ImageAttachment } from "../../../packages/core/src/attention/content.ts";

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

/** Image files out of a paste or drop. */
export function imageBlobs(dt: DataTransfer | null): Blob[] {
  if (!dt) return [];
  const out: Blob[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  }
  if (!out.length) for (const f of Array.from(dt.files ?? [])) if (f.type.startsWith("image/")) out.push(f);
  return out;
}
