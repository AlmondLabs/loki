//! loki's own copy of Letta Code: found under ~/.letta/loki/runtime, or installed there.
//!
//! Release builds run only that copy — never a `letta` the user installed, so nothing loki does can
//! touch theirs and nothing they do can change what loki runs. When it is missing, loki installs it:
//! its own Node if the machine has no Node 22, then `npm install -g --prefix <data>/runtime/letta
//! @letta-ai/letta-code@<pinned>`. Nothing outside that directory is written; the user's shell,
//! Homebrew and npm are untouched. Downloads: nodejs.org (tarball, checked against SHASUMS256.txt)
//! and registry.npmjs.org. Development builds behave the same; LOKI_LETTA_BIN names a binary outright
//! (a Letta Code checkout, say) and is the only way to run anything else.
//!
//! Updating is manual (Settings › letta): `latest_version` asks the registry, `install_version` reinstalls
//! the copy at `latest`. The harness never updates itself (harness.rs sets DISABLE_AUTOUPDATER).

use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// The Letta Code release loki was tested with (core/compat.ts carries the same number).
pub const LETTA_CODE_VERSION: &str = "0.31.12";
pub const PACKAGE: &str = "@letta-ai/letta-code";
/// letta-code's engines.node.
pub const NODE_MIN: (u32, u32, u32) = (22, 19, 0);
const NODE_DIST: &str = "https://nodejs.org/dist/latest-v22.x/";

/// Where the harness runs from, and what it needs on PATH.
#[derive(Clone, Debug)]
pub struct Runtime {
    pub letta: PathBuf,
    /// A directory holding `node` (and `npm`) to prepend to PATH: the `letta` shim is `#!/usr/bin/env node`.
    pub node_bin_dir: Option<PathBuf>,
    /// loki's own copy, under ~/.letta/loki/runtime.
    pub private: bool,
}

pub fn runtime_root(data: &Path) -> PathBuf {
    data.join("runtime")
}
fn private_letta(data: &Path) -> PathBuf {
    runtime_root(data).join("letta").join("bin").join("letta")
}
fn private_node_bin(data: &Path) -> PathBuf {
    runtime_root(data).join("node").join("bin")
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

fn newest_nvm_node(home: &Path) -> Option<PathBuf> {
    let dir = home.join(".nvm").join("versions").join("node");
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

/// A Node that satisfies letta-code, wherever it is; loki's private one counts too.
pub fn find_node(home: &Path, data: &Path) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = vec![];
    if let Some(p) = std::env::var_os("LOKI_NODE_BIN") {
        candidates.push(PathBuf::from(p));
    }
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|d| d.join("node")));
    }
    // LOKI_NO_SYSTEM_NODE: tests only — behave like a Mac with no Node anywhere.
    if std::env::var_os("LOKI_NO_SYSTEM_NODE").is_none() {
        candidates.push(home.join(".volta").join("bin").join("node"));
        if let Some(p) = newest_nvm_node(home) {
            candidates.push(p);
        }
        candidates.push(PathBuf::from("/opt/homebrew/bin/node"));
        candidates.push(PathBuf::from("/usr/local/bin/node"));
    }
    candidates.push(private_node_bin(data).join("node"));
    candidates.into_iter().filter(|p| p.is_file()).find(|p| node_version(p).map(|v| v >= NODE_MIN).unwrap_or(false))
}

/// The one binary a build may run besides loki's own copy: whatever LOKI_LETTA_BIN names, explicitly.
fn foreign_letta() -> Option<PathBuf> {
    std::env::var_os("LOKI_LETTA_BIN").map(PathBuf::from).filter(|p| p.is_file())
}

/// The Letta Code loki runs: its own copy under `data`/runtime, in every build — or the binary LOKI_LETTA_BIN names.
pub fn find_letta(home: &Path, data: &Path) -> Option<Runtime> {
    if let Some(letta) = foreign_letta() {
        return Some(Runtime { letta, node_bin_dir: find_node(home, data).and_then(|n| n.parent().map(Path::to_path_buf)), private: false });
    }
    let p = private_letta(data);
    if p.is_file() {
        let node = if private_node_bin(data).join("node").is_file() { Some(private_node_bin(data)) } else { find_node(home, data).and_then(|n| n.parent().map(Path::to_path_buf)) };
        return Some(Runtime { letta: p, node_bin_dir: node, private: true });
    }
    None
}

pub fn arch() -> &'static str {
    if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" }
}

/// From nodejs.org's SHASUMS256.txt: the checksum and file name of the macOS tarball for `arch`.
pub fn pick_tarball(shasums: &str, arch: &str) -> Option<(String, String)> {
    let suffix = format!("-darwin-{arch}.tar.gz");
    shasums.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let sha = parts.next()?;
        let file = parts.next()?;
        (file.starts_with("node-v") && file.ends_with(&suffix)).then(|| (sha.to_string(), file.to_string()))
    })
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

/// PATH for running `letta` or a package manager: the runtime's Node first, then the app's own.
fn path_for(rt: &Runtime) -> String {
    let base = std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into());
    match &rt.node_bin_dir {
        Some(d) => format!("{}:{base}", d.display()),
        None => base,
    }
}

/// What `letta --version` prints, as a bare "0.31.12"; None when it will not run.
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

fn download_node(data: &Path, report: &dyn Fn(Progress)) -> Result<PathBuf, String> {
    let root = runtime_root(data);
    let tmp = root.join("tmp");
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    report(Progress { stage: "node", message: "asking nodejs.org for the current Node 22".into() });
    let shasums = run(Command::new("/usr/bin/curl").args(["-fsSL", &format!("{NODE_DIST}SHASUMS256.txt")]), "fetching SHASUMS256.txt")?;
    let (sha, file) = pick_tarball(&shasums, arch()).ok_or("no macOS tarball listed for this architecture")?;
    let tarball = tmp.join(&file);
    report(Progress { stage: "node", message: format!("downloading {file}") });
    run(Command::new("/usr/bin/curl").args(["-fsSL", "-o"]).arg(&tarball).arg(format!("{NODE_DIST}{file}")), "downloading Node")?;
    let sum = run(Command::new("/usr/bin/shasum").args(["-a", "256"]).arg(&tarball), "checking the download")?;
    if sum.split_whitespace().next() != Some(sha.as_str()) {
        let _ = std::fs::remove_file(&tarball);
        return Err("Node download did not match its published checksum".into());
    }
    let dest = root.join("node");
    let _ = std::fs::remove_dir_all(&dest);
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    report(Progress { stage: "node", message: "unpacking Node".into() });
    run(Command::new("/usr/bin/tar").args(["-xzf"]).arg(&tarball).args(["--strip-components=1", "-C"]).arg(&dest), "unpacking Node")?;
    let _ = std::fs::remove_dir_all(&tmp);
    let bin = dest.join("bin");
    if !bin.join("node").is_file() {
        return Err("Node unpacked without a node binary".into());
    }
    Ok(bin)
}

/// Install Letta Code privately at the tested release. Blocking; minutes. `report` gets one line per step and per npm line.
pub fn install(data: &Path, home: &Path, report: &dyn Fn(Progress)) -> Result<Runtime, String> {
    install_version(data, home, LETTA_CODE_VERSION, report)
}

/// npm's last line on failure is "A complete log of this run can be found in: …", and the ones before it name
/// the exit code, the path and the command. The cause is further up: the first `error` line that is none of
/// those (sharp's "Please add node-gyp to your dependencies", node-gyp's own, an ENOTFOUND). That line, then the
/// log path, so the person reading the window has both.
pub fn telling_error(errors: &[String], fallback: &str) -> String {
    let boilerplate = |l: &str| ["code ", "path ", "command ", "signal ", "A complete log", "errno ", "syscall ", "network ", "notarget", "404"].iter().any(|p| l.starts_with(p)) || l.is_empty();
    let cause = errors.iter().map(|l| l.trim_start_matches("error").trim()).find(|l| !boilerplate(l));
    let log = errors.iter().map(|l| l.trim_start_matches("error").trim()).find(|l| l.starts_with("A complete log")).and_then(|l| l.split(": ").nth(1));
    match (cause, log) {
        (Some(c), Some(l)) => format!("{c} · npm's log: {l}"),
        (Some(c), None) => c.to_string(),
        (None, Some(l)) => format!("{fallback} · npm's log: {l}"),
        (None, None) => fallback.to_string(),
    }
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
    if let Some(err) = child.stderr.take() {
        for line in BufReader::new(err).lines().map_while(Result::ok) {
            let t = line.trim();
            // npm's info lines: "npm info run sharp@… postinstall", "npm http fetch GET 200 …" — keep the readable ones.
            if t.is_empty() || t.starts_with("npm http") || t.starts_with("npm timing") || t.starts_with("npm verbose") { continue; }
            last = t.to_string();
            let message = t.trim_start_matches("npm ").to_string();
            if message.starts_with("error") || message.starts_with("ERR!") { errors.push(message.clone()); }
            report(Progress { stage, message });
        }
    }
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

/// Install (or reinstall) Letta Code privately at `version` — a number or "latest".
pub fn install_version(data: &Path, home: &Path, version: &str, report: &dyn Fn(Progress)) -> Result<Runtime, String> {
    let node_bin_dir = match find_node(home, data) {
        Some(n) => {
            report(Progress { stage: "node", message: format!("using Node at {}", n.display()) });
            n.parent().map(Path::to_path_buf).ok_or("node has no parent directory")?
        }
        None => download_node(data, report)?,
    };
    let prefix = runtime_root(data).join("letta");
    std::fs::create_dir_all(&prefix).map_err(|e| e.to_string())?;
    let path = format!("{}:{}", node_bin_dir.display(), std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into()));
    report(Progress { stage: "letta", message: format!("npm install {PACKAGE}@{version} (a few minutes)") });
    let npm = node_bin_dir.join("npm");
    stream(
        Command::new(&npm)
            .args(["install", "-g", "--prefix"])
            .arg(&prefix)
            .arg(format!("{PACKAGE}@{version}"))
            .args(["--no-fund", "--no-audit", "--loglevel", "info"])
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
    let letta = prefix.join("bin").join("letta");
    if !letta.is_file() {
        return Err("npm finished but bin/letta is missing".into());
    }
    let v = run(Command::new(&letta).arg("--version").env("PATH", &path), "letta --version")?;
    report(Progress { stage: "done", message: format!("Letta Code {} installed", v.trim()) });
    Ok(Runtime { letta, node_bin_dir: Some(node_bin_dir), private: true })
}

/// What Settings and Welcome show.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Status {
    pub letta: Option<String>,
    pub node: Option<String>,
    pub private: bool,
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
        Status { letta: Some(rt.letta.display().to_string()), node: rt.node_bin_dir.as_ref().map(|d| d.join("node").display().to_string()), private: rt.private, ..Status::default() }
    }
    /// The runtime these paths describe, for running `letta` again.
    pub fn runtime(&self) -> Option<Runtime> {
        let letta = PathBuf::from(self.letta.as_ref()?);
        Some(Runtime { letta, node_bin_dir: self.node.as_ref().map(PathBuf::from).and_then(|n| n.parent().map(Path::to_path_buf)), private: self.private })
    }
}

pub struct BootstrapState(pub std::sync::Mutex<Status>);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_parse_and_compare() {
        assert_eq!(parse_version("v22.23.2\n"), Some((22, 23, 2)));
        assert_eq!(parse_version("0.31.12 (Letta Code)"), Some((0, 31, 12)));
        assert_eq!(parse_version("nope"), None);
        assert!(parse_version("v22.19.0").unwrap() >= NODE_MIN);
        assert!(parse_version("v20.19.0").unwrap() < NODE_MIN);
    }

    #[test]
    fn the_telling_error_is_the_cause_not_npm_s_footer() {
        let errors: Vec<String> = [
            "error code 1",
            "error path /Users/x/.letta/loki/runtime/letta/lib/node_modules/@letta-ai/letta-code/node_modules/sharp",
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
    fn stamps_are_civil_utc() {
        assert_eq!(stamp_of(0), "1970-01-01 00:00:00 UTC");
        assert_eq!(stamp_of(1789000000), "2026-09-10 00:26:40 UTC");
        assert_eq!(stamp_of(951782400), "2000-02-29 00:00:00 UTC");
    }

    #[test]
    fn status_round_trips_to_a_runtime() {
        let rt = Runtime { letta: PathBuf::from("/x/letta/bin/letta"), node_bin_dir: Some(PathBuf::from("/x/node/bin")), private: true };
        let back = Status::from_runtime(&rt).runtime().unwrap();
        assert_eq!(back.letta, rt.letta);
        assert_eq!(back.node_bin_dir, rt.node_bin_dir);
        assert!(back.private);
    }

    #[test]
    fn picks_the_tarball_for_the_arch() {
        let shasums = "aaa  node-v22.23.2-darwin-arm64.tar.gz\nbbb  node-v22.23.2-darwin-x64.tar.gz\nccc  node-v22.23.2-linux-x64.tar.gz\nddd  node-v22.23.2-darwin-arm64.tar.xz\n";
        assert_eq!(pick_tarball(shasums, "arm64"), Some(("aaa".into(), "node-v22.23.2-darwin-arm64.tar.gz".into())));
        assert_eq!(pick_tarball(shasums, "x64"), Some(("bbb".into(), "node-v22.23.2-darwin-x64.tar.gz".into())));
        assert_eq!(pick_tarball(shasums, "riscv"), None);
        assert!(matches!(arch(), "arm64" | "x64"));
    }

    /// The real thing, against the network: `cargo test -- --ignored install_for_real`. Minutes; ~450 MB.
    #[test]
    #[ignore]
    fn install_for_real() {
        let root = std::env::temp_dir().join(format!("loki-boot-real-{}", std::process::id()));
        let data = root.join("data");
        let home = root.join("home");
        std::fs::create_dir_all(&home).unwrap();
        // A bare PATH: no node, no letta, so both get installed privately.
        std::env::set_var("PATH", "/usr/bin:/bin");
        std::env::remove_var("LOKI_NODE_BIN");
        std::env::remove_var("LOKI_LETTA_BIN");
        std::env::set_var("LOKI_NO_SYSTEM_NODE", "1");
        assert!(find_node(&home, &data).is_none(), "a node on the bare PATH?");
        let rt = install(&data, &home, &|p| eprintln!("[{}] {}", p.stage, p.message)).expect("install");
        assert!(rt.private);
        assert!(rt.letta.is_file());
        let node_dir = rt.node_bin_dir.clone().unwrap();
        assert!(node_dir.join("node").is_file() && node_dir.join("npm").is_file());
        // Discovery now finds the private copy.
        let again = find_letta(&home, &data).unwrap();
        assert_eq!(again.letta, rt.letta);
        assert!(again.private);
        // And it answers as the pinned release.
        let out = Command::new(&rt.letta).arg("--version").env("PATH", format!("{}:/usr/bin:/bin", node_dir.display())).output().unwrap();
        assert!(String::from_utf8_lossy(&out.stdout).contains(LETTA_CODE_VERSION));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn private_layout_and_discovery() {
        let root = std::env::temp_dir().join(format!("loki-boot-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let data = root.join("data");
        let home = root.join("home");
        std::fs::create_dir_all(&home).unwrap();
        // Nothing anywhere: no runtime (PATH may carry a real letta on a dev machine; only assert the private branch).
        let p = private_letta(&data);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, "#!/bin/sh\n").unwrap();
        let found = find_letta(&home, &data).unwrap();
        // The private copy, whatever is on PATH (only LOKI_LETTA_BIN could say otherwise).
        assert!(found.letta == p || std::env::var_os("LOKI_LETTA_BIN").is_some());
        assert!(found.private || std::env::var_os("LOKI_LETTA_BIN").is_some());
        assert_eq!(runtime_root(&data), data.join("runtime"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
