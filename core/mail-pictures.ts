/**
 * An `<img>` whose `src` is a `cid:` link to a picture carried in the same mail (RFC 2392). The daemon names the
 * pictures it finds this way and the app places them by the same rule, so a picture leaves a mail's files only when
 * the app will draw it. Group 1 is everything before the value; groups 2 to 4 are the id, double-, single- or unquoted.
 */
export const CID_SRC = /(<img\b[^>]*?\ssrc\s*=\s*)(?:"cid:([^"]*)"|'cid:([^']*)'|cid:([^\s>"']+))/gi;

export function cidOf(written: string): string {
  try {
    return decodeURIComponent(written);
  } catch {
    return written;
  }
}
