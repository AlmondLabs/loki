//! Letta Code on this Mac: the one already installed, or one installed with npm.
//!
//! loki runs the machine's own Letta Code — the `letta` a terminal would run — rather than a private copy
//! (that was the 2026-09-09 design; docs/plans/2026-09-15-009 says why it went). Discovery looks where
//! installers put it: `LOKI_LETTA_BIN` first, then PATH, then the folders GUI apps do not see on their short
//! PATH (Homebrew's prefixes, volta, bun, nvm, fnm, npm's own global bin). Nothing found: `npm install -g
//! @letta-ai/letta-code@latest` with the npm that goes with the first Node 22+ found the same way, so the
//! terminal's `letta` and loki's are the same file. Homebrew's Node (the cask depends on it) owns its global
//! folder, so no sudo; a root-owned folder from the nodejs.org installer fails with EACCES, and the error
//! names the sudo line to run, since loki never runs one.
//!
//! Updating is Settings › letta: `latest_version` asks the registry, `install_version` runs the same npm
//! command at `latest`. The harness loki launches runs with the self-updater off (harness.rs); the user's own
//! terminal sessions keep the global install fresh by themselves.

use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub const PACKAGE: &str = "@letta-ai/letta-code";
/// letta-code's engines.node (it runs under Bun when one is on PATH, Node otherwise; npm needs Node either way).
pub const NODE_MIN: (u32, u32, u32) = (22, 19, 0);

/// Where the harness runs from, and what it needs on PATH.
#[derive(Clone, Debug)]
pub struct Runtime {
    pub letta: PathBuf,
    /// A directory holding `node` (and `npm`) to prepend to PATH: the `letta` shim is `#!/usr/bin/env node`.
    pub node_bin_dir: Option<PathBuf>,
    /// Named outright by LOKI_LETTA_BIN (a checkout, say): not npm's, so not the update button's to move.
    pub explicit: bool,
}

pub fn parse_version(s: &str) -> Option<(u32, u32, u32)> {
    let s = s.trim().trim_start_matches('v');
    let s = s.split_whitespace().next()?;
    let mut it = s.split('.').map(|p| p.parse::<u32>().ok());
    Some((it.next()??, it.next()??, it.next().flatten().unwrap_or(0)))
}

pub fn node_version(bin: &Path) -> Option<(u32, u32, u32)> {
    let out = Command::new(bin).arg("--version").stdin(Stdio::null()).output().ok()?;
    parse_version(&String::from_utf8_lossy(&out.stdout))
}

/// The newest Node under a version-manager's tree (`<dir>/<vX.Y.Z>/bin/node`): nvm's layout.
fn newest_versioned_node(dir: &Path) -> Option<PathBuf> {
    let mut best: Option<((u32, u32, u32), PathBuf)> = None;
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(v) = parse_version(&name) else { continue };
        let bin = e.path().join("bin").join("node");
        if bin.is_file() && best.as_ref().map(|(bv, _)| v > *bv).unwrap_or(true) {
            best = Some((v, bin));
        }
    }
    best.map(|(_, p)| p)
}

/// Where installers put binaries, beyond PATH, in the order loki prefers them. A GUI app's PATH is
/// `/usr/bin:/bin:/usr/sbin:/sbin`, so without this list a Homebrew `letta` would never be found.
pub fn bin_dirs(home: &Path, path: Option<&str>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = path.map(|p| std::env::split_paths(p).collect()).unwrap_or_default();
    for d in ["/opt/homebrew/bin", "/usr/local/bin"] {
        dirs.push(PathBuf::from(d));
    }
    for d in [".volta/bin", ".bun/bin", ".npm-global/bin", ".local/bin"] {
        dirs.push(home.join(d));
    }
    if let Some(n) = newest_versioned_node(&home.join(".nvm").join("versions").join("node")) {
        if let Some(d) = n.parent() { dirs.push(d.to_path_buf()); }
    }
    for fnm in [home.join("Library").join("Application Support").join("fnm"), home.join(".local").join("share").join("fnm"), home.join(".fnm")] {
        dirs.push(fnm.join("aliases").join("default").join("bin"));
    }
    dirs.retain(|d| !d.as_os_str().is_empty());
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|d| seen.insert(d.clone()));
    dirs
}

/// A Node that satisfies letta-code (its `bin` directory), wherever it is.
pub fn find_node(home: &Path) -> Option<PathBuf> {
    find_node_in(home, std::env::var("PATH").ok().as_deref())
}

pub fn find_node_in(home: &Path, path: Option<&str>) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = vec![];
    if let Some(p) = std::env::var_os("LOKI_NODE_BIN") {
        candidates.push(PathBuf::from(p));
    }
    candidates.extend(bin_dirs(home, path).into_iter().map(|d| d.join("node")));
    candidates.into_iter().filter(|p| p.is_file()).find(|p| node_version(p).map(|v| v >= NODE_MIN).unwrap_or(false)).and_then(|n| n.parent().map(Path::to_path_buf))
}

/// The Node for a `letta` at `letta`: the one beside it (Homebrew, nvm, fnm, npm's global bin — and volta's
/// shim, which picks its own), else any that satisfies letta-code.
fn node_for(letta: &Path, home: &Path, path: Option<&str>) -> Option<PathBuf> {
    let beside = letta.parent().filter(|d| d.join("node").is_file()).map(Path::to_path_buf);
    beside.or_else(|| find_node_in(home, path))
}

/// The Letta Code loki runs: LOKI_LETTA_BIN, or the first `letta` in `bin_dirs`.
pub fn find_letta(home: &Path) -> Option<Runtime> {
    find_letta_in(home, std::env::var("PATH").ok().as_deref())
}

pub fn find_letta_in(home: &Path, path: Option<&str>) -> Option<Runtime> {
    if let Some(letta) = std::env::var_os("LOKI_LETTA_BIN").map(PathBuf::from).filter(|p| p.is_file()) {
        let node_bin_dir = node_for(&letta, home, path);
        return Some(Runtime { letta, node_bin_dir, explicit: true });
    }
    let letta = bin_dirs(home, path).into_iter().map(|d| d.join("letta")).find(|p| p.is_file())?;
    let node_bin_dir = node_for(&letta, home, path);
    Some(Runtime { letta, node_bin_dir, explicit: false })
}

/// node-pty's prebuild folder suffix (`darwin-arm64`, `darwin-x64`): only the Mac's spawn-helper fix names one.
#[cfg(target_os = "macos")]
pub fn arch() -> &'static str {
    if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" }
}

/// "2026-09-14 06:12:03 UTC" from the system clock, for the install log's headers (no date crate here).
pub fn stamp() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    stamp_of(secs)
}

pub fn stamp_of(secs: u64) -> String {
    let (days, rem) = ((secs / 86400) as i64, secs % 86400);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02} UTC", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[derive(Clone, Debug, Serialize)]
pub struct Progress {
    pub stage: &'static str,
    pub message: String,
}

/// PATH for running `letta` or npm: the runtime's Node first, then the app's own.
pub fn path_for(rt: &Runtime) -> String {
    path_with(rt.node_bin_dir.as_deref())
}

fn path_with(node_bin_dir: Option<&Path>) -> String {
    let base = std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into());
    match node_bin_dir {
        Some(d) => format!("{}:{base}", d.display()),
        None => base,
    }
}

/// What `letta --version` prints, as a bare "0.32.10"; None when it will not run.
pub fn letta_version(rt: &Runtime) -> Option<String> {
    let out = Command::new(&rt.letta).arg("--version").env("PATH", path_for(rt)).env("DISABLE_AUTOUPDATER", "1").stdin(Stdio::null()).output().ok()?;
    if !out.status.success() { return None; }
    String::from_utf8_lossy(&out.stdout).split_whitespace().next().map(|v| v.trim_start_matches('v').to_string())
}

/// The newest release on npm: the registry's `latest` tag.
pub fn latest_version() -> Result<String, String> {
    let body = run(Command::new("/usr/bin/curl").args(["-fsSL", "--max-time", "10", &format!("https://registry.npmjs.org/{PACKAGE}/latest")]), "asking registry.npmjs.org")?;
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| format!("registry reply: {e}"))?;
    v.get("version").and_then(|x| x.as_str()).map(str::to_string).ok_or_else(|| "registry reply had no version".to_string())
}

fn run(cmd: &mut Command, what: &str) -> Result<String, String> {
    let out = cmd.stdin(Stdio::null()).output().map_err(|e| format!("{what}: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("{what} failed: {}", err.lines().last().unwrap_or("").trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// The line for a terminal when npm may not write its global folder (the nodejs.org installer leaves
/// /usr/local/lib/node_modules owned by root). loki never runs sudo itself.
pub fn sudo_line(version: &str) -> String {
    format!("sudo npm install -g {PACKAGE}@{version}")
}

/// npm's last line on failure is "A complete log of this run can be found in: …", and the ones before it name
/// the exit code, the path and the command. The cause is further up: the first `error` line that is none of
/// those (sharp's "Please add node-gyp to your dependencies", node-gyp's own, an ENOTFOUND). That line, then the
/// log path, so the person reading the window has both. A permissions failure adds the sudo line.
pub fn telling_error(errors: &[String], fallback: &str) -> String {
    let boilerplate = |l: &str| ["code ", "path ", "command ", "signal ", "A complete log", "errno ", "syscall ", "network ", "notarget", "404"].iter().any(|p| l.starts_with(p)) || l.is_empty();
    let cause = errors.iter().map(|l| l.trim_start_matches("error").trim()).find(|l| !boilerplate(l));
    let log = errors.iter().map(|l| l.trim_start_matches("error").trim()).find(|l| l.starts_with("A complete log")).and_then(|l| l.split(": ").nth(1));
    let denied = errors.iter().any(|l| l.contains("EACCES") || l.contains("EPERM"));
    let mut out = match (cause, log) {
        (Some(c), Some(l)) => format!("{c} · npm's log: {l}"),
        (Some(c), None) => c.to_string(),
        (None, Some(l)) => format!("{fallback} · npm's log: {l}"),
        (None, None) => fallback.to_string(),
    };
    if denied {
        out = format!("{out} · npm may not write its global folder; in a terminal: {}", sudo_line("latest"));
    }
    out
}

/// Run a package manager to completion, its stderr lines to `report` as they come (npm talks on stderr;
/// the last stdout line is reported at the end for the ones that do not).
fn stream(cmd: &mut Command, stage: &'static str, report: &dyn Fn(Progress)) -> Result<(), String> {
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("could not run {}: {e}", cmd.get_program().to_string_lossy()))?;
    let stdout = child.stdout.take();
    let out_thread = std::thread::spawn(move || {
        let mut lines = vec![];
        if let Some(o) = stdout {
            for l in BufReader::new(o).lines().map_while(Result::ok) {
                lines.push(l);
            }
        }
        lines
    });
    let mut last = String::new();
    let mut errors: Vec<String> = vec![];
    let mut warnings = 0usize;
    if let Some(err) = child.stderr.take() {
        for line in BufReader::new(err).lines().map_while(Result::ok) {
            let t = line.trim();
            // npm's info lines: "npm info run sharp@… postinstall", "npm http fetch GET 200 …" — keep the readable ones.
            if t.is_empty() || t.starts_with("npm http") || t.starts_with("npm timing") || t.starts_with("npm verbose") { continue; }
            // Its warnings — sixty-odd lines of peer-dependency and deprecation notes for letta-code — would fill
            // Welcome's pane and mean nothing to the person watching; counted, then summed up in one line.
            if t.starts_with("npm warn") || t.starts_with("npm WARN") { warnings += 1; continue; }
            last = t.to_string();
            let message = t.trim_start_matches("npm ").to_string();
            if message.starts_with("error") || message.starts_with("ERR!") { errors.push(message.clone()); }
            report(Progress { stage, message });
        }
    }
    if warnings > 0 { report(Progress { stage, message: format!("{warnings} npm warning line{} not shown (peer dependencies, deprecations; npm's own log has them)", if warnings == 1 { "" } else { "s" }) }); }
    let status = child.wait().map_err(|e| e.to_string())?;
    let out = out_thread.join().unwrap_or_default();
    if let Some(l) = out.iter().rev().find(|l| !l.trim().is_empty()) {
        report(Progress { stage, message: l.trim().to_string() });
        if last.is_empty() { last = l.trim().to_string(); }
    }
    if !status.success() {
        return Err(format!("{} failed: {}", cmd.get_program().to_string_lossy(), telling_error(&errors, &last)));
    }
    Ok(())
}

/// Install Letta Code with npm, at the newest release. Blocking; minutes. `report` gets one line per step and per npm line.
pub fn install(home: &Path, report: &dyn Fn(Progress)) -> Result<Runtime, String> {
    install_version(home, "latest", report)
}

/// `npm install -g @letta-ai/letta-code@<version>` ("latest" or a number) with the npm beside the Node loki
/// would run it with, into npm's global folder — the same place a terminal's `npm install -g` writes.
pub fn install_version(home: &Path, version: &str, report: &dyn Fn(Progress)) -> Result<Runtime, String> {
    let Some(node_bin_dir) = find_node(home) else {
        return Err(format!("no Node {}.{} or newer on this Mac — `brew install node` (the Homebrew cask brings it), then retry", NODE_MIN.0, NODE_MIN.1));
    };
    report(Progress { stage: "node", message: format!("using Node at {}", node_bin_dir.join("node").display()) });
    let npm = node_bin_dir.join("npm");
    if !npm.is_file() {
        return Err(format!("no npm beside {} — install Node with Homebrew (`brew install node`) or nodejs.org, then retry", node_bin_dir.join("node").display()));
    }
    let path = path_with(Some(&node_bin_dir));
    report(Progress { stage: "letta", message: format!("npm install -g {PACKAGE}@{version} (a few minutes)") });
    stream(
        Command::new(&npm)
            .args(["install", "-g", &format!("{PACKAGE}@{version}"), "--no-fund", "--no-audit", "--loglevel", "info"])
            .env("PATH", &path)
            .env("CI", "1")
            .env("npm_config_update_notifier", "false")
            // letta-code depends on sharp, whose install step compiles it from source with node-gyp whenever a
            // libvips is installed on the Mac (Homebrew's, through pkg-config) — and fails on a Mac without
            // node-gyp, taking the whole install with it. The prebuilt binary sharp ships is what we want.
            .env("SHARP_IGNORE_GLOBAL_LIBVIPS", "1"),
        "letta",
        report,
    )?;
    // Where npm put it: its global prefix (volta's shim answers for its own image), else wherever discovery finds one now.
    let prefix = run(Command::new(&npm).args(["prefix", "-g"]).env("PATH", &path), "npm prefix -g").ok().map(|s| PathBuf::from(s.trim()));
    let from_prefix = prefix.as_ref().map(|p| p.join("bin").join("letta")).filter(|p| p.is_file());
    let letta = match from_prefix {
        Some(p) => p,
        None => find_letta(home).map(|rt| rt.letta).ok_or("npm finished but no `letta` turned up where it installs to")?,
    };
    // letta-code's post-install marks node-pty's spawn-helper executable for darwin-arm64 only; the darwin-x64
    // copy ships read-only, and on an Intel Mac every pty the harness opens would fail.
    #[cfg(target_os = "macos")]
    if let Some(prefix) = &prefix {
        let helper = prefix.join("lib").join("node_modules").join(PACKAGE).join("node_modules").join("node-pty").join("prebuilds").join(format!("darwin-{}", arch())).join("spawn-helper");
        match mark_executable(&helper) {
            Ok(true) => report(Progress { stage: "letta", message: format!("made node-pty's spawn-helper executable for darwin-{}", arch()) }),
            Ok(false) => {}
            Err(e) => report(Progress { stage: "letta", message: format!("could not mark {} executable: {e}", helper.display()) }),
        }
    }
    let rt = Runtime { node_bin_dir: node_for(&letta, home, std::env::var("PATH").ok().as_deref()).or(Some(node_bin_dir)), letta, explicit: false };
    let v = letta_version(&rt).ok_or_else(|| format!("{} was installed but `letta --version` would not run", rt.letta.display()))?;
    report(Progress { stage: "done", message: format!("Letta Code {v} installed at {}", rt.letta.display()) });
    Ok(rt)
}

/// chmod 755 on `path` when it exists and lacks the owner's execute bit; Ok(true) when it changed.
/// Only the Mac's node-pty prebuilds need it (above), so only the Mac has it.
#[cfg(target_os = "macos")]
pub fn mark_executable(path: &Path) -> std::io::Result<bool> {
    use std::os::unix::fs::PermissionsExt;
    let Ok(meta) = std::fs::metadata(path) else { return Ok(false) };
    if !meta.is_file() || meta.permissions().mode() & 0o100 != 0 { return Ok(false); }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))?;
    Ok(true)
}

/// What Settings and Welcome show.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Status {
    pub letta: Option<String>,
    pub node: Option<String>,
    /// Named by LOKI_LETTA_BIN: not npm's to update.
    pub explicit: bool,
    /// An install or update is running (`log` has its lines).
    pub installing: bool,
    pub error: Option<String>,
    pub log: Vec<String>,
    /// `letta --version`, once Settings asked (check_letta_update).
    pub version: Option<String>,
    /// The newest release on npm, once asked.
    pub latest: Option<String>,
    /// loki started this harness and can restart it — the update button's precondition.
    pub managed: bool,
}

impl Status {
    pub fn from_runtime(rt: &Runtime) -> Status {
        Status { letta: Some(rt.letta.display().to_string()), node: rt.node_bin_dir.as_ref().map(|d| d.join("node").display().to_string()), explicit: rt.explicit, ..Status::default() }
    }
    /// The runtime these paths describe, for running `letta` again.
    pub fn runtime(&self) -> Option<Runtime> {
        let letta = PathBuf::from(self.letta.as_ref()?);
        Some(Runtime { letta, node_bin_dir: self.node.as_ref().map(PathBuf::from).and_then(|n| n.parent().map(Path::to_path_buf)), explicit: self.explicit })
    }
}

pub struct BootstrapState(pub std::sync::Mutex<Status>);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_parse_and_compare() {
        assert_eq!(parse_version("v22.23.2\n"), Some((22, 23, 2)));
        assert_eq!(parse_version("0.32.10 (Letta Code)"), Some((0, 32, 10)));
        assert_eq!(parse_version("nope"), None);
        assert!(parse_version("v22.19.0").unwrap() >= NODE_MIN);
        assert!(parse_version("v20.19.0").unwrap() < NODE_MIN);
        assert!(parse_version("v26.8.2").unwrap() >= NODE_MIN);
    }

    #[test]
    fn the_telling_error_is_the_cause_not_npm_s_footer() {
        let errors: Vec<String> = [
            "error code 1",
            "error path /opt/homebrew/lib/node_modules/@letta-ai/letta-code/node_modules/sharp",
            "error command failed",
            "error command sh -c node install/check.js || npm run build",
            "error sharp: Attempting to build from source via node-gyp",
            "error sharp: Please add node-gyp to your dependencies",
            "error A complete log of this run can be found in: /Users/x/.npm/_logs/2026-09-13T15_06_11_003Z-debug-0.log",
        ].iter().map(|s| s.to_string()).collect();
        assert_eq!(telling_error(&errors, "last line"), "sharp: Attempting to build from source via node-gyp · npm's log: /Users/x/.npm/_logs/2026-09-13T15_06_11_003Z-debug-0.log");
        assert_eq!(telling_error(&[], "last line"), "last line");
        let only_footer: Vec<String> = vec!["error code ENOTFOUND".into(), "error A complete log of this run can be found in: /l.log".into()];
        assert_eq!(telling_error(&only_footer, "npm error network request failed"), "npm error network request failed · npm's log: /l.log");
    }

    #[test]
    fn a_root_owned_global_folder_gets_the_sudo_line() {
        let errors: Vec<String> = ["error code EACCES", "error syscall mkdir", "error path /usr/local/lib/node_modules/@letta-ai", "error errno -13", "error Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/@letta-ai'"].iter().map(|s| s.to_string()).collect();
        let msg = telling_error(&errors, "last");
        assert!(msg.starts_with("Error: EACCES: permission denied"), "{msg}");
        assert!(msg.ends_with(&sudo_line("latest")), "{msg}");
        assert_eq!(sudo_line("latest"), "sudo npm install -g @letta-ai/letta-code@latest");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn marks_a_read_only_helper_executable_once() {
        use std::os::unix::fs::PermissionsExt;
        let p = std::env::temp_dir().join(format!("loki-spawn-helper-{}", std::process::id()));
        std::fs::write(&p, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(mark_executable(&p).unwrap(), true);
        assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o755);
        assert_eq!(mark_executable(&p).unwrap(), false);
        assert_eq!(mark_executable(&p.join("nowhere")).unwrap(), false);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn stamps_are_civil_utc() {
        assert_eq!(stamp_of(0), "1970-01-01 00:00:00 UTC");
        assert_eq!(stamp_of(1789000000), "2026-09-10 00:26:40 UTC");
        assert_eq!(stamp_of(951782400), "2000-02-29 00:00:00 UTC");
    }

    #[test]
    fn status_round_trips_to_a_runtime() {
        let rt = Runtime { letta: PathBuf::from("/opt/homebrew/bin/letta"), node_bin_dir: Some(PathBuf::from("/opt/homebrew/bin")), explicit: false };
        let back = Status::from_runtime(&rt).runtime().unwrap();
        assert_eq!(back.letta, rt.letta);
        assert_eq!(back.node_bin_dir, rt.node_bin_dir);
        assert!(!back.explicit);
    }

    fn fake_home() -> PathBuf {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let home = std::env::temp_dir().join(format!("loki-boot-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        home
    }
    fn touch(p: &Path) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, "#!/bin/sh\n").unwrap();
    }

    #[test]
    fn looks_where_installers_put_things_path_first() {
        let home = fake_home();
        // PATH joined the platform's way (`;` on Windows, `:` elsewhere), as the shell receives it.
        let path = std::env::join_paths([PathBuf::from("/x/bin"), PathBuf::from("/opt/homebrew/bin")]).unwrap();
        let dirs = bin_dirs(&home, path.to_str());
        assert_eq!(dirs[0], PathBuf::from("/x/bin"));
        assert_eq!(dirs[1], PathBuf::from("/opt/homebrew/bin"), "PATH's own Homebrew comes first and is not repeated");
        assert_eq!(dirs.iter().filter(|d| **d == PathBuf::from("/opt/homebrew/bin")).count(), 1);
        assert!(dirs.contains(&PathBuf::from("/usr/local/bin")));
        assert!(dirs.contains(&home.join(".volta").join("bin")));
        assert!(dirs.contains(&home.join(".bun").join("bin")));
        assert!(dirs.contains(&home.join("Library").join("Application Support").join("fnm").join("aliases").join("default").join("bin")));
        // nvm: the newest version's bin, only when it exists
        assert!(!dirs.iter().any(|d| d.to_string_lossy().contains(".nvm")));
        touch(&home.join(".nvm/versions/node/v22.1.0/bin/node"));
        touch(&home.join(".nvm/versions/node/v24.3.0/bin/node"));
        let dirs = bin_dirs(&home, Some(""));
        assert!(dirs.contains(&home.join(".nvm/versions/node/v24.3.0/bin")));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn finds_the_machines_letta_and_the_node_beside_it() {
        let home = fake_home();
        // Nothing on a bare PATH, nothing in the home: none (LOKI_LETTA_BIN on a dev machine excepted).
        if std::env::var_os("LOKI_LETTA_BIN").is_none() {
            assert!(find_letta_in(&home, Some(home.join("empty").to_str().unwrap())).is_none() || PathBuf::from("/opt/homebrew/bin/letta").is_file() || PathBuf::from("/usr/local/bin/letta").is_file());
        }
        // A volta-style install: letta and node shims side by side.
        let letta = home.join(".volta/bin/letta");
        touch(&letta);
        touch(&home.join(".volta/bin/node"));
        // A bare PATH so only the home's folders count (a real Homebrew letta on this Mac would come first otherwise).
        let path = home.join("empty");
        std::fs::create_dir_all(&path).unwrap();
        if std::env::var_os("LOKI_LETTA_BIN").is_none() && !PathBuf::from("/opt/homebrew/bin/letta").is_file() && !PathBuf::from("/usr/local/bin/letta").is_file() {
            let rt = find_letta_in(&home, path.to_str()).unwrap();
            assert_eq!(rt.letta, letta);
            assert_eq!(rt.node_bin_dir, Some(home.join(".volta/bin")), "the node beside letta, whatever its version — volta's shim picks the real one");
            assert!(!rt.explicit);
        }
        let _ = std::fs::remove_dir_all(&home);
    }
}
