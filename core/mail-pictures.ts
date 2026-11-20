/**
 * An `<img>` whose `src` is a `cid:` link to a picture carried in the same mail (RFC 2392). The daemon names the
 * pictures it finds this way in `drawnBody` and the app places them there by the same rule, so a picture leaves a
 * mail's files only when the app will draw it. Group 1 is everything before the value; groups 2 to 4 are the id,
 * double-, single- or unquoted.
 */
export const CID_SRC = /(<img\b[^>]*?\ssrc\s*=\s*)(?:"cid:([^"]*)"|'cid:([^']*)'|cid:([^\s>"']+))/gi;

const DROPPED = ["script", "noscript", "iframe", "frameset", "object", "applet"];

const DROPPED_VOID = ["frame", "embed", "base", "link"];

export function cidOf(written: string): string {
  try {
    return decodeURIComponent(written);
  } catch {
    return written;
  }
}

export function bodyOf(html: string): string {
  const open = /<body\b[^>]*>/i.exec(html);
  const from = open ? open.index + open[0].length : 0;
  const close = html.search(/<\/body\s*>/i);
  return html.slice(from, close >= from ? close : html.length);
}

export function drawnBody(html: string): string {
  let body = bodyOf(html);
  for (const name of DROPPED) body = body.replace(new RegExp(`<${name}\\b[\\s\\S]*?(?:<\\/${name}\\s*>|\\/>|$)`, "gi"), "");
  for (const name of DROPPED_VOID) body = body.replace(new RegExp(`<${name}\\b[^>]*>`, "gi"), "");
  return body;
}
