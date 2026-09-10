//! First launch: the mod and the agent's skill go where Letta looks for them.
//!
//! The app ships the mod as one bundled file (src-tauri/resources/mod/loki-mod.mjs, built by
//! scripts/build-mod.ts). On launch it is copied to ~/.letta/loki/mod (loki's home, `data` below) and a
//! shim in ~/.letta/mods/loki.ts points at it. A shim the app did not write (a developer's, pointing at a
//! checkout) is left alone. The same goes for the skill in ~/.agents/skills/loki.
//!
//! The built canvas (src-tauri/resources/app, a copy of app/dist) lands at <data>/app beside the
//! mod: the mod's LAN listener serves it to phones (mod/static.ts). Optional: a build without it
//! still installs the mod.
//!
//! Also here: which external programs the app needs (`letta`, `bd`) and where they were found.

use serde::Serialize;
use std::path::{Path, PathBuf};

pub const MARKER: &str = "// loki: managed by the loki app — edits are overwritten on launch";
const SKILL_MARKER: &str = ".managed-by-loki";
const APP_MARKER: &str = ".managed-by-loki";
const APP_MARKER_TEXT: &[u8] = b"files here are written by the loki app on launch\n";

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum State {
    /// Written for the first time.
    Installed,
    /// Already there; the bundle changed and was replaced.
    Updated,
    /// Already there and identical.
    Current,
    /// Something we did not write is in the way (a developer's shim or a symlink): left alone.
    Custom,
    /// Not attempted (development build, or LOKI_NO_INSTALL).
    Skipped,
    Error,
}

#[derive(Clone, Debug, Serialize)]
pub struct Report {
    pub r#mod: State,
    pub shim: String,
    pub mod_path: String,
    pub skill: State,
    pub skill_path: String,
    /// The canvas for phones (<data>/app). Skipped when the build shipped without app/dist.
    pub app: State,
    pub app_path: String,
    /// The harness loaded before this mod landed: it needs `/reload` (or a restart) to pick it up.
    pub needs_reload: bool,
    pub error: Option<String>,
}

impl Report {
    pub fn skipped(home: &Path) -> Report {
        Report { r#mod: State::Skipped, shim: shim_path(home).display().to_string(), mod_path: String::new(), skill: State::Skipped, skill_path: skill_dir(home).display().to_string(), app: State::Skipped, app_path: String::new(), needs_reload: false, error: None }
    }
    /// The harness must pick up a new mod bundle; a new app/ matters too, because the mod resolves the
    /// canvas directory when its LAN listener starts.
    pub fn changed(&self) -> bool {
        matches!(self.r#mod, State::Installed | State::Updated) || matches!(self.app, State::Installed | State::Updated)
    }
}

pub fn shim_path(home: &Path) -> PathBuf {
    home.join(".letta").join("mods").join("loki.ts")
}
pub fn skill_dir(home: &Path) -> PathBuf {
    home.join(".agents").join("skills").join("loki")
}

fn shim_source(mod_path: &Path) -> String {
    format!(
        "{MARKER}\n// Loads the mod bundle the app installed; a fresh query on every activate so /reload never runs stale code.\nimport {{ pathToFileURL }} from \"node:url\";\nexport default async function activate(letta: unknown) {{\n  const url = pathToFileURL({path});\n  url.searchParams.set(\"v\", String(Date.now()));\n  const mod = await import(url.href);\n  return mod.default(letta);\n}}\n",
        path = serde_json::to_string(&mod_path.display().to_string()).unwrap_or_else(|_| "\"\"".into())
    )
}

/// Where the bundled resources are, given Tauri's resource directory (the layout differs between
/// `tauri dev`, which copies them next to the binary, and a bundle).
pub fn find_resources(resource_dir: &Path) -> Option<PathBuf> {
    [resource_dir.join("resources"), resource_dir.to_path_buf()].into_iter().find(|d| d.join("mod").join("loki-mod.mjs").is_file())
}

fn write_if_changed(path: &Path, bytes: &[u8]) -> std::io::Result<State> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match std::fs::read(path) {
        Ok(existing) if existing == bytes => Ok(State::Current),
        Ok(_) => {
            std::fs::write(path, bytes)?;
            Ok(State::Updated)
        }
        Err(_) => {
            std::fs::write(path, bytes)?;
            Ok(State::Installed)
        }
    }
}

fn install_mod(resources: &Path, data_dir: &Path, home: &Path) -> Result<(State, PathBuf, PathBuf), String> {
    let bundle = std::fs::read(resources.join("mod").join("loki-mod.mjs")).map_err(|e| format!("bundled mod unreadable: {e}"))?;
    let mod_path = data_dir.join("mod").join("loki-mod.mjs");
    let shim = shim_path(home);
    // A shim that is not ours stays: someone is running the mod from a checkout.
    if let Ok(existing) = std::fs::read_to_string(&shim) {
        if !existing.starts_with(MARKER) {
            return Ok((State::Custom, shim, mod_path));
        }
    }
    let copied = write_if_changed(&mod_path, &bundle).map_err(|e| format!("could not write {}: {e}", mod_path.display()))?;
    let pointed = write_if_changed(&shim, shim_source(&mod_path).as_bytes()).map_err(|e| format!("could not write {}: {e}", shim.display()))?;
    let state = match (copied, pointed) {
        (State::Current, State::Current) => State::Current,
        (State::Installed, _) | (_, State::Installed) => State::Installed,
        _ => State::Updated,
    };
    Ok((state, shim, mod_path))
}

fn install_skill(resources: &Path, home: &Path) -> Result<(State, PathBuf), String> {
    let src = resources.join("skills").join("loki");
    let dst = skill_dir(home);
    let meta = std::fs::symlink_metadata(&dst).ok();
    if let Some(m) = &meta {
        if m.file_type().is_symlink() || !dst.join(SKILL_MARKER).exists() {
            return Ok((State::Custom, dst));
        }
    }
    let fresh = meta.is_none();
    let mut state = if fresh { State::Installed } else { State::Current };
    for entry in std::fs::read_dir(&src).map_err(|e| format!("bundled skill unreadable: {e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let bytes = std::fs::read(entry.path()).map_err(|e| e.to_string())?;
        let s = write_if_changed(&dst.join(entry.file_name()), &bytes).map_err(|e| format!("could not write skill: {e}"))?;
        if !fresh && s == State::Updated {
            state = State::Updated;
        }
    }
    std::fs::write(dst.join(SKILL_MARKER), b"files here are written by the loki app on launch\n").map_err(|e| e.to_string())?;
    Ok((state, dst))
}

/// Files under `dir`, relative to it, recursively. Symlinks are skipped: the bundle has none.
fn walk(dir: &Path, prefix: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let rel = prefix.join(entry.file_name());
        if ft.is_dir() {
            walk(&entry.path(), &rel, out)?;
        } else if ft.is_file() {
            out.push(rel);
        }
    }
    Ok(())
}

/// The canvas for phones: <resources>/app → <data>/app, every file write-if-changed, stale files
/// (an older build's hashed assets) removed. A directory we did not write is left alone.
/// `Skipped` when the build shipped without app/dist.
fn install_app(resources: &Path, data_dir: &Path) -> Result<(State, PathBuf), String> {
    let src = resources.join("app");
    let dst = data_dir.join("app");
    if !src.join("index.html").is_file() {
        return Ok((State::Skipped, dst));
    }
    let meta = std::fs::symlink_metadata(&dst).ok();
    if let Some(m) = &meta {
        if m.file_type().is_symlink() || !dst.join(APP_MARKER).exists() {
            return Ok((State::Custom, dst));
        }
    }
    let fresh = meta.is_none();
    let mut state = if fresh { State::Installed } else { State::Current };
    let mut files = Vec::new();
    walk(&src, Path::new(""), &mut files).map_err(|e| format!("bundled app unreadable: {e}"))?;
    if fresh {
        // The marker goes down first: a copy that fails halfway must still read as ours next launch,
        // so it is repaired rather than treated as a directory somebody else wrote.
        std::fs::create_dir_all(&dst).map_err(|e| e.to_string())?;
        std::fs::write(dst.join(APP_MARKER), APP_MARKER_TEXT).map_err(|e| e.to_string())?;
    }
    for rel in &files {
        let bytes = std::fs::read(src.join(rel)).map_err(|e| e.to_string())?;
        let s = write_if_changed(&dst.join(rel), &bytes).map_err(|e| format!("could not write app: {e}"))?;
        if !fresh && s != State::Current {
            state = State::Updated;
        }
    }
    let mut existing = Vec::new();
    walk(&dst, Path::new(""), &mut existing).map_err(|e| e.to_string())?;
    for rel in existing {
        if rel.as_os_str() == APP_MARKER || files.contains(&rel) {
            continue;
        }
        std::fs::remove_file(dst.join(&rel)).map_err(|e| format!("could not remove stale {}: {e}", rel.display()))?;
        if !fresh {
            state = State::Updated;
        }
    }
    std::fs::write(dst.join(APP_MARKER), APP_MARKER_TEXT).map_err(|e| e.to_string())?;
    Ok((state, dst))
}

/// Install all three. Never panics; failures land in `error` with whatever did succeed.
pub fn run(resources: &Path, data_dir: &Path, home: &Path) -> Report {
    let mut report = Report::skipped(home);
    match install_app(resources, data_dir) {
        Ok((state, dir)) => {
            report.app = state;
            report.app_path = dir.display().to_string();
        }
        Err(e) => {
            report.app = State::Error;
            report.error = Some(e);
        }
    }
    match install_mod(resources, data_dir, home) {
        Ok((state, shim, mod_path)) => {
            report.r#mod = state;
            report.shim = shim.display().to_string();
            report.mod_path = mod_path.display().to_string();
        }
        Err(e) => {
            report.r#mod = State::Error;
            report.error = Some(match report.error.take() { Some(prev) => format!("{prev}; {e}"), None => e });
        }
    }
    match install_skill(resources, home) {
        Ok((state, dir)) => {
            report.skill = state;
            report.skill_path = dir.display().to_string();
        }
        Err(e) => {
            report.skill = State::Error;
            report.error = Some(match report.error.take() { Some(prev) => format!("{prev}; {e}"), None => e });
        }
    }
    report
}

// --- requirements -------------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
pub struct Tools {
    /// The Letta Code CLI, which runs the harness (and the mod inside it).
    pub letta: Option<String>,
    /// beads, which keeps the board.
    pub bd: Option<String>,
}

/// Look on PATH first, then where installers usually put things (GUI apps get a short PATH).
pub fn find_program(name: &str, home: &Path) -> Option<PathBuf> {
    if let Some(p) = std::env::var_os(format!("LOKI_{}_BIN", name.to_uppercase())) {
        return Some(PathBuf::from(p));
    }
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    for d in [".volta/bin", ".bun/bin", ".local/bin", "go/bin", ".npm-global/bin"] {
        dirs.push(home.join(d));
    }
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        dirs.push(PathBuf::from(d));
    }
    dirs.into_iter().map(|d| d.join(name)).find(|p| p.is_file())
}

pub fn tools(home: &Path) -> Tools {
    Tools { letta: find_program("letta", home).map(|p| p.display().to_string()), bd: find_program("bd", home).map(|p| p.display().to_string()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempdir::Dir, PathBuf, PathBuf, PathBuf) {
        let root = tempdir::Dir::new("loki-install");
        let resources = root.path().join("res");
        std::fs::create_dir_all(resources.join("mod")).unwrap();
        std::fs::create_dir_all(resources.join("skills").join("loki")).unwrap();
        std::fs::write(resources.join("mod").join("loki-mod.mjs"), b"export default () => 1;\n").unwrap();
        std::fs::write(resources.join("skills").join("loki").join("SKILL.md"), b"# loki\n").unwrap();
        let data = root.path().join("data");
        let home = root.path().join("home");
        (root, resources, data, home)
    }

    #[test]
    fn installs_then_is_current_then_updates() {
        let (_root, resources, data, home) = fixture();
        let r = run(&resources, &data, &home);
        assert_eq!(r.r#mod, State::Installed);
        assert_eq!(r.skill, State::Installed);
        let shim = std::fs::read_to_string(shim_path(&home)).unwrap();
        assert!(shim.starts_with(MARKER));
        assert!(shim.contains(&data.join("mod").join("loki-mod.mjs").display().to_string()));
        assert!(skill_dir(&home).join("SKILL.md").is_file());

        let r = run(&resources, &data, &home);
        assert_eq!(r.r#mod, State::Current);
        assert_eq!(r.skill, State::Current);

        std::fs::write(resources.join("mod").join("loki-mod.mjs"), b"export default () => 2;\n").unwrap();
        std::fs::write(resources.join("skills").join("loki").join("SKILL.md"), b"# loki v2\n").unwrap();
        let r = run(&resources, &data, &home);
        assert_eq!(r.r#mod, State::Updated);
        assert_eq!(r.skill, State::Updated);
        assert!(r.changed());
    }

    #[test]
    fn leaves_a_developers_shim_and_symlinked_skill_alone() {
        let (_root, resources, data, home) = fixture();
        let shim = shim_path(&home);
        std::fs::create_dir_all(shim.parent().unwrap()).unwrap();
        std::fs::write(&shim, "// my shim\nexport default () => {}\n").unwrap();
        let skills = skill_dir(&home);
        std::fs::create_dir_all(skills.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&resources, &skills).unwrap();
        let r = run(&resources, &data, &home);
        assert_eq!(r.r#mod, State::Custom);
        assert_eq!(r.skill, State::Custom);
        assert_eq!(std::fs::read_to_string(&shim).unwrap(), "// my shim\nexport default () => {}\n");
        assert!(!data.join("mod").exists());
        assert!(r.error.is_none());
    }

    fn with_app(resources: &Path) {
        std::fs::create_dir_all(resources.join("app").join("assets")).unwrap();
        std::fs::write(resources.join("app").join("index.html"), b"<html></html>").unwrap();
        std::fs::write(resources.join("app").join("assets").join("index-abc.js"), b"1").unwrap();
    }

    #[test]
    fn app_is_optional_and_installs_beside_the_mod() {
        let (_root, resources, data, home) = fixture();
        // no app/ in the bundle: skipped, no error, the mod still lands
        let r = run(&resources, &data, &home);
        assert_eq!(r.app, State::Skipped);
        assert_eq!(r.r#mod, State::Installed);
        assert!(r.error.is_none());
        assert!(!data.join("app").exists());

        with_app(&resources);
        let r = run(&resources, &data, &home);
        assert_eq!(r.app, State::Installed);
        assert_eq!(r.app_path, data.join("app").display().to_string());
        assert!(data.join("app").join("index.html").is_file());
        assert!(data.join("app").join("assets").join("index-abc.js").is_file());
        assert!(data.join("app").join(APP_MARKER).is_file());
        // the layout mod/static.ts resolves: <data>/mod/loki-mod.mjs and <data>/app/index.html
        assert!(data.join("mod").join("loki-mod.mjs").is_file());

        let r = run(&resources, &data, &home);
        assert_eq!(r.app, State::Current);

        // a new build: new hashed asset, the old one goes
        std::fs::remove_file(resources.join("app").join("assets").join("index-abc.js")).unwrap();
        std::fs::write(resources.join("app").join("assets").join("index-def.js"), b"2").unwrap();
        let r = run(&resources, &data, &home);
        assert_eq!(r.app, State::Updated);
        assert!(!data.join("app").join("assets").join("index-abc.js").exists());
        assert!(data.join("app").join("assets").join("index-def.js").is_file());
        assert!(r.error.is_none());
    }

    #[test]
    fn leaves_an_app_dir_it_did_not_write_alone() {
        let (_root, resources, data, home) = fixture();
        with_app(&resources);
        std::fs::create_dir_all(data.join("app")).unwrap();
        std::fs::write(data.join("app").join("index.html"), b"mine").unwrap();
        let r = run(&resources, &data, &home);
        assert_eq!(r.app, State::Custom);
        assert_eq!(std::fs::read(data.join("app").join("index.html")).unwrap(), b"mine");
        assert!(r.error.is_none());
    }

    #[test]
    fn reports_missing_resources() {
        let (root, _resources, data, home) = fixture();
        let r = run(&root.path().join("nowhere"), &data, &home);
        assert_eq!(r.r#mod, State::Error);
        assert!(r.error.is_some());
    }

    #[test]
    fn finds_resources_in_both_layouts() {
        let (root, resources, _data, _home) = fixture();
        assert_eq!(find_resources(&resources), Some(resources.clone()));
        assert_eq!(find_resources(root.path()), None);
        let nested = root.path().join("bundle");
        std::fs::create_dir_all(&nested).unwrap();
        std::os::unix::fs::symlink(&resources, nested.join("resources")).unwrap();
        assert_eq!(find_resources(&nested), Some(nested.join("resources")));
    }

    /// A tiny temp dir without a crate: unique per test, removed on drop.
    mod tempdir {
        use std::path::{Path, PathBuf};
        pub struct Dir(PathBuf);
        impl Dir {
            pub fn new(tag: &str) -> Dir {
                let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
                let p = std::env::temp_dir().join(format!("{tag}-{}-{nanos}", std::process::id()));
                std::fs::create_dir_all(&p).unwrap();
                Dir(p)
            }
            pub fn path(&self) -> &Path {
                &self.0
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }
}
