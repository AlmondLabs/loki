//! Node.js on this machine, for loki's daemon (plan 017): the `node` a terminal would run, found where installers
//! put it. Discovery looks at `LOKI_NODE_BIN` first, then PATH, then the folders GUI apps do not see on their short
//! PATH (Homebrew's prefixes, volta, bun, nvm, fnm, npm's own global bin; on Windows the nodejs.org installer's,
//! nvm-windows', fnm's, scoop's). Nothing new enough: `NodeMissing`, which Welcome shows as its Node step, with this
//! system's usual way to install one. Nothing is cached, so a Node installed while Welcome waits is found by the
//! next look (`retry_daemon`).

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// The oldest Node the daemon runs on: its SQLite store (node:sqlite) and type stripping need it.
pub const NODE_MIN: (u32, u32, u32) = (22, 19, 0);

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

    /// The file names a program goes by: `.exe` on Windows, the bare name elsewhere.
    fn names(self, program: &str) -> Vec<String> {
        match self {
            Os::Windows => vec![format!("{program}.exe")],
            _ => vec![program.into()],
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

/// No console window for a program started from the GUI on Windows (`node --version`, the daemon itself);
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
/// `/usr/bin:/bin:/usr/sbin:/sbin`, so without this list a Homebrew `node` would never be found.
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

/// The `node` program of the first Node 22.19+ (loki's daemon runs on it); else what Welcome says about the Node there is.
pub fn find_node_program(home: &Path) -> Result<PathBuf, NodeMissing> {
    let host = Host::this(home);
    match find_node_for(&host) {
        Ok(dir) => host.program_in(&dir, "node").ok_or_else(|| node_missing(host.os, None)),
        Err(old) => Err(node_missing(host.os, old)),
    }
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

/// No Node 22.19+ anywhere loki looks: what daemon_status carries so Welcome can say so, for this system.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct NodeMissing {
    pub os: Os,
    /// The newest older Node found ("20.11.1"), if any, and where.
    pub found: Option<String>,
    pub at: Option<String>,
    /// "22.19": NODE_MIN.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_parse_and_compare() {
        assert_eq!(parse_version("v22.23.2\n"), Some((22, 23, 2)));
        assert_eq!(parse_version("0.32.10 (some tool)"), Some((0, 32, 10)));
        assert_eq!(parse_version("nope"), None);
        assert!(parse_version("v22.19.0").unwrap() >= NODE_MIN);
        assert!(parse_version("v20.19.0").unwrap() < NODE_MIN);
        assert!(parse_version("v26.8.2").unwrap() >= NODE_MIN);
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
        node_file(&home.join(".nvm/versions/node/v22.1.0/bin/node"), "v22.1.0");
        node_file(&home.join(".nvm/versions/node/v24.3.0/bin/node"), "v24.3.0");
        let dirs = bin_dirs(&home, Some(""));
        assert!(dirs.contains(&home.join(".nvm/versions/node/v24.3.0/bin")));
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
    fn windows_names_carry_their_extension_and_a_bare_node_is_not_one() {
        let home = fake_home();
        let nodejs = home.join("Program Files").join("nodejs");
        node_file(&nodejs.join("node"), "v24.1.0");
        let h = host(Os::Windows, &home, "", windows(&home));
        assert_eq!(find_node_for(&h), Err(None), "a file called `node` is not a Windows program");
        node_file(&nodejs.join("node.exe"), "v24.1.0");
        assert_eq!(find_node_for(&h), Ok(nodejs.clone()));
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
        assert_eq!(dirs[2], roaming.join("npm"), "npm's global folder");
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
}
