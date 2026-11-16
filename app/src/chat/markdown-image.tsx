import { useState, type ImgHTMLAttributes } from "react";
import "./chat.css";

export function isRemoteImage(src: string, base: string = location.href): boolean {
  try {
    const u = new URL(src, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (u.origin === new URL(base).origin) return false;
    return !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

export function MarkdownImage({ src, alt }: ImgHTMLAttributes<HTMLImageElement>) {
  const [shown, setShown] = useState(false);
  if (typeof src !== "string" || !src) return null;
  if (shown || !isRemoteImage(src)) return <img src={src} alt={alt ?? ""} referrerPolicy="no-referrer" className="loki-md-img" />;
  let host = src;
  try {
    host = new URL(src).host;
  } catch {}
  return (
    <button type="button" className="loki-md-remote" title={src} onClick={() => setShown(true)}>
      Image from {host}
      {alt ? ` · ${alt}` : ""} · show
    </button>
  );
}

export const MARKDOWN_COMPONENTS = { img: MarkdownImage } as const;
