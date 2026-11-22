// Outside (linuxdeploy): it runs `ldd` on every binary in the AppImage, and `ldd` on a glibc system cannot read a musl
// binary, so it stops the build when npm has installed both of a native package's Linux builds.
export type Libc = "glibc" | "musl" | null;

// Outside (Node): a glibc build names its glibc version in the process report's header, a musl build does not.
export function thisLibc(): Libc {
  if (process.platform !== "linux") return null;
  const report: unknown = process.report.getReport();
  const header: unknown = typeof report === "object" && report !== null && "header" in report ? report.header : null;
  const glibc = typeof header === "object" && header !== null && "glibcVersionRuntime" in header ? header.glibcVersionRuntime : null;
  return typeof glibc === "string" && glibc !== "" ? "glibc" : "musl";
}

export function forLibc(names: string[], libc: Libc): string[] {
  if (libc === "glibc") return names.filter((n) => !n.endsWith("-musl"));
  if (libc === "musl") return names.filter((n) => !/-gnu(eabihf)?$/.test(n));
  return names;
}
