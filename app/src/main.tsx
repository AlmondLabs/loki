// Outside (React Scan): it hooks the DevTools global as it loads, so it must be in place before react-dom evaluates,
// and the app is loaded after it.
if (import.meta.env.DEV && new URLSearchParams(location.search).has("scan")) {
  const { scan } = await import("react-scan");
  scan({ enabled: true, trackUnnecessaryRenders: true });
}
if (import.meta.env.DEV && new URLSearchParams(location.search).has("workbench")) await import("./dev/mount-workbench");
else await import("./boot");
