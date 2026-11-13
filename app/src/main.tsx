// The entry. React Scan, when asked for, must be in place before react-dom evaluates (it hooks the
// DevTools global at load), so the app itself is loaded second, dynamically. Development only, and only
// with `?scan` on the URL: every component that rendered without its output changing gets outlined, which
// is how a memo that quietly stopped holding shows itself. Absent from production builds.
if (import.meta.env.DEV && new URLSearchParams(location.search).has("scan")) {
  const { scan } = await import("react-scan");
  scan({ enabled: true, trackUnnecessaryRenders: true });
}
// The Liquid Glass workbench (plan 2026-11-12-1505, U2) in place of the app: development only, with `?workbench`.
if (import.meta.env.DEV && new URLSearchParams(location.search).has("workbench")) await import("./dev/mount-workbench");
else await import("./boot");
