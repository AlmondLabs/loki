// Which of a native package's prebuilt binaries (`@napi-rs/keyring-linux-x64-gnu`, `…-linux-x64-musl`, …) the app
// bundle carries. npm installs both of Linux's C library builds, and linuxdeploy runs `ldd` on every binary in the
// AppImage: `ldd` on a glibc system cannot read a musl binary and linuxdeploy stops the build, so a bundle keeps only
// the build for the C library this system runs on.

/** The C library the running Node was built against: `glibc`, `musl`, or null off Linux. */
export type Libc = "glibc" | "musl" | null;

/** This process's C library, from Node's report: a glibc build names its glibc version there, a musl build does not. */
export function thisLibc(): Libc {
  if (process.platform !== "linux") return null;
  const report: unknown = process.report.getReport();
  const header: unknown = typeof report === "object" && report !== null && "header" in report ? report.header : null;
  const glibc = typeof header === "object" && header !== null && "glibcVersionRuntime" in header ? header.glibcVersionRuntime : null;
  return typeof glibc === "string" && glibc !== "" ? "glibc" : "musl";
}

/** The binary package names for `libc`: the other C library's Linux builds (`-musl` or `-gnu…`) are left out. */
export function forLibc(names: string[], libc: Libc): string[] {
  if (libc === "glibc") return names.filter((n) => !n.endsWith("-musl"));
  if (libc === "musl") return names.filter((n) => !/-gnu(eabihf)?$/.test(n));
  return names;
}
