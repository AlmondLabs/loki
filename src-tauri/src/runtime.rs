//! The runtime a release build's daemon runs on (plan 2026-11-15-2319, KTD4): the Node the release names in
//! `runtime.json`, and on Windows PortableGit when the machine has no git or no Git Bash. Each is downloaded once into
//! `~/.loki/runtime/<name>-<version>-<target>/`: hashed while it streams in, checked against the manifest's SHA-256,
//! unpacked into a temporary folder beside its final one and renamed into place, so a half-unpacked runtime is never
//! at the final path. A launch that finds that folder missing (the first, or one after a release named another
//! version) fetches it again; once the daemon has started on it, other versions are removed (`prune`).
//!
//! Development builds never come here: they keep finding the machine's Node (node.rs). The fetcher, the folder and
//! the target are the caller's (`Host`), so tests never touch the network or the real home.

use crate::node;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// The release's runtime, compiled into the shell so a build always fetches the Node it was tested with.
const MANIFEST: &str = include_str!("../runtime.json");

/// What `runtime.json` names: the Node every system runs, and the PortableGit Windows falls back to.
#[derive(Clone, Debug, Deserialize)]
pub struct Manifest {
    pub node: Tool,
    pub git: Tool,
}

/// One program of the runtime: its version, and the archive per target (`darwin-arm64`, `win-x64` and so on).
#[derive(Clone, Debug, Deserialize)]
pub struct Tool {
    pub version: String,
    pub targets: BTreeMap<String, Archive>,
}

/// Where one archive is published and the SHA-256 it must have.
#[derive(Clone, Debug, Deserialize)]
pub struct Archive {
    pub url: String,
    pub sha256: String,
}

impl Manifest {
    /// The manifest this build was compiled with.
    pub fn compiled() -> Result<Manifest, String> {
        serde_json::from_str(MANIFEST).map_err(|e| format!("runtime.json: {e}"))
    }
}

/// The manifest's name for a system and architecture, as Rust names them (`std::env::consts`). On the Mac it is the
/// architecture the app is running on, so the universal app fetches one Node, not two. Anything else is an error
/// rather than a guess: a Node built for another machine would not run.
pub fn target(os: &str, arch: &str) -> Result<&'static str, String> {
    match (os, arch) {
        ("macos", "aarch64") => Ok("darwin-arm64"),
        ("macos", "x86_64") => Ok("darwin-x64"),
        ("windows", "x86_64") => Ok("win-x64"),
        ("linux", "x86_64") => Ok("linux-x64"),
        _ => Err(format!("loki has no Node for {os} on {arch}")),
    }
}

/// Opens a download: the body, and its length when the server says.
pub type FetchFn = Box<dyn Fn(&str) -> Result<(Box<dyn Read>, Option<u64>), String>>;
/// Runs a self-extracting archive (PortableGit's `.7z.exe`) into a folder.
pub type ExtractFn = Box<dyn Fn(&Path, &Path) -> Result<(), String>>;

/// Where the runtime goes and how it gets there. `Host::this` is the machine loki runs on; tests bring their own
/// folder, target, manifest and fetcher.
pub struct Host {
    /// `~/.loki/runtime`.
    pub root: PathBuf,
    pub target: String,
    pub manifest: Manifest,
    /// Whether PortableGit is wanted: on Windows, when git or Git Bash is missing (`git_missing`).
    pub git: bool,
    pub fetch: FetchFn,
    pub extract: ExtractFn,
}

impl Host {
    /// This machine: the runtime under loki's folder `data`, this build's target and manifest, downloads over HTTPS,
    /// and PortableGit only when the home's PATH and Program Files lack git or Git Bash.
    pub fn this(data: &Path, home: &Path) -> Result<Host, String> {
        Ok(Host {
            root: data.join("runtime"),
            target: target(std::env::consts::OS, std::env::consts::ARCH)?.to_string(),
            manifest: Manifest::compiled()?,
            git: git_missing(&node::Host::this(home)),
            fetch: Box::new(http_get),
            extract: Box::new(run_self_extracting),
        })
    }
}

/// How far a download has come, for whoever shows it: bytes done, and the total when the server said.
#[derive(Clone, Debug, PartialEq)]
pub struct Progress<'a> {
    /// `node` or `git`.
    pub name: &'a str,
    pub version: &'a str,
    pub done: u64,
    pub total: Option<u64>,
}

/// A runtime ready to run: the `node` program, and the folders the daemon's PATH starts with (Node's, which also
/// holds npm and npx; then PortableGit's `cmd` and `bin` when it was wanted).
#[derive(Clone, Debug, PartialEq)]
pub struct Runtime {
    pub node: PathBuf,
    pub path: Vec<PathBuf>,
}

/// Make sure the manifest's Node (and PortableGit, when `h.git`) is unpacked under `h.root`, fetching what is
/// missing, and say where it is. `progress` hears every download from its first byte to its last.
pub fn ensure(h: &Host, progress: &mut dyn FnMut(&Progress)) -> Result<Runtime, String> {
    let node_dir = present_or_fetch(h, "node", &h.manifest.node, progress)?;
    let bin = if windows(&h.target) { node_dir } else { node_dir.join("bin") };
    let mut path = vec![bin.clone()];
    if h.git {
        let git = present_or_fetch(h, "git", &h.manifest.git, progress)?;
        path.extend([git.join("cmd"), git.join("bin")]);
    }
    Ok(Runtime { node: bin.join(if windows(&h.target) { "node.exe" } else { "node" }), path })
}

/// Remove every runtime folder the manifest no longer names for this target, once the daemon has started on the one it
/// does: an older Node, a Node for another architecture, an older PortableGit. A folder that cannot go stays until the
/// next start.
pub fn prune(h: &Host) {
    let keep = [folder("node", &h.manifest.node.version, &h.target), folder("git", &h.manifest.git.version, &h.target)];
    let Ok(entries) = std::fs::read_dir(&h.root) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !(name.starts_with("node-") || name.starts_with("git-")) || keep.contains(&name) || !e.path().is_dir() {
            continue;
        }
        if let Err(err) = std::fs::remove_dir_all(e.path()) {
            eprintln!("loki: runtime: could not remove {}: {err}", e.path().display());
        }
    }
}

/// Windows only: whether git or Git Bash is missing, so PortableGit is wanted. Git Bash is looked for where the daemon
/// looks for its shell (daemon/background.ts `shell`): `Git\bin\bash.exe` under Program Files, else `bash.exe` on
/// PATH. Other systems: never; their git is Welcome's step (KTD6).
pub fn git_missing(h: &node::Host) -> bool {
    if h.os != node::Os::Windows {
        return false;
    }
    let dirs: Vec<PathBuf> = h
        .path
        .as_deref()
        .map(|p| p.split(h.os.path_separator()).filter(|d| !d.is_empty()).map(PathBuf::from).collect())
        .unwrap_or_default();
    let on_path = |program: &str| dirs.iter().any(|d| h.program_in(d, program).is_some());
    let git_bash = ["ProgramFiles", "ProgramFiles(x86)"]
        .iter()
        .filter_map(|k| h.dir(k))
        .any(|root| root.join("Git").join("bin").join("bash.exe").is_file());
    !(on_path("git") && (git_bash || on_path("bash")))
}

fn windows(target: &str) -> bool {
    target.starts_with("win-")
}

/// `node-22.23.5-darwin-arm64`: the folder a runtime lives in, so another version or target never counts as present.
fn folder(name: &str, version: &str, target: &str) -> String {
    format!("{name}-{version}-{target}")
}

/// The file that says a runtime folder is complete: the program the daemon or its PATH needs from it.
fn program(name: &str, target: &str) -> PathBuf {
    match (name, windows(target)) {
        ("git", _) => Path::new("cmd").join("git.exe"),
        (_, true) => PathBuf::from("node.exe"),
        (_, false) => Path::new("bin").join("node"),
    }
}

/// How an archive is unpacked, read from its file name.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Kind {
    TarGz,
    Zip,
    SelfExtracting,
}

impl Kind {
    fn of(file_name: &str) -> Result<Kind, String> {
        [(".tar.gz", Kind::TarGz), (".zip", Kind::Zip), (".7z.exe", Kind::SelfExtracting)]
            .into_iter()
            .find(|(ext, _)| file_name.ends_with(ext))
            .map(|(_, k)| k)
            .ok_or_else(|| format!("loki cannot unpack {file_name}"))
    }

    /// The download's extension: Windows runs a self-extracting archive only under its `.exe` name.
    fn ext(self) -> &'static str {
        match self {
            Kind::TarGz => "tar.gz",
            Kind::Zip => "zip",
            Kind::SelfExtracting => "7z.exe",
        }
    }
}

/// The runtime folder for `name`, fetched first when it is not there complete.
fn present_or_fetch(h: &Host, name: &str, tool: &Tool, progress: &mut dyn FnMut(&Progress)) -> Result<PathBuf, String> {
    let base = folder(name, &tool.version, &h.target);
    let dir = h.root.join(&base);
    let program = program(name, &h.target);
    if dir.join(&program).is_file() {
        return Ok(dir);
    }
    let archive =
        tool.targets.get(&h.target).ok_or_else(|| format!("runtime.json names no {name} for {}", h.target))?;
    let file_name = archive.url.rsplit('/').next().unwrap_or(&archive.url).to_string();
    let kind = Kind::of(&file_name)?;
    std::fs::create_dir_all(&h.root).map_err(|e| format!("could not make {}: {e}", h.root.display()))?;
    let download = h.root.join(format!(".{base}.{}", kind.ext()));
    let unpack = h.root.join(format!(".{base}.unpack"));
    // An attempt cut short (loki quit mid-download) may have left either temporary; a folder at the final path without
    // its program (emptied by hand) would make the rename fail on every launch after.
    let _ = std::fs::remove_file(&download);
    let _ = std::fs::remove_dir_all(&unpack);
    let _ = std::fs::remove_dir_all(&dir);
    let done = fetch_checked(h, name, &tool.version, archive, &file_name, &download, progress)
        .and_then(|()| unpack_archive(h, kind, &file_name, &download, &unpack))
        .and_then(|top| {
            if !top.join(&program).is_file() {
                return Err(format!("{file_name} holds no {}", program.display()));
            }
            std::fs::rename(&top, &dir).map_err(|e| format!("could not move {name} into {}: {e}", dir.display()))
        });
    let _ = std::fs::remove_file(&download);
    let _ = std::fs::remove_dir_all(&unpack);
    done.map(|()| dir)
}

/// Download `archive` to `to`, hashing it as it streams in. A cut-off download or a hash that does not match leaves
/// an error naming the archive; the caller removes the file.
fn fetch_checked(
    h: &Host,
    name: &str,
    version: &str,
    archive: &Archive,
    file_name: &str,
    to: &Path,
    progress: &mut dyn FnMut(&Progress),
) -> Result<(), String> {
    let failed = |e: &dyn std::fmt::Display| format!("could not download {file_name}: {e}");
    let (mut body, total) = (h.fetch)(&archive.url).map_err(|e| failed(&e))?;
    let mut out = std::fs::File::create(to).map_err(|e| failed(&e))?;
    let mut hash = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut done = 0u64;
    progress(&Progress { name, version, done, total });
    loop {
        let n = match body.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(failed(&e)),
        };
        hash.update(&buf[..n]);
        out.write_all(&buf[..n]).map_err(|e| failed(&e))?;
        done += n as u64;
        progress(&Progress { name, version, done, total });
    }
    out.flush().map_err(|e| failed(&e))?;
    let got: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if !got.eq_ignore_ascii_case(archive.sha256.trim()) {
        return Err(format!("{file_name} does not match its published checksum, so loki did not use it"));
    }
    Ok(())
}

/// Unpack `file` into the folder `into` and return the runtime's top folder in it: the archive's one folder when it
/// has one (Node's `node-v22.23.5-darwin-arm64/`), else `into` itself (PortableGit unpacks loose).
fn unpack_archive(h: &Host, kind: Kind, file_name: &str, file: &Path, into: &Path) -> Result<PathBuf, String> {
    let failed = |e: &dyn std::fmt::Display| format!("could not unpack {file_name}: {e}");
    std::fs::create_dir_all(into).map_err(|e| failed(&e))?;
    match kind {
        Kind::TarGz => {
            let f = std::fs::File::open(file).map_err(|e| failed(&e))?;
            tar::Archive::new(flate2::read::GzDecoder::new(f)).unpack(into).map_err(|e| failed(&e))?;
        }
        Kind::Zip => {
            let f = std::fs::File::open(file).map_err(|e| failed(&e))?;
            zip::ZipArchive::new(f).and_then(|mut z| z.extract(into)).map_err(|e| failed(&e))?;
        }
        Kind::SelfExtracting => (h.extract)(file, into)?,
    }
    let entries: Vec<PathBuf> = std::fs::read_dir(into).map_err(|e| failed(&e))?.flatten().map(|e| e.path()).collect();
    match entries.as_slice() {
        [only] if only.is_dir() => Ok(only.clone()),
        _ => Ok(into.to_path_buf()),
    }
}

/// A download over HTTPS. reqwest's blocking client gives up on a connection or a read that stalls for 30 seconds,
/// so a dead network ends in an error rather than a launch that waits forever.
fn http_get(url: &str) -> Result<(Box<dyn Read>, Option<u64>), String> {
    // reqwest is built without a crypto provider (Cargo.toml), so ring is installed as the process default once; a
    // second call finds it already there, which is fine.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::blocking::Client::builder()
        .user_agent(concat!("loki/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client.get(url).send().and_then(|r| r.error_for_status()).map_err(|e| e.to_string())?;
    let total = response.content_length();
    Ok((Box::new(response), total))
}

/// PortableGit's 7-Zip self-extractor: `-y` answers its questions, `-o<folder>` is where it unpacks.
fn run_self_extracting(archive: &Path, into: &Path) -> Result<(), String> {
    let shown = archive.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut out = std::ffi::OsString::from("-o");
    out.push(into);
    let status = node::quiet(Command::new(archive).arg("-y").arg(out))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| format!("could not run {shown}: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{shown} could not unpack itself ({status})"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::collections::HashMap;
    use std::rc::Rc;

    /// A fresh folder per call; the counter keeps parallel tests apart (as node.rs's `fake_home`).
    fn temp_root() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("loki-runtime-{}-{nanos}-{n}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn sha256(bytes: &[u8]) -> String {
        Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Node's Mac and Linux archive, in small: one top folder, `bin/node` holding the version it would print.
    fn node_tar_gz(top: &str, version: &str) -> Vec<u8> {
        let mut tar = tar::Builder::new(flate2::write::GzEncoder::new(vec![], flate2::Compression::fast()));
        let mut header = tar::Header::new_gnu();
        header.set_size(version.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        tar.append_data(&mut header, format!("{top}/bin/node"), version.as_bytes()).unwrap();
        tar.into_inner().unwrap().finish().unwrap()
    }

    /// Node's Windows archive, in small: one top folder with `node.exe` in it.
    fn node_zip(top: &str, version: &str) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(vec![]));
        let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        zip.start_file(format!("{top}/node.exe"), stored).unwrap();
        zip.write_all(version.as_bytes()).unwrap();
        zip.finish().unwrap().into_inner()
    }

    const NODE: &str = "22.23.5";
    const GIT: &str = "2.56.1";

    fn node_url(target: &str) -> String {
        let ext = if windows(target) { "zip" } else { "tar.gz" };
        format!("https://nodejs.org/dist/v{NODE}/node-v{NODE}-{target}.{ext}")
    }
    const GIT_URL: &str = "https://example.test/PortableGit-2.56.1-64-bit.7z.exe";

    /// The published files a test serves, by URL, and how many downloads it was asked for.
    struct Server {
        files: HashMap<String, Vec<u8>>,
        fetches: Rc<Cell<u32>>,
    }

    impl Server {
        fn new() -> Server {
            let mut files = HashMap::new();
            for t in ["darwin-arm64", "darwin-x64", "linux-x64"] {
                files.insert(node_url(t), node_tar_gz(&format!("node-v{NODE}-{t}"), &format!("v{NODE}")));
            }
            files.insert(node_url("win-x64"), node_zip(&format!("node-v{NODE}-win-x64"), &format!("v{NODE}")));
            files.insert(GIT_URL.into(), b"a self-extracting PortableGit".to_vec());
            Server { files, fetches: Rc::new(Cell::new(0)) }
        }

        /// A manifest whose checksums are the served files' own.
        fn manifest(&self) -> Manifest {
            let archive = |url: &str| Archive { url: url.into(), sha256: sha256(&self.files[url]) };
            Manifest {
                node: Tool {
                    version: NODE.into(),
                    targets: ["darwin-arm64", "darwin-x64", "linux-x64", "win-x64"]
                        .into_iter()
                        .map(|t| (t.to_string(), archive(&node_url(t))))
                        .collect(),
                },
                git: Tool { version: GIT.into(), targets: [("win-x64".to_string(), archive(GIT_URL))].into() },
            }
        }

        /// A fetcher serving these files whole.
        fn fetch(&self) -> FetchFn {
            let (files, fetches) = (self.files.clone(), self.fetches.clone());
            Box::new(move |url| {
                fetches.set(fetches.get() + 1);
                let body = files.get(url).cloned().ok_or_else(|| format!("404 {url}"))?;
                let len = body.len() as u64;
                Ok((Box::new(std::io::Cursor::new(body)) as Box<dyn Read>, Some(len)))
            })
        }
    }

    /// PortableGit's extractor stand-in: what the real one leaves, loose in the folder (`cmd\git.exe`, `bin\bash.exe`).
    fn fake_extract(ran: Rc<Cell<u32>>) -> ExtractFn {
        Box::new(move |_archive, into| {
            ran.set(ran.get() + 1);
            for p in [Path::new("cmd").join("git.exe"), Path::new("bin").join("bash.exe")] {
                std::fs::create_dir_all(into.join(&p).parent().unwrap()).unwrap();
                std::fs::write(into.join(p), b"").unwrap();
            }
            Ok(())
        })
    }

    fn host(root: &Path, target: &str, server: &Server) -> Host {
        Host {
            root: root.to_path_buf(),
            target: target.into(),
            manifest: server.manifest(),
            git: false,
            fetch: server.fetch(),
            extract: fake_extract(Rc::new(Cell::new(0))),
        }
    }

    fn names(root: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(root)
            .map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
            .unwrap_or_default();
        v.sort();
        v
    }

    #[test]
    fn a_missing_node_is_downloaded_checked_and_unpacked_into_its_folder() {
        let root = temp_root();
        let server = Server::new();
        let h = host(&root, "darwin-arm64", &server);
        let mut seen = vec![];
        let rt = ensure(&h, &mut |p| seen.push((p.name.to_string(), p.done, p.total))).unwrap();
        let dir = root.join("node-22.23.5-darwin-arm64");
        assert_eq!(rt.node, dir.join("bin").join("node"));
        assert_eq!(std::fs::read_to_string(&rt.node).unwrap(), "v22.23.5");
        assert_eq!(rt.path, vec![dir.join("bin")]);
        assert_eq!(names(&root), ["node-22.23.5-darwin-arm64"], "no download or temporary folder left beside it");
        let total = server.files[&node_url("darwin-arm64")].len() as u64;
        assert_eq!(seen.first(), Some(&("node".to_string(), 0, Some(total))));
        assert_eq!(seen.last(), Some(&("node".to_string(), total, Some(total))));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_ne!(std::fs::metadata(&rt.node).unwrap().permissions().mode() & 0o111, 0, "node stays executable");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn windows_node_comes_from_its_zip_with_node_exe_at_the_top() {
        let root = temp_root();
        let server = Server::new();
        let rt = ensure(&host(&root, "win-x64", &server), &mut |_| {}).unwrap();
        let dir = root.join("node-22.23.5-win-x64");
        assert_eq!(rt.node, dir.join("node.exe"));
        assert_eq!(std::fs::read_to_string(&rt.node).unwrap(), "v22.23.5");
        assert_eq!(rt.path, vec![dir], "npm.cmd and npx.cmd sit beside node.exe");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_present_runtime_is_used_without_a_download_and_another_targets_counts_as_missing() {
        let root = temp_root();
        let server = Server::new();
        // An Intel Mac's Node, moved with the home to Apple Silicon.
        let intel = ensure(&host(&root, "darwin-x64", &server), &mut |_| {}).unwrap();
        assert_eq!(server.fetches.get(), 1);
        let h = host(&root, "darwin-arm64", &server);
        let arm = ensure(&h, &mut |_| {}).unwrap();
        assert_eq!(server.fetches.get(), 2, "the other architecture's Node is not this one");
        assert_ne!(arm.node, intel.node);
        assert_eq!(ensure(&h, &mut |_| {}).unwrap(), arm);
        assert_eq!(server.fetches.get(), 2, "present and complete: no download");
        // A folder at the final path without its node (emptied by hand) is not complete: fetched again, not an error.
        std::fs::remove_file(&arm.node).unwrap();
        assert_eq!(ensure(&h, &mut |_| {}).unwrap(), arm);
        assert_eq!(server.fetches.get(), 3);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_hash_mismatch_leaves_nothing_at_the_final_path_and_names_the_archive() {
        let root = temp_root();
        let server = Server::new();
        let mut h = host(&root, "linux-x64", &server);
        h.manifest.node.targets.get_mut("linux-x64").unwrap().sha256 = sha256(b"something else");
        let err = ensure(&h, &mut |_| {}).unwrap_err();
        assert!(err.contains("node-v22.23.5-linux-x64.tar.gz"), "{err}");
        assert!(err.contains("checksum"), "{err}");
        assert!(names(&root).is_empty(), "nothing kept: {:?}", names(&root));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A body that gives `n` bytes of `bytes` and then fails, as a connection dropped mid-download does.
    struct CutOff(std::io::Cursor<Vec<u8>>);
    impl Read for CutOff {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            match self.0.read(buf)? {
                0 => Err(std::io::Error::new(std::io::ErrorKind::ConnectionReset, "connection reset")),
                n => Ok(n),
            }
        }
    }

    #[test]
    fn a_download_cut_off_partway_leaves_nothing_and_the_next_attempt_starts_clean() {
        let root = temp_root();
        let server = Server::new();
        let mut h = host(&root, "darwin-arm64", &server);
        let body = server.files[&node_url("darwin-arm64")].clone();
        let half = body[..body.len() / 2].to_vec();
        let total = body.len() as u64;
        h.fetch =
            Box::new(move |_| Ok((Box::new(CutOff(std::io::Cursor::new(half.clone()))) as Box<dyn Read>, Some(total))));
        let err = ensure(&h, &mut |_| {}).unwrap_err();
        assert!(err.contains("could not download node-v22.23.5-darwin-arm64.tar.gz"), "{err}");
        assert!(names(&root).is_empty(), "nothing kept: {:?}", names(&root));
        // A launch that died mid-unpack left a temporary folder with junk in it: the next attempt clears it.
        let stale = root.join(".node-22.23.5-darwin-arm64.unpack");
        std::fs::create_dir_all(stale.join("junk")).unwrap();
        h.fetch = server.fetch();
        let rt = ensure(&h, &mut |_| {}).unwrap();
        assert_eq!(std::fs::read_to_string(&rt.node).unwrap(), "v22.23.5");
        assert_eq!(names(&root), ["node-22.23.5-darwin-arm64"]);
        assert!(!root.join("node-22.23.5-darwin-arm64").join("junk").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn each_system_and_architecture_picks_its_own_target_and_an_unknown_one_is_an_error() {
        assert_eq!(target("macos", "aarch64"), Ok("darwin-arm64"));
        assert_eq!(target("macos", "x86_64"), Ok("darwin-x64"));
        assert_eq!(target("windows", "x86_64"), Ok("win-x64"));
        assert_eq!(target("linux", "x86_64"), Ok("linux-x64"));
        let err = target("linux", "aarch64").unwrap_err();
        assert!(err.contains("linux") && err.contains("aarch64"), "{err}");
        assert!(target("freebsd", "x86_64").is_err());
        // Each target unpacks its own archive.
        let server = Server::new();
        for t in ["darwin-arm64", "darwin-x64", "linux-x64", "win-x64"] {
            let root = temp_root();
            let rt = ensure(&host(&root, t, &server), &mut |_| {}).unwrap();
            assert!(rt.node.starts_with(root.join(format!("node-22.23.5-{t}"))), "{t}: {:?}", rt.node);
            let _ = std::fs::remove_dir_all(&root);
        }
    }

    #[test]
    fn the_compiled_manifest_names_a_checked_node_for_every_target_and_portable_git_for_windows() {
        let m = Manifest::compiled().unwrap();
        let version = node::parse_version(&m.node.version).unwrap();
        assert!(version >= node::NODE_MIN, "{}", m.node.version);
        let hex = |s: &str| s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit());
        for t in ["darwin-arm64", "darwin-x64", "linux-x64", "win-x64"] {
            let a = &m.node.targets[t];
            let ext = if t == "win-x64" { "zip" } else { "tar.gz" };
            assert_eq!(a.url, format!("https://nodejs.org/dist/v{0}/node-v{0}-{t}.{ext}", m.node.version));
            assert!(hex(&a.sha256), "{t}: {}", a.sha256);
        }
        let git = &m.git.targets["win-x64"];
        assert!(git.url.starts_with("https://github.com/git-for-windows/git/releases/download/"), "{}", git.url);
        assert!(git.url.ends_with(&format!("PortableGit-{}-64-bit.7z.exe", m.git.version)), "{}", git.url);
        assert!(hex(&git.sha256));
    }

    #[test]
    fn pruning_after_a_start_removes_other_versions_and_keeps_the_running_one() {
        let root = temp_root();
        let server = Server::new();
        let mut h = host(&root, "win-x64", &server);
        h.git = true;
        let rt = ensure(&h, &mut |_| {}).unwrap();
        for old in ["node-22.19.0-win-x64", "node-22.23.5-darwin-x64", "git-2.50.0-win-x64"] {
            std::fs::create_dir_all(root.join(old).join("bin")).unwrap();
        }
        std::fs::create_dir_all(root.join("elsewhere")).unwrap();
        prune(&h);
        assert_eq!(names(&root), ["elsewhere", "git-2.56.1-win-x64", "node-22.23.5-win-x64"]);
        assert!(rt.node.is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn on_windows_portable_git_is_fetched_only_when_git_or_git_bash_is_missing() {
        let home = temp_root();
        let program_files = home.join("Program Files");
        let tools = home.join("tools");
        let windows_host = |path: &Path| node::Host {
            os: node::Os::Windows,
            home: home.clone(),
            root: home.clone(),
            path: Some(format!("{};", path.display())),
            var: Box::new({
                let pf = program_files.clone();
                move |k| (k == "ProgramFiles").then(|| pf.clone().into_os_string())
            }),
            version: Box::new(|_| None),
        };
        assert!(git_missing(&windows_host(&tools)), "neither git nor Git Bash");
        std::fs::create_dir_all(&tools).unwrap();
        std::fs::write(tools.join("git.exe"), b"").unwrap();
        assert!(git_missing(&windows_host(&tools)), "git on PATH, no Git Bash");
        std::fs::create_dir_all(program_files.join("Git").join("bin")).unwrap();
        std::fs::write(program_files.join("Git").join("bin").join("bash.exe"), b"").unwrap();
        assert!(!git_missing(&windows_host(&tools)), "git on PATH and Git for Windows' bash");
        std::fs::remove_dir_all(program_files.join("Git")).unwrap();
        std::fs::write(tools.join("bash.exe"), b"").unwrap();
        assert!(!git_missing(&windows_host(&tools)), "a bash.exe on PATH counts, as the daemon's shell lookup has it");
        std::fs::remove_file(tools.join("git.exe")).unwrap();
        assert!(git_missing(&windows_host(&tools)), "Git Bash but no git");
        let mac = node::Host { os: node::Os::Macos, ..windows_host(&tools) };
        assert!(!git_missing(&mac), "the Mac's git is Welcome's step, not PortableGit");

        let root = home.join("runtime");
        let server = Server::new();
        let ran = Rc::new(Cell::new(0));
        let mut h = host(&root, "win-x64", &server);
        h.extract = fake_extract(ran.clone());
        let rt = ensure(&h, &mut |_| {}).unwrap();
        assert_eq!(ran.get(), 0, "git and Git Bash present: no PortableGit");
        assert_eq!(rt.path.len(), 1);
        h.git = true;
        let mut fetched = vec![];
        let rt = ensure(&h, &mut |p| fetched.push(p.name.to_string())).unwrap();
        assert_eq!(ran.get(), 1, "the self-extractor ran once its hash checked");
        let git = root.join("git-2.56.1-win-x64");
        assert_eq!(rt.path, vec![root.join("node-22.23.5-win-x64"), git.join("cmd"), git.join("bin")]);
        assert!(git.join("cmd").join("git.exe").is_file());
        assert!(fetched.iter().all(|n| n == "git"), "Node was already there: {fetched:?}");
        assert_eq!(names(&root), ["git-2.56.1-win-x64", "node-22.23.5-win-x64"]);
        let _ = std::fs::remove_dir_all(&home);
    }
}
