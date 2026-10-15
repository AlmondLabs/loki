import { useState, type ImgHTMLAttributes } from "react";
import "./chat.css";

/**
 * Images in markdown: what an agent wrote, a memory file, a pasted prompt. A remote one (another host, not this page's
 * and not the loopback daemon) loads only when the person asks: its address can carry whatever the agent was led to
 * put there (a page it read telling it to "show" an image whose URL holds a secret), and fetching it is the leak.
 * A data: or same-origin image shows at once.
 */
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

/** An image in markdown: shown at once when it is local, else a button naming its host that loads it only when pressed (see `isRemoteImage`). */
export function MarkdownImage({ src, alt }: ImgHTMLAttributes<HTMLImageElement>) {
  const [shown, setShown] = useState(false);
  if (typeof src !== "string" || !src) return null;
  if (shown || !isRemoteImage(src)) return <img src={src} alt={alt ?? ""} referrerPolicy="no-referrer" className="loki-md-img" />;
  let host = src;
  try {
    host = new URL(src).host;
  } catch {
    // shown as written
  }
  return (
    <button type="button" className="loki-md-remote" title={src} onClick={() => setShown(true)}>
      Image from {host}
      {alt ? ` · ${alt}` : ""} · show
    </button>
  );
}

/** react-markdown's components with images held back; spread other overrides over it. */
export const MARKDOWN_COMPONENTS = { img: MarkdownImage } as const;
