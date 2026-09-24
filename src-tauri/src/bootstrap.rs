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

pub type Version = (u32, u32, u32);

/// The system whose layout discovery follows. The machine's own in the app (`Os::HOST`); any, in tests, so
/// the Windows and Linux layouts are checked on every machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Os {
    Macos,
    Windows,
    Linux,
}

impl Os {
    pub const HOST: Os = if cfg!(windows) { Os::Windows } else if cfg!(target_os = "macos") { Os::Macos } else { Os::Linux };

    /// The file names a program goes by: npm's `.cmd` shims and real `.exe`s on Windows, the bare name elsewhere.
    fn names(self, program: &str) -> Vec<String> {
        match (self, program) {
            (Os::Windows, "node") => vec!["node.exe".into()],
            (Os::Windows, "npm") => vec!["npm.cmd".into()],
            (Os::Windows, p) => vec![format!("{p}.cmd"), format!("{p}.exe")],
            (_, p) => vec![p.into()],
        }
    }

    fn path_separator(self) -> char {
        if self == Os::Windows { ';' } else { ':' }
    }
}

/// Where discovery looks, and with what: the system, the home, PATH, the environment and the way a Node's
/// version is read. `Host::this` is the machine loki runs on, read afresh at each call — paths are never
/// cached, so a Node installed while Welcome waits is found by the next look.
pub struct Host {
    pub os: Os,
    pub home: PathBuf,
    /// What the system's absolute folders (`/usr/local/bin`) hang from: `/`, except in tests.
    pub root: PathBuf,
    pub path: Option<String>,
    pub var: Box<dyn Fn(&str) -> Option<std::ffi::OsString>>,
    pub version: Box<dyn Fn(&Path) -> Option<Version>>,
}

impl Host {
    pub fn this(home: &Path) -> Host {
        Host::with_path(home, std::env::var("PATH").ok())
    }

    fn with_path(home: &Path, path: Option<String>) -> Host {
        Host { os: Os::HOST, home: home.to_path_buf(), root: PathBuf::from("/"), path, var: Box::new(|k| std::env::var_os(k)), version: Box::new(node_version) }
    }

    /// An environment folder, when set and not empty.
    fn dir(&self, key: &str) -> Option<PathBuf> {
        (self.var)(key).filter(|v| !v.is_empty()).map(PathBuf::from)
    }

    /// The first of `program`'s names that is a file in `dir`.
    fn program_in(&self, dir: &Path, program: &str) -> Option<PathBuf> {
        self.os.names(program).into_iter().map(|n| dir.join(n)).find(|p| p.is_file())
    }
}

pub fn node_version(bin: &Path) -> Option<Version> {
    let out = quiet(Command::new(bin).arg("--version")).stdin(Stdio::null()).output().ok()?;
    parse_version(&String::from_utf8_lossy(&out.stdout))
}

/// No console window for a program started from the GUI on Windows (npm's `.cmd` shims would each open one);
/// nothing elsewhere.
pub fn quiet(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }
    cmd
}

/// The newest version folder under a version manager's tree (`<dir>/<vX.Y.Z>/…`) whose Node is at `node(folder)`:
/// nvm's `<v>/bin/node`, nvm-windows' `<v>\node.exe`. The folder holding that Node.
fn newest_versioned_node(dir: &Path, node: impl Fn(&Path) -> Option<PathBuf>) -> Option<PathBuf> {
    let mut best: Option<(Version, PathBuf)> = None;
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(v) = parse_version(&name) else { continue };
        let Some(bin) = node(&e.path()) else { continue };
        if best.as_ref().map(|(bv, _)| v > *bv).unwrap_or(true) {
            best = Some((v, bin));
        }
    }
    best.and_then(|(_, p)| p.parent().map(Path::to_path_buf))
}

/// Where installers put binaries, beyond PATH, in the order loki prefers them. A GUI app's PATH is
/// `/usr/bin:/bin:/usr/sbin:/sbin`, so without this list a Homebrew `letta` would never be found.
#[cfg(test)]
pub fn bin_dirs(home: &Path, path: Option<&str>) -> Vec<PathBuf> {
    bin_dirs_for(&Host::with_path(home, path.map(str::to_string)))
}

/// `bin_dirs` for any system. The Mac's list is the one it always was; Linux swaps Homebrew for the
/// distribution's folders; Windows has its own (npm's global folder, the nodejs.org installer's, volta,
/// nvm-windows, fnm, scoop), from the environment where Windows keeps them.
pub fn bin_dirs_for(h: &Host) -> Vec<PathBuf> {
    let home = &h.home;
    let mut dirs: Vec<PathBuf> = h.path.as_deref().map(|p| p.split(h.os.path_separator()).map(PathBuf::from).collect()).unwrap_or_default();
    match h.os {
        Os::Macos | Os::Linux => {
            let system: &[&str] = if h.os == Os::Macos { &["opt/homebrew/bin", "usr/local/bin"] } else { &["usr/local/bin", "usr/bin", "home/linuxbrew/.linuxbrew/bin"] };
            dirs.extend(system.iter().map(|d| h.root.join(d)));
            for d in [".volta/bin", ".bun/bin", ".npm-global/bin", ".local/bin"] {
                dirs.push(home.join(d));
            }
            if let Some(d) = newest_versioned_node(&home.join(".nvm").join("versions").join("node"), |v| h.program_in(&v.join("bin"), "node")) {
                dirs.push(d);
            }
            let mut fnm = vec![home.join(".local").join("share").join("fnm"), home.join(".fnm")];
            if h.os == Os::Macos { fnm.insert(0, home.join("Library").join("Application Support").join("fnm")); }
            for f in fnm {
                dirs.push(f.join("aliases").join("default").join("bin"));
            }
        }
        Os::Windows => {
            let roaming = h.dir("APPDATA").unwrap_or_else(|| home.join("AppData").join("Roaming"));
            let local = h.dir("LOCALAPPDATA").unwrap_or_else(|| home.join("AppData").join("Local"));
            dirs.push(roaming.join("npm"));
            dirs.extend(h.dir("ProgramFiles").map(|p| p.join("nodejs")));
            dirs.push(local.join("Volta").join("bin"));
            // nvm-windows: the active version's link, then the newest version it keeps.
            dirs.extend(h.dir("NVM_SYMLINK"));
            if let Some(d) = newest_versioned_node(&h.dir("NVM_HOME").unwrap_or_else(|| roaming.join("nvm")), |v| h.program_in(v, "node")) {
                dirs.push(d);
            }
            for f in [h.dir("FNM_DIR"), Some(roaming.join("fnm")), Some(local.join("fnm"))].into_iter().flatten() {
                dirs.push(f.join("aliases").join("default"));
            }
            let scoop = h.dir("SCOOP").unwrap_or_else(|| home.join("scoop"));
            dirs.push(scoop.join("shims"));
            for app in ["nodejs", "nodejs-lts"] {
                dirs.push(scoop.join("apps").join(app).join("current"));
                dirs.push(scoop.join("persist").join(app).join("bin"));
            }
            dirs.push(home.join(".bun").join("bin"));
        }
    }
    dirs.retain(|d| !d.as_os_str().is_empty());
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|d| seen.insert(d.clone()));
    dirs
}

/// A Node that satisfies letta-code (its `bin` directory), wherever it is.
pub fn find_node(home: &Path) -> Option<PathBuf> {
    find_node_for(&Host::this(home)).ok()
}

/// The folder of the first Node 22.19+ (LOKI_NODE_BIN, then `bin_dirs_for`); else the newest older one seen, if any.
pub fn find_node_for(h: &Host) -> Result<PathBuf, Option<(Version, PathBuf)>> {
    let mut candidates: Vec<PathBuf> = h.dir("LOKI_NODE_BIN").into_iter().collect();
    for d in bin_dirs_for(h) {
        candidates.extend(h.os.names("node").into_iter().map(|n| d.join(n)));
    }
    let mut old: Option<(Version, PathBuf)> = None;
    for p in candidates.into_iter().filter(|p| p.is_file()) {
        let Some(v) = (h.version)(&p) else { continue };
        if v >= NODE_MIN {
            if let Some(d) = p.parent() { return Ok(d.to_path_buf()); }
        } else if old.as_ref().map(|(ov, _)| v > *ov).unwrap_or(true) {
            old = Some((v, p));
        }
    }
    Err(old)
}

/// The Node for a `letta` at `letta`: the one beside it (Homebrew, nvm, fnm, npm's global bin — and volta's
/// shim, which picks its own), else any that satisfies letta-code.
fn node_for(letta: &Path, h: &Host) -> Option<PathBuf> {
    let beside = letta.parent().filter(|d| h.program_in(d, "node").is_some()).map(Path::to_path_buf);
    beside.or_else(|| find_node_for(h).ok())
}

/// The Letta Code loki runs: LOKI_LETTA_BIN, or the first `letta` in `bin_dirs`.
pub fn find_letta(home: &Path) -> Option<Runtime> {
    find_letta_for(&Host::this(home))
}

#[cfg(test)]
pub fn find_letta_in(home: &Path, path: Option<&str>) -> Option<Runtime> {
    find_letta_for(&Host::with_path(home, path.map(str::to_string)))
}

pub fn find_letta_for(h: &Host) -> Option<Runtime> {
    if let Some(letta) = h.dir("LOKI_LETTA_BIN").filter(|p| p.is_file()) {
        let node_bin_dir = node_for(&letta, h);
        return Some(Runtime { letta, node_bin_dir, explicit: true });
    }
    let letta = bin_dirs_for(h).into_iter().find_map(|d| h.program_in(&d, "letta"))?;
    let node_bin_dir = node_for(&letta, h);
    Some(Runtime { letta, node_bin_dir, explicit: false })
}

/// npm in a Node's folder: `npm.cmd` on Windows.
pub fn npm_in(os: Os, node_bin_dir: &Path) -> PathBuf {
    node_bin_dir.join(os.names("npm").remove(0))
}

/// Where `npm install -g` puts the `letta` shim: the global prefix itself on Windows, its `bin` elsewhere.
pub fn letta_in_prefix(os: Os, prefix: &Path) -> PathBuf {
    match os {
        Os::Windows => prefix.join("letta.cmd"),
        _ => prefix.join("bin").join("letta"),
    }
}

/// What starting `letta` means: the program and the arguments before letta's own. On Windows npm's
/// `letta.cmd` is a batch file (a console window, and a `cmd.exe` between loki and the harness), so loki runs
/// `node <prefix>\node_modules\@letta-ai\letta-code\letta.js` itself when both are where npm puts them; a
/// LOKI_LETTA_BIN naming a `.js` runs with node too. Anything else, and every other system: the file as is.
pub fn launch_of(os: Os, rt: &Runtime) -> (PathBuf, Vec<std::ffi::OsString>) {
    if os == Os::Windows {
        let ext = rt.letta.extension().map(|e| e.to_string_lossy().to_ascii_lowercase());
        let entry = match ext.as_deref() {
            Some("cmd") => rt.letta.parent().map(|d| d.join("node_modules").join("@letta-ai").join("letta-code").join("letta.js")),
            Some("js") => Some(rt.letta.clone()),
            _ => None,
        };
        let node = rt.node_bin_dir.as_ref().map(|d| d.join("node.exe"));
        if let (Some(entry), Some(node)) = (entry.filter(|p| p.is_file()), node.filter(|p| p.is_file())) {
            return (node, vec![entry.into_os_string()]);
        }
    }
    (rt.letta.clone(), vec![])
}

/// A `letta` command for `rt` on `os`: its program (launch_of), the runtime's Node first on PATH, the
/// self-updater off, no console window.
pub fn letta_command_for(os: Os, rt: &Runtime) -> Command {
    let (program, args) = launch_of(os, rt);
    let mut cmd = Command::new(program);
    cmd.args(args).env("PATH", path_for(rt)).env("DISABLE_AUTOUPDATER", "1");
    quiet(&mut cmd);
    cmd
}

pub fn letta_command(rt: &Runtime) -> Command {
    letta_command_for(Os::HOST, rt)
}

/// No Node 22.19+ anywhere loki looks: what Status carries so Welcome can say so, for this system.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct NodeMissing {
    pub os: Os,
    /// The newest older Node found ("20.11.1"), if any, and where.
    pub found: Option<String>,
    pub at: Option<String>,
    /// "22.19": letta-code's engines.node.
    pub needed: String,
}

pub fn node_missing(os: Os, old: Option<(Version, PathBuf)>) -> NodeMissing {
    let (found, at) = match old {
        Some(((a, b, c), p)) => (Some(format!("{a}.{b}.{c}")), Some(p.display().to_string())),
        None => (None, None),
    };
    NodeMissing { os, found, at, needed: format!("{}.{}", NODE_MIN.0, NODE_MIN.1) }
}

impl NodeMissing {
    /// The error line: what is missing, and this system's usual way to install it.
    pub fn message(&self) -> String {
        let what = match (&self.found, &self.at) {
            (Some(v), Some(at)) => format!("Node {v} at {at} is older than {}", self.needed),
            _ => format!("no Node {} or newer", self.needed),
        };
        match self.os {
            Os::Macos if self.found.is_none() => format!("{what} on this Mac — `brew install node` (the Homebrew cask brings it), then retry"),
            Os::Macos => format!("{what} — `brew install node` (the Homebrew cask brings it), then retry"),
            Os::Windows => format!("{what} — `winget install OpenJS.NodeJS.LTS` in a terminal, or the installer from nodejs.org, then check again"),
            Os::Linux => format!("{what} — the distribution's package (`sudo apt install nodejs npm`, `sudo dnf install nodejs`) when it is 22 or newer, else nodejs.org's instructions, then check again"),
        }
    }
}

/// An install that did not finish: the line to show, and the Node state when that is the reason.
#[derive(Debug)]
pub struct InstallError {
    pub message: String,
    pub node_missing: Option<NodeMissing>,
}

impl From<String> for InstallError {
    fn from(message: String) -> Self {
        InstallError { message, node_missing: None }
    }
}

impl From<&str> for InstallError {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
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
    let base = std::env::var("PATH").unwrap_or_else(|_| if cfg!(windows) { String::new() } else { "/usr/bin:/bin".into() });
    match node_bin_dir {
        Some(d) => format!("{}{}{base}", d.display(), Os::HOST.path_separator()),
        None => base,
    }
}

/// What `letta --version` prints, as a bare "0.32.10"; None when it will not run.
pub fn letta_version(rt: &Runtime) -> Option<String> {
    let out = letta_command(rt).arg("--version").stdin(Stdio::null()).output().ok()?;
    if !out.status.success() { return None; }
    String::from_utf8_lossy(&out.stdout).split_whitespace().next().map(|v| v.trim_start_matches('v').to_string())
}

/// The newest release on npm, the registry's `latest` tag: `npm view` with the npm beside the runtime's Node
/// (else the first Node 22+ found), so it works wherever npm does — no curl on the system is assumed.
pub fn latest_version(rt: Option<&Runtime>, home: &Path) -> Result<String, String> {
    let node_bin_dir = rt.and_then(|r| r.node_bin_dir.clone()).filter(|d| npm_in(Os::HOST, d).is_file()).or_else(|| find_node(home)).ok_or("no npm to ask the registry with (no Node 22 or newer found)")?;
    let body = run(
        Command::new(npm_in(Os::HOST, &node_bin_dir)).args(["view", PACKAGE, "version", "--fetch-timeout", "10000", "--fetch-retries", "0"]).env("PATH", path_with(Some(&node_bin_dir))).env("npm_config_update_notifier", "false"),
        "asking registry.npmjs.org",
    )?;
    parse_npm_view(&body)
}

/// `npm view <package> version` prints the bare version.
pub fn parse_npm_view(body: &str) -> Result<String, String> {
    let v = body.trim();
    parse_version(v).map(|_| v.trim_start_matches('v').to_string()).ok_or_else(|| format!("registry reply had no version: {v:?}"))
}

fn run(cmd: &mut Command, what: &str) -> Result<String, String> {
    let out = quiet(cmd).stdin(Stdio::null()).output().map_err(|e| format!("{what}: {e}"))?;
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
/// log path, so the person reading the window has both. A permissions failure adds the sudo line (on Windows,
/// which has no sudo, the same install in a terminal opened as administrator).
pub fn telling_error(errors: &[String], fallback: &str) -> String {
    telling_error_on(Os::HOST, errors, fallback)
}

/// `telling_error` as it reads on a given system.
pub fn telling_error_on(os: Os, errors: &[String], fallback: &str) -> String {
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
    if denied && os == Os::Windows {
        out = format!("{out} · npm may not write its global folder; in a terminal opened as administrator: npm install -g {PACKAGE}@latest");
    } else if denied {
        out = format!("{out} · npm may not write its global folder; in a terminal: {}", sudo_line("latest"));
    }
    out
}

/// Run a package manager to completion, its stderr lines to `report` as they come (npm talks on stderr;
/// the last stdout line is reported at the end for the ones that do not).
fn stream(cmd: &mut Command, stage: &'static str, report: &dyn Fn(Progress)) -> Result<(), String> {
    let mut child = quiet(cmd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("could not run {}: {e}", cmd.get_program().to_string_lossy()))?;
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
pub fn install(home: &Path, report: &dyn Fn(Progress)) -> Result<Runtime, InstallError> {
    install_version(home, "latest", report)
}

/// `npm install -g @letta-ai/letta-code@<version>` ("latest" or a number) with the npm beside the Node loki
/// would run it with, into npm's global folder — the same place a terminal's `npm install -g` writes. No Node
/// 22.19+ anywhere: an error carrying `NodeMissing`, which Welcome shows as the Node step. Everything is looked
/// up afresh here, so the retry after installing Node finds it.
pub fn install_version(home: &Path, version: &str, report: &dyn Fn(Progress)) -> Result<Runtime, InstallError> {
    let host = Host::this(home);
    let node_bin_dir = match find_node_for(&host) {
        Ok(d) => d,
        Err(old) => {
            let missing = node_missing(host.os, old);
            return Err(InstallError { message: missing.message(), node_missing: Some(missing) });
        }
    };
    let node = host.program_in(&node_bin_dir, "node").unwrap_or_else(|| node_bin_dir.join("node"));
    report(Progress { stage: "node", message: format!("using Node at {}", node.display()) });
    let npm = npm_in(host.os, &node_bin_dir);
    if !npm.is_file() {
        return Err(match host.os {
            Os::Macos => format!("no npm beside {} — install Node with Homebrew (`brew install node`) or nodejs.org, then retry", node.display()),
            _ => format!("no npm beside {} — install Node from nodejs.org (it brings npm), then retry", node.display()),
        }
        .into());
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
    // Where npm put it: its global prefix (volta's shim answers for its own image; on Windows the shim sits in
    // the prefix itself), else wherever discovery finds one now.
    let prefix = run(Command::new(&npm).args(["prefix", "-g"]).env("PATH", &path), "npm prefix -g").ok().map(|s| PathBuf::from(s.trim()));
    let from_prefix = prefix.as_ref().map(|p| letta_in_prefix(host.os, p)).filter(|p| p.is_file());
    let letta = match from_prefix {
        Some(p) => p,
        None => find_letta_for(&host).map(|rt| rt.letta).ok_or("npm finished but no `letta` turned up where it installs to")?,
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
    let rt = Runtime { node_bin_dir: node_for(&letta, &host).or(Some(node_bin_dir)), letta, explicit: false };
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
    /// The install stopped for want of a Node 22.19+: Welcome's Node step (install it, then check again).
    pub node_missing: Option<NodeMissing>,
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
        for os in [Os::Macos, Os::Linux] {
            let msg = telling_error_on(os, &errors, "last");
            assert!(msg.starts_with("Error: EACCES: permission denied"), "{msg}");
            assert!(msg.ends_with(&sudo_line("latest")), "{msg}");
        }
        assert_eq!(sudo_line("latest"), "sudo npm install -g @letta-ai/letta-code@latest");
    }

    #[test]
    fn windows_has_no_sudo_line_but_an_administrator_terminal() {
        let errors: Vec<String> = ["error code EPERM", "error Error: EPERM: operation not permitted, mkdir 'C:\\Program Files\\nodejs\\node_modules\\@letta-ai'"].iter().map(|s| s.to_string()).collect();
        let msg = telling_error_on(Os::Windows, &errors, "last");
        assert!(msg.starts_with("Error: EPERM: operation not permitted"), "{msg}");
        assert!(!msg.contains("sudo"), "{msg}");
        assert!(msg.ends_with("npm may not write its global folder; in a terminal opened as administrator: npm install -g @letta-ai/letta-code@latest"), "{msg}");
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

    /// A fresh folder per call. The counter matters: tests run in parallel and the Mac's clock ticks in
    /// microseconds, so two homes named by time alone could be one folder, and one test's cleanup the other's loss.
    fn fake_home() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let home = std::env::temp_dir().join(format!("loki-boot-{}-{nanos}-{n}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        home
    }
    fn touch(p: &Path) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, "#!/bin/sh\n").unwrap();
    }

    // The Mac's own list on the machine running the test (Homebrew, ~/Library's fnm); Linux's and Windows' lists
    // are checked below on any machine, through an injected Host.
    #[cfg(target_os = "macos")]
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

    // ~/.volta/bin is volta's folder on the Mac and Linux; on Windows it lives under %LOCALAPPDATA% (the real one,
    // not this fake home), and that layout is checked below through an injected Host.
    #[cfg(unix)]
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

    // ── Other systems' layouts, on any machine: the OS, the environment and the version probe are the test's. ──

    /// A fake Node: its file holds the version it would print, so the probe reads it (a real binary parses as none,
    /// so a machine's own Node never wins in these tests).
    fn node_file(p: &Path, version: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, version).unwrap();
    }
    fn probe(p: &Path) -> Option<(u32, u32, u32)> {
        std::fs::read_to_string(p).ok().and_then(|s| parse_version(&s))
    }
    fn host(os: Os, home: &Path, path: &str, vars: Vec<(&'static str, PathBuf)>) -> Host {
        Host {
            os,
            home: home.to_path_buf(),
            root: home.join("root"),
            path: Some(path.to_string()),
            var: Box::new(move |k| vars.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone().into_os_string())),
            version: Box::new(probe),
        }
    }
    /// A Windows user's folders, rooted in the fake home: %APPDATA%, %LOCALAPPDATA%, %ProgramFiles%.
    fn windows(home: &Path) -> Vec<(&'static str, PathBuf)> {
        vec![("APPDATA", home.join("AppData").join("Roaming")), ("LOCALAPPDATA", home.join("AppData").join("Local")), ("ProgramFiles", home.join("Program Files"))]
    }
    fn letta_js(npm_prefix: &Path) -> PathBuf {
        npm_prefix.join("node_modules").join("@letta-ai").join("letta-code").join("letta.js")
    }

    #[test]
    fn the_mac_looks_where_it_always_did() {
        let home = PathBuf::from("/Users/someone");
        let h = Host { os: Os::Macos, home: home.clone(), root: PathBuf::from("/"), path: Some("/x/bin".into()), var: Box::new(|_| None), version: Box::new(|_| None) };
        let fnm = |p: PathBuf| p.join("aliases").join("default").join("bin");
        assert_eq!(
            bin_dirs_for(&h),
            vec![
                PathBuf::from("/x/bin"),
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/usr/local/bin"),
                home.join(".volta/bin"),
                home.join(".bun/bin"),
                home.join(".npm-global/bin"),
                home.join(".local/bin"),
                fnm(home.join("Library").join("Application Support").join("fnm")),
                fnm(home.join(".local").join("share").join("fnm")),
                fnm(home.join(".fnm")),
            ]
        );
        // `bin_dirs` is this machine's list, so the entry point matches only when the test runs on a Mac.
        if cfg!(target_os = "macos") { assert_eq!(bin_dirs(&home, Some("/x/bin")), bin_dirs_for(&h), "the Mac's own entry point is the same list") }
    }

    #[test]
    fn windows_finds_npms_letta_cmd_and_the_program_files_node_and_runs_letta_js_with_it() {
        let home = fake_home();
        let npm = home.join("AppData").join("Roaming").join("npm");
        touch(&npm.join("letta.cmd"));
        touch(&letta_js(&npm));
        let nodejs = home.join("Program Files").join("nodejs");
        node_file(&nodejs.join("node.exe"), "v22.19.0");
        let h = host(Os::Windows, &home, "", windows(&home));
        let rt = find_letta_for(&h).unwrap();
        assert_eq!(rt.letta, npm.join("letta.cmd"));
        assert_eq!(rt.node_bin_dir, Some(nodejs.clone()));
        assert!(!rt.explicit);
        let (program, args) = launch_of(Os::Windows, &rt);
        assert_eq!(program, nodejs.join("node.exe"), "node itself, not the .cmd shim: no console, and a process loki can own");
        assert_eq!(args, vec![letta_js(&npm).into_os_string()]);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn windows_falls_back_to_the_shim_when_letta_js_or_node_is_not_where_npm_puts_them() {
        let home = fake_home();
        let npm = home.join("AppData").join("Roaming").join("npm");
        touch(&npm.join("letta.cmd"));
        let rt = Runtime { letta: npm.join("letta.cmd"), node_bin_dir: Some(home.join("Program Files").join("nodejs")), explicit: false };
        assert_eq!(launch_of(Os::Windows, &rt), (npm.join("letta.cmd"), vec![]), "no letta.js beside the shim");
        touch(&letta_js(&npm));
        assert_eq!(launch_of(Os::Windows, &rt), (npm.join("letta.cmd"), vec![]), "no node.exe in the runtime's folder");
        // volta's letta.exe is a real program: run as is.
        let volta = Runtime { letta: home.join("AppData/Local/Volta/bin/letta.exe"), node_bin_dir: None, explicit: false };
        assert_eq!(launch_of(Os::Windows, &volta), (volta.letta.clone(), vec![]));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn windows_names_carry_their_extensions_and_a_bare_node_is_not_one() {
        let home = fake_home();
        let nodejs = home.join("Program Files").join("nodejs");
        node_file(&nodejs.join("node"), "v24.1.0");
        let h = host(Os::Windows, &home, "", windows(&home));
        assert_eq!(find_node_for(&h), Err(None), "a file called `node` is not a Windows program");
        node_file(&nodejs.join("node.exe"), "v24.1.0");
        assert_eq!(find_node_for(&h), Ok(nodejs.clone()));
        assert_eq!(npm_in(Os::Windows, &nodejs), nodejs.join("npm.cmd"));
        assert_eq!(npm_in(Os::Linux, Path::new("/usr/bin")), PathBuf::from("/usr/bin/npm"));
        // volta's shim on Windows is letta.exe
        touch(&home.join("AppData/Local/Volta/bin/letta.exe"));
        assert_eq!(find_letta_for(&h).unwrap().letta, home.join("AppData/Local/Volta/bin/letta.exe"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn windows_path_splits_on_semicolons_and_the_installers_folders_follow() {
        let home = fake_home();
        let mut vars = windows(&home);
        vars.push(("NVM_SYMLINK", home.join("nvm4w").join("nodejs")));
        let h = host(Os::Windows, &home, r"C:\Tools;D:\bin;", vars);
        let dirs = bin_dirs_for(&h);
        assert_eq!(dirs[0], PathBuf::from(r"C:\Tools"));
        assert_eq!(dirs[1], PathBuf::from(r"D:\bin"));
        let roaming = home.join("AppData").join("Roaming");
        let local = home.join("AppData").join("Local");
        assert_eq!(dirs[2], roaming.join("npm"), "npm's global folder, where letta.cmd lands");
        assert_eq!(dirs[3], home.join("Program Files").join("nodejs"), "the nodejs.org installer and winget");
        assert!(dirs.contains(&local.join("Volta").join("bin")));
        assert!(dirs.contains(&home.join("nvm4w").join("nodejs")), "nvm-windows' active version");
        assert!(dirs.contains(&roaming.join("fnm").join("aliases").join("default")));
        assert!(dirs.contains(&home.join("scoop").join("shims")));
        assert!(dirs.contains(&home.join("scoop").join("apps").join("nodejs").join("current")));
        assert!(!dirs.iter().any(|d| d.to_string_lossy().contains("homebrew")), "no Mac folders on Windows");
        // nvm-windows keeps versions as <NVM_HOME>\vX.Y.Z\node.exe (no bin folder): the newest is looked in.
        node_file(&roaming.join("nvm").join("v22.20.0").join("node.exe"), "v22.20.0");
        node_file(&roaming.join("nvm").join("v24.2.0").join("node.exe"), "v24.2.0");
        assert!(bin_dirs_for(&h).contains(&roaming.join("nvm").join("v24.2.0")));
        assert_eq!(find_node_for(&h), Ok(roaming.join("nvm").join("v24.2.0")));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn windows_without_its_variables_still_looks_in_the_home() {
        let home = fake_home();
        let h = host(Os::Windows, &home, "", vec![]);
        let dirs = bin_dirs_for(&h);
        assert!(dirs.contains(&home.join("AppData").join("Roaming").join("npm")), "%APPDATA% unset: the home's own AppData");
        assert!(dirs.iter().all(|d| d.is_absolute() || d.starts_with(&home)), "{dirs:?}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn linux_finds_nvms_node_and_looks_in_usr_bin() {
        let home = fake_home();
        let h = host(Os::Linux, &home, "", vec![]);
        let dirs = bin_dirs_for(&h);
        let root = home.join("root");
        assert_eq!(dirs[0], root.join("usr/local/bin"));
        assert_eq!(dirs[1], root.join("usr/bin"));
        assert!(dirs.contains(&home.join(".volta/bin")));
        assert!(dirs.contains(&home.join(".npm-global/bin")));
        assert!(dirs.contains(&home.join(".local/share/fnm/aliases/default/bin")));
        assert!(!dirs.iter().any(|d| d.to_string_lossy().contains("Library") || d.to_string_lossy().contains("/opt/homebrew")), "no Mac folders on Linux");
        assert_eq!(find_node_for(&h), Err(None));
        node_file(&home.join(".nvm/versions/node/v22.19.0/bin/node"), "v22.19.0");
        assert_eq!(find_node_for(&h), Ok(home.join(".nvm/versions/node/v22.19.0/bin")), "found at the next look: nothing is cached");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn linux_finds_a_letta_under_npm_global_with_the_node_beside_it() {
        let home = fake_home();
        let h = host(Os::Linux, &home, "", vec![]);
        assert!(find_letta_for(&h).is_none());
        touch(&home.join(".npm-global/bin/letta"));
        node_file(&home.join(".npm-global/bin/node"), "v22.19.0");
        let rt = find_letta_for(&h).unwrap();
        assert_eq!(rt.letta, home.join(".npm-global/bin/letta"));
        assert_eq!(rt.node_bin_dir, Some(home.join(".npm-global/bin")));
        assert_eq!(launch_of(Os::Linux, &rt), (rt.letta.clone(), vec![]), "the shim runs as is off Windows");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn loki_letta_bin_names_the_runtime_on_any_os() {
        let home = fake_home();
        let named = home.join("checkout").join("letta.js");
        touch(&named);
        let nodejs = home.join("Program Files").join("nodejs");
        node_file(&nodejs.join("node.exe"), "v22.19.0");
        let mut vars = windows(&home);
        vars.push(("LOKI_LETTA_BIN", named.clone()));
        let rt = find_letta_for(&host(Os::Windows, &home, "", vars)).unwrap();
        assert!(rt.explicit);
        assert_eq!(rt.letta, named);
        assert_eq!(launch_of(Os::Windows, &rt), (nodejs.join("node.exe"), vec![named.clone().into_os_string()]), "a .js entry runs with node on Windows");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_node_older_than_22_19_is_missing_and_named() {
        let home = fake_home();
        node_file(&home.join(".nvm/versions/node/v18.20.4/bin/node"), "v18.20.4");
        node_file(&home.join("root/usr/bin/node"), "v20.11.1");
        node_file(&home.join(".volta/bin/node"), "v22.18.0");
        let h = host(Os::Linux, &home, "", vec![]);
        assert_eq!(find_node_for(&h), Err(Some(((22, 18, 0), home.join(".volta/bin/node")))), "the newest of the old ones is named");
        let missing = node_missing(Os::Linux, find_node_for(&h).unwrap_err());
        assert_eq!(missing.found.as_deref(), Some("22.18.0"));
        assert_eq!(missing.at.as_deref().map(PathBuf::from), Some(home.join(".volta/bin/node")), "compared as paths: on Windows the folder list mixes / and \\");
        assert_eq!(missing.needed, "22.19");
        assert_eq!(missing.os, Os::Linux);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn the_node_missing_line_names_each_systems_install() {
        let none = node_missing(Os::Windows, None);
        assert_eq!(none.found, None);
        assert!(none.message().contains("winget install OpenJS.NodeJS.LTS"), "{}", none.message());
        assert!(none.message().contains("nodejs.org"));
        let linux = node_missing(Os::Linux, None).message();
        assert!(linux.contains("apt") && linux.contains("dnf"), "{linux}");
        let old = node_missing(Os::Linux, Some(((20, 11, 1), PathBuf::from("/usr/bin/node")))).message();
        assert!(old.contains("20.11.1") && old.contains("/usr/bin/node"), "{old}");
        assert_eq!(node_missing(Os::Macos, None).message(), "no Node 22.19 or newer on this Mac — `brew install node` (the Homebrew cask brings it), then retry", "the Mac's line as it was");
    }

    #[test]
    fn npm_puts_letta_in_its_prefix_on_windows_and_its_bin_elsewhere() {
        let p = PathBuf::from("/prefix");
        assert_eq!(letta_in_prefix(Os::Windows, &p), p.join("letta.cmd"));
        assert_eq!(letta_in_prefix(Os::Linux, &p), p.join("bin").join("letta"));
        assert_eq!(letta_in_prefix(Os::Macos, &p), p.join("bin").join("letta"));
    }

    #[test]
    fn npm_view_answers_the_bare_version() {
        assert_eq!(parse_npm_view("0.32.10\n"), Ok("0.32.10".to_string()));
        assert!(parse_npm_view("").is_err());
        assert!(parse_npm_view("not a version").is_err());
    }

    #[test]
    fn letta_runs_with_the_runtimes_node_first_on_path() {
        let rt = Runtime { letta: PathBuf::from("/opt/homebrew/bin/letta"), node_bin_dir: Some(PathBuf::from("/opt/homebrew/bin")), explicit: false };
        let cmd = letta_command_for(Os::Macos, &rt);
        assert_eq!(cmd.get_program(), rt.letta.as_os_str());
        let env: Vec<_> = cmd.get_envs().map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(|v| v.to_string_lossy().into_owned()))).collect();
        assert!(env.contains(&("DISABLE_AUTOUPDATER".into(), Some("1".into()))));
        let path = env.iter().find(|(k, _)| k == "PATH").and_then(|(_, v)| v.clone()).unwrap();
        assert!(path.starts_with("/opt/homebrew/bin"), "{path}");
    }

    #[test]
    fn status_says_node_is_missing_in_its_own_field() {
        let s = Status { node_missing: Some(node_missing(Os::Windows, None)), ..Status::default() };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["node_missing"]["os"], "windows");
        assert_eq!(v["node_missing"]["needed"], "22.19");
        assert!(v["node_missing"]["found"].is_null());
        assert!(serde_json::to_value(Status::default()).unwrap()["node_missing"].is_null());
    }
}
