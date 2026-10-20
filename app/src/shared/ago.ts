/** How long ago, as the lists say it: "now", "5m", "3h", "2d". Empty for no time. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const m = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  // Days from a day on, as the Mac's and the phone's lists say it: "40h" reads "2d".
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
