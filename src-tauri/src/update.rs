use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime};
use tauri::utils::config::BundleType;

pub const UPDATE_EVENT: &str = "loki:update";

const STABLE_URL: &str = "https://github.com/AlmondLabs/loki/releases/latest/download/latest.json";
const NIGHTLY_URL: &str = "https://github.com/AlmondLabs/loki/releases/download/nightly/latest.json";

const OVERRIDE_VAR: &str = "LOKI_UPDATE_URL";

const CHANNEL_FILE: &str = "updates.json";

const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// How often the check loop wakes to see whether a check is due. It reads the wall clock rather than sleeping six
/// hours, which would not count the hours a laptop sleeps.
const WAKE_EVERY: Duration = Duration::from_secs(10 * 60);

const CHECK_TIMEOUT: Duration = Duration::from_secs(60);

const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Channel {
    Stable,
    Nightly,
}

impl Channel {
    pub fn of(version: &str) -> Channel {
        if version.contains("-nightly.") {
            Channel::Nightly
        } else {
            Channel::Stable
        }
    }
}

/// Where an Electron loki's release says it exists: `desktop.json`, beside the channel's `latest.json`.
pub fn desktop_endpoint(endpoint: &str) -> String {
    match endpoint.rsplit_once('/') {
        Some((folder, _)) => format!("{folder}/desktop.json"),
        None => "desktop.json".to_string(),
    }
}

pub fn endpoint(channel: Channel, override_url: Option<&str>) -> String {
    match override_url.filter(|u| !u.is_empty()) {
        Some(url) => url.to_string(),
        None => match channel {
            Channel::Stable => STABLE_URL.to_string(),
            Channel::Nightly => NIGHTLY_URL.to_string(),
        },
    }
}

/// A Ready update that could not install as loki quit, and why, kept until that version or a newer one runs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FailedInstall {
    pub version: String,
    pub message: String,
}

/// `updates.json` as loki writes it: the channel, and the last install that failed as loki quit, if any.
#[derive(Serialize, Deserialize)]
struct UpdatesFile {
    channel: Channel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    failed_install: Option<FailedInstall>,
}

fn read_file(dir: &Path) -> Option<UpdatesFile> {
    let text = std::fs::read_to_string(dir.join(CHANNEL_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_file(dir: &Path, file: &UpdatesFile) -> Result<(), String> {
    let path = dir.join(CHANNEL_FILE);
    let text = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(dir)
        .and_then(|()| std::fs::write(&path, text + "\n"))
        .map_err(|e| format!("could not write {}: {e}", path.display()))
}

pub fn save_channel(dir: &Path, channel: Channel) -> Result<(), String> {
    let failed_install = read_file(dir).and_then(|f| f.failed_install);
    write_file(dir, &UpdatesFile { channel, failed_install })
}

fn installed(current: &str, version: &str) -> bool {
    match (semver::Version::parse(current), semver::Version::parse(version)) {
        (Ok(current), Ok(version)) => current >= version,
        _ => true,
    }
}

/// What failed: the check, the download, the signature check of what was downloaded, or the install: Restart to
/// Update's, the one as loki last quit, or one the Mac's app folder would allow only an administrator.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Check,
    Download,
    Signature,
    Install,
}

/// Why this loki never checks: a development build (`tauri dev`), or a Linux install from the `.deb`, which updates
/// from the releases page; only the AppImage replaces itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Unsupported {
    Development,
    Package,
}

/// Where an update stands, as the page shows it (the state diagram in plan 2026-11-15-2319). `kind` names the state;
/// `total` is null until the server has said it. Failed counts as Idle: the next check runs as usual.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UpdateState {
    Idle,
    Checking,
    Downloading { done: u64, total: Option<u64> },
    Ready { version: String },
    Failed { stage: Stage, message: String },
    Unsupported { reason: Unsupported },
}

/// What `update_status` answers and `loki:update` carries: the channel, the running version, the update's state, and
/// `moved`: whether an Electron loki has been released on this channel, which this app cannot update to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct UpdateStatus {
    pub channel: Channel,
    pub current: String,
    pub state: UpdateState,
    pub moved: bool,
}

/// Why a build never checks, if it does not: `release` is false in a development build, `os` is
/// `std::env::consts::OS`, and `bundle` is what the bundler stamped into this binary
/// (`tauri::utils::platform::bundle_type`). Not the `APPIMAGE` variable: any program an AppImage starts inherits it.
pub fn unsupported(release: bool, os: &str, bundle: Option<BundleType>) -> Option<Unsupported> {
    if !release {
        Some(Unsupported::Development)
    } else if os == "linux" && bundle != Some(BundleType::AppImage) {
        Some(Unsupported::Package)
    } else {
        None
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    pub stage: Stage,
    pub message: String,
}

pub trait Found: Send + Sync {
    fn version(&self) -> &str;
    fn installable(&self) -> Result<(), String>;
    fn download(&self, on_chunk: &mut dyn FnMut(usize, Option<u64>)) -> Result<Vec<u8>, Failure>;
    /// Install the verified bytes. With `relaunch`, Windows' installer opens loki again once it is done; without it,
    /// it only installs. Windows' install ends this process when the installer starts.
    fn install(&self, bytes: &[u8], relaunch: bool) -> Result<(), String>;
}

pub trait Remote {
    fn check(&self, endpoint: &str) -> Result<Option<Box<dyn Found>>, String>;
    /// Whether `endpoint` (a `desktop_endpoint`) is there: true when it answers, false when it is not found.
    fn moved(&self, endpoint: &str) -> Result<bool, String>;
}

struct Held {
    found: Box<dyn Found>,
    bytes: Vec<u8>,
}

struct Inner {
    channel: Channel,
    state: UpdateState,
    held: Option<Held>,
    moved: bool,
}

pub struct Updates {
    current: String,
    override_url: Option<String>,
    dir: Option<PathBuf>,
    inner: Mutex<Inner>,
}

fn progress_step(done: u64, total: Option<u64>) -> u64 {
    match total {
        Some(t) if t > 0 => done.saturating_mul(100) / t,
        _ => done >> 20,
    }
}

pub fn check_due(last: Option<SystemTime>, now: SystemTime) -> bool {
    last.is_none_or(|t| !matches!(now.duration_since(t), Ok(d) if d < CHECK_EVERY))
}

pub fn last_check_at_launch(state: &UpdateState, now: SystemTime) -> Option<SystemTime> {
    matches!(state, UpdateState::Failed { stage: Stage::Install, .. }).then_some(now)
}

/// Why installing into the app bundle `exe` runs from (`…/loki.app/Contents/MacOS/loki`) would need an administrator,
/// if it would: the install renames loki.app inside its folder, which `writable` says this user may change or not.
/// The Mac's updater asks for the password itself when it may not, as loki quits, which would be a surprise. None for
/// a binary outside a bundle.
pub fn install_problem(exe: &Path, writable: &dyn Fn(&Path) -> bool) -> Option<String> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    if macos.file_name()? != "MacOS" || contents.file_name()? != "Contents" {
        return None;
    }
    let folder = contents.parent()?.parent()?;
    (!writable(folder)).then(|| {
        format!(
            "loki can't update itself in {}. Move it to a folder you can change, such as ~/Applications, to get updates.",
            folder.display()
        )
    })
}

#[cfg(unix)]
fn writable(folder: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = std::ffi::CString::new(folder.as_os_str().as_bytes()) else { return false };
    unsafe { libc::access(path.as_ptr(), libc::W_OK) == 0 }
}

#[cfg(not(unix))]
fn writable(_folder: &Path) -> bool {
    true
}

impl Updates {
    pub fn new(
        current: &str,
        channel: Channel,
        override_url: Option<String>,
        unsupported: Option<Unsupported>,
    ) -> Self {
        let state = match unsupported {
            Some(reason) => UpdateState::Unsupported { reason },
            None => UpdateState::Idle,
        };
        Updates {
            current: current.to_string(),
            override_url,
            dir: None,
            inner: Mutex::new(Inner { channel, state, held: None, moved: false }),
        }
    }

    pub fn open(dir: &Path, current: &str, override_url: Option<String>, unsupported: Option<Unsupported>) -> Self {
        let (saved, failed) = match read_file(dir) {
            Some(file) => (Some(file.channel), file.failed_install),
            None => (None, None),
        };
        let channel = saved.unwrap_or_else(|| Channel::of(current));
        if unsupported.is_some() {
            return Updates::new(current, channel, override_url, unsupported);
        }
        let mut state = UpdateState::Idle;
        let forgotten = match failed {
            Some(failed) if !installed(current, &failed.version) => {
                state = UpdateState::Failed { stage: Stage::Install, message: failed.message };
                false
            }
            Some(_) => true,
            None => false,
        };
        if saved.is_none() || forgotten {
            if let Err(e) = write_file(dir, &UpdatesFile { channel, failed_install: None }) {
                eprintln!("loki: update: {e}");
            }
        }
        Updates {
            current: current.to_string(),
            override_url,
            dir: Some(dir.to_path_buf()),
            inner: Mutex::new(Inner { channel, state, held: None, moved: false }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn status(&self) -> UpdateStatus {
        let inner = self.lock();
        UpdateStatus {
            channel: inner.channel,
            current: self.current.clone(),
            state: inner.state.clone(),
            moved: inner.moved,
        }
    }

    pub fn set_channel(&self, channel: Channel) {
        self.lock().channel = channel;
    }

    fn settle(&self, state: UpdateState, held: Option<Held>, publish: &mut dyn FnMut(UpdateStatus)) {
        {
            let mut inner = self.lock();
            inner.state = state;
            inner.held = held;
        }
        publish(self.status());
    }

    pub fn check(&self, remote: &dyn Remote, publish: &mut dyn FnMut(UpdateStatus)) {
        let url = {
            let mut inner = self.lock();
            if !matches!(inner.state, UpdateState::Idle | UpdateState::Failed { .. }) {
                return;
            }
            inner.state = UpdateState::Checking;
            endpoint(inner.channel, self.override_url.as_deref())
        };
        publish(self.status());
        let desktop = desktop_endpoint(&url);
        match remote.moved(&desktop) {
            Ok(moved) => self.lock().moved = moved,
            Err(message) => eprintln!("loki: update: check of {desktop} failed: {message}"),
        }
        let found = match remote.check(&url) {
            Ok(Some(found)) => found,
            Ok(None) => return self.settle(UpdateState::Idle, None, publish),
            Err(message) => {
                eprintln!("loki: update: check of {url} failed: {message}");
                return self.settle(UpdateState::Failed { stage: Stage::Check, message }, None, publish);
            }
        };
        if let Err(message) = found.installable() {
            eprintln!("loki: update: not downloading {}: {message}", found.version());
            return self.settle(UpdateState::Failed { stage: Stage::Install, message }, None, publish);
        }
        eprintln!("loki: update: downloading {}", found.version());
        self.settle(UpdateState::Downloading { done: 0, total: None }, None, publish);
        let (mut done, mut shown) = (0u64, progress_step(0, None));
        let result = found.download(&mut |chunk, total| {
            done = done.saturating_add(chunk as u64);
            let step = progress_step(done, total);
            if step != shown {
                shown = step;
                self.settle(UpdateState::Downloading { done, total }, None, publish);
            }
        });
        match result {
            Ok(bytes) => {
                let version = found.version().to_string();
                eprintln!("loki: update: {version} is ready and installs when loki quits");
                self.settle(UpdateState::Ready { version }, Some(Held { found, bytes }), publish);
            }
            Err(Failure { stage, message }) => {
                eprintln!("loki: update: {} failed at {stage:?}: {message}", found.version());
                self.settle(UpdateState::Failed { stage, message }, None, publish);
            }
        }
    }

    fn take(&self) -> Option<Held> {
        self.lock().held.take()
    }

    pub fn quit(&self, stop_daemon: &mut dyn FnMut()) {
        stop_daemon();
        let Some(held) = self.take() else { return };
        let version = held.found.version().to_string();
        eprintln!("loki: update: installing {version} as loki quits");
        if let Err(message) = held.found.install(&held.bytes, false) {
            eprintln!("loki: update: could not install {version}: {message}");
            if let Some(dir) = &self.dir {
                let file = UpdatesFile {
                    channel: self.lock().channel,
                    failed_install: Some(FailedInstall { version, message }),
                };
                if let Err(e) = write_file(dir, &file) {
                    eprintln!("loki: update: {e}");
                }
            }
        }
    }

    pub fn restart(
        &self,
        installer_exits: bool,
        stop_daemon: &mut dyn FnMut(),
        start_daemon: &mut dyn FnMut(),
        publish: &mut dyn FnMut(UpdateStatus),
    ) -> Result<(), String> {
        let Some(held) = self.take() else { return Err("no update is ready".into()) };
        if installer_exits {
            stop_daemon();
        }
        match held.found.install(&held.bytes, true) {
            Ok(()) => {
                if !installer_exits {
                    stop_daemon();
                }
                Ok(())
            }
            Err(message) => {
                eprintln!("loki: update: could not install {}: {message}", held.found.version());
                if installer_exits {
                    start_daemon();
                }
                self.settle(UpdateState::Failed { stage: Stage::Install, message: message.clone() }, None, publish);
                Err(message)
            }
        }
    }
}

fn stage_of(e: &tauri_plugin_updater::Error) -> Stage {
    use tauri_plugin_updater::Error as E;
    match e {
        E::Minisign(_)
        | E::Base64(_)
        | E::SignatureUtf8(_)
        | E::SignedVersionMismatch { .. }
        | E::MissingSignedVersion => Stage::Signature,
        _ => Stage::Download,
    }
}

struct Plugin(tauri::AppHandle);

impl Remote for Plugin {
    fn check(&self, endpoint: &str) -> Result<Option<Box<dyn Found>>, String> {
        use tauri_plugin_updater::UpdaterExt;
        let url = tauri::Url::parse(endpoint).map_err(|e| format!("{endpoint}: {e}"))?;
        let updater = self
            .0
            .updater_builder()
            .timeout(CHECK_TIMEOUT)
            .endpoints(vec![url])
            .and_then(|b| b.build())
            .map_err(|e| e.to_string())?;
        let found = tauri::async_runtime::block_on(updater.check()).map_err(|e| e.to_string())?;
        Ok(found.map(|u| Box::new(PluginFound(u)) as Box<dyn Found>))
    }

    fn moved(&self, endpoint: &str) -> Result<bool, String> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::blocking::Client::builder()
            .user_agent(concat!("loki/", env!("CARGO_PKG_VERSION")))
            .timeout(CHECK_TIMEOUT)
            .build()
            .map_err(|e| e.to_string())?;
        let status = client.get(endpoint).send().map_err(|e| e.to_string())?.status();
        if status.is_success() {
            Ok(true)
        } else if status == reqwest::StatusCode::NOT_FOUND {
            Ok(false)
        } else {
            Err(format!("{endpoint} answered {status}"))
        }
    }
}

/// A plugin `Update` as `Found`. Its `download` checks the signature against the key in tauri.conf.json before it
/// returns the bytes. Its Windows install passes the NSIS installer `/P /UPDATE`, and `/R` (relaunch) only when
/// `restart_after_install` is left on (tauri-plugin-updater 2.12, `updater_parameters`).
struct PluginFound(tauri_plugin_updater::Update);

impl Found for PluginFound {
    fn version(&self) -> &str {
        &self.0.version
    }

    fn installable(&self) -> Result<(), String> {
        if !cfg!(target_os = "macos") {
            return Ok(());
        }
        let exe = std::env::current_exe().map_err(|e| format!("could not find loki's own app: {e}"))?;
        install_problem(&exe, &writable).map_or(Ok(()), Err)
    }

    fn download(&self, on_chunk: &mut dyn FnMut(usize, Option<u64>)) -> Result<Vec<u8>, Failure> {
        // The plugin makes each Update with no timeout of its own: the check's covers only the check.
        let mut update = self.0.clone();
        update.timeout = Some(DOWNLOAD_TIMEOUT);
        tauri::async_runtime::block_on(update.download(on_chunk, || {}))
            .map_err(|e| Failure { stage: stage_of(&e), message: e.to_string() })
    }

    fn install(&self, bytes: &[u8], relaunch: bool) -> Result<(), String> {
        self.0.clone().restart_after_install(relaunch).install(bytes).map_err(|e| e.to_string())
    }
}

fn publish(app: &tauri::AppHandle, status: UpdateStatus) {
    use tauri::Emitter;
    if let Err(e) = app.emit(UPDATE_EVENT, status) {
        eprintln!("loki: {UPDATE_EVENT}: {e}");
    }
}

fn check_now(app: &tauri::AppHandle) {
    use tauri::Manager;
    app.state::<Updates>().check(&Plugin(app.clone()), &mut |s| publish(app, s));
}

pub fn start(app: &tauri::AppHandle, dir: &Path) {
    use tauri::Manager;
    let current = app.package_info().version.to_string();
    let bundle = tauri::utils::platform::bundle_type();
    let reason = unsupported(!cfg!(debug_assertions), std::env::consts::OS, bundle);
    let override_url = std::env::var(OVERRIDE_VAR).ok().filter(|u| !u.is_empty());
    if let Some(url) = &override_url {
        eprintln!("loki: update: checking {url} ({OVERRIDE_VAR})");
    }
    let updates = Updates::open(dir, &current, override_url, reason);
    let mut last = last_check_at_launch(&updates.status().state, SystemTime::now());
    app.manage(updates);
    if reason.is_some() {
        return;
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("loki-update-checker".into()).spawn(move || loop {
        let now = SystemTime::now();
        if check_due(last, now) {
            last = Some(now);
            check_now(&app);
        }
        std::thread::sleep(WAKE_EVERY);
    });
    if let Err(e) = spawned {
        eprintln!("loki: update: could not start the check loop: {e}");
    }
}

#[tauri::command]
pub fn update_status(state: tauri::State<'_, Updates>) -> UpdateStatus {
    state.status()
}

/// Check for Updates: a check now, in the background; what happens goes out as `loki:update`. Nothing happens while a
/// check or download is under way, with an update Ready, or in a build that never checks.
#[tauri::command]
pub fn check_for_updates(app: tauri::AppHandle) {
    drop(tauri::async_runtime::spawn_blocking(move || check_now(&app)));
}

#[tauri::command]
pub fn set_update_channel(
    app: tauri::AppHandle,
    state: tauri::State<'_, Updates>,
    channel: Channel,
) -> Result<UpdateStatus, String> {
    save_channel(&crate::loki_dir(), channel)?;
    state.set_channel(channel);
    let status = state.status();
    publish(&app, status.clone());
    Ok(status)
}

/// Restart to Update: stop the daemon, install the Ready update and open the new version. The page decides first
/// whether a chat is working and asks the person (R11); the shell has no daemon client and asks nothing.
#[tauri::command]
pub async fn restart_to_update(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let stop = &mut || {
            if let Some(h) = app.try_state::<crate::harness::Harness>() {
                h.stop();
            }
        };
        let start = &mut || {
            if let Err(e) = crate::start_daemon(&app) {
                eprintln!("loki: {e}");
            }
        };
        app.state::<Updates>().restart(cfg!(windows), stop, start, &mut |s| publish(&app, s))?;
        app.restart()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::sync::Arc;

    type Log = Arc<Mutex<Vec<String>>>;

    fn entries(log: &Log) -> Vec<String> {
        log.lock().unwrap().clone()
    }

    struct FakeFound {
        version: String,
        chunks: Vec<usize>,
        total: Option<u64>,
        end: Result<Vec<u8>, Failure>,
        install: Result<(), String>,
        installable: Result<(), String>,
        log: Log,
    }

    impl Found for FakeFound {
        fn version(&self) -> &str {
            &self.version
        }
        fn installable(&self) -> Result<(), String> {
            self.installable.clone()
        }
        fn download(&self, on_chunk: &mut dyn FnMut(usize, Option<u64>)) -> Result<Vec<u8>, Failure> {
            for c in &self.chunks {
                on_chunk(*c, self.total);
            }
            self.end.clone()
        }
        fn install(&self, bytes: &[u8], relaunch: bool) -> Result<(), String> {
            let bytes = String::from_utf8_lossy(bytes);
            self.log.lock().unwrap().push(format!("install {} {bytes} relaunch={relaunch}", self.version));
            self.install.clone()
        }
    }

    fn found(log: &Log) -> FakeFound {
        FakeFound {
            version: "2026.1120.0".into(),
            chunks: vec![4, 4],
            total: Some(8),
            end: Ok(b"verified".to_vec()),
            install: Ok(()),
            installable: Ok(()),
            log: log.clone(),
        }
    }

    struct FakeRemote {
        answer: RefCell<Option<Result<Option<FakeFound>, String>>>,
        asked: RefCell<Vec<String>>,
        checks: Cell<usize>,
        moved: RefCell<Result<bool, String>>,
        asked_moved: RefCell<Vec<String>>,
    }

    impl FakeRemote {
        fn new(answer: Result<Option<FakeFound>, String>) -> Self {
            FakeRemote {
                answer: RefCell::new(Some(answer)),
                asked: RefCell::new(vec![]),
                checks: Cell::new(0),
                moved: RefCell::new(Ok(false)),
                asked_moved: RefCell::new(vec![]),
            }
        }
    }

    impl Remote for FakeRemote {
        fn check(&self, endpoint: &str) -> Result<Option<Box<dyn Found>>, String> {
            self.checks.set(self.checks.get() + 1);
            self.asked.borrow_mut().push(endpoint.to_string());
            let answer = self.answer.borrow_mut().take().unwrap_or(Ok(None));
            answer.map(|f| f.map(|f| Box::new(f) as Box<dyn Found>))
        }
        fn moved(&self, endpoint: &str) -> Result<bool, String> {
            self.asked_moved.borrow_mut().push(endpoint.to_string());
            self.moved.borrow().clone()
        }
    }

    #[test]
    fn desktop_json_sits_beside_each_channels_latest_json() {
        assert_eq!(
            desktop_endpoint(STABLE_URL),
            "https://github.com/AlmondLabs/loki/releases/latest/download/desktop.json"
        );
        assert_eq!(
            desktop_endpoint(NIGHTLY_URL),
            "https://github.com/AlmondLabs/loki/releases/download/nightly/desktop.json"
        );
        assert_eq!(
            desktop_endpoint("https://github.com/AlmondLabs/loki/releases/download/try-b/latest.json"),
            "https://github.com/AlmondLabs/loki/releases/download/try-b/desktop.json"
        );
    }

    #[test]
    fn a_check_marks_the_move_once_desktop_json_is_there_and_keeps_it_through_an_error() {
        let u = updates(Channel::Nightly);
        let remote = FakeRemote::new(Ok(None));
        check(&u, &remote);
        assert!(!u.status().moved, "a 404 is no move");
        assert_eq!(
            remote.asked_moved.borrow().as_slice(),
            ["https://github.com/AlmondLabs/loki/releases/download/nightly/desktop.json"]
        );

        *remote.moved.borrow_mut() = Ok(true);
        let mut published = vec![];
        u.check(&remote, &mut |s| published.push(s.moved));
        assert!(u.status().moved);
        assert_eq!(published.last(), Some(&true), "the move goes out with the check's last status");

        *remote.moved.borrow_mut() = Err("offline".into());
        check(&u, &remote);
        assert!(u.status().moved, "a failed check of desktop.json keeps what loki knew");
    }

    fn updates(channel: Channel) -> Updates {
        Updates::new("2026.1116.0", channel, None, None)
    }

    fn check(u: &Updates, remote: &FakeRemote) -> Vec<UpdateState> {
        let mut seen = vec![];
        u.check(remote, &mut |s| seen.push(s.state));
        seen
    }

    fn temp_dir() -> std::path::PathBuf {
        crate::runtime::tests::temp_root()
    }

    fn launch_channel(dir: &Path, current: &str) -> Channel {
        Updates::open(dir, current, None, None).status().channel
    }

    fn saved(dir: &Path) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(dir.join("updates.json")).unwrap()).unwrap()
    }

    #[test]
    fn the_channel_file_starts_on_the_running_versions_channel_and_a_set_channel_survives_a_restart() {
        let dir = temp_dir().join(".loki");
        assert_eq!(launch_channel(&dir, "2026.1116.0-nightly.4821"), Channel::Nightly);
        assert_eq!(saved(&dir), serde_json::json!({ "channel": "nightly" }));
        save_channel(&dir, Channel::Stable).unwrap();
        assert_eq!(launch_channel(&dir, "2026.1116.0-nightly.4821"), Channel::Stable);
        let other = temp_dir();
        assert_eq!(launch_channel(&other, "2026.1116.0"), Channel::Stable);
        std::fs::write(other.join("updates.json"), "{ \"channel\": \"beta\" }").unwrap();
        assert_eq!(launch_channel(&other, "2026.1116.1-nightly.9"), Channel::Nightly);
        assert_eq!(launch_channel(&other, "2026.1116.0"), Channel::Nightly, "and that is the saved channel now");
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
        let _ = std::fs::remove_dir_all(&other);
    }

    #[test]
    fn a_build_that_never_checks_reads_the_channel_and_writes_nothing() {
        for reason in [Unsupported::Development, Unsupported::Package] {
            let dir = temp_dir().join(".loki");
            let u = Updates::open(&dir, "2026.10.11", None, Some(reason));
            assert_eq!(u.status().channel, Channel::Stable);
            assert_eq!(u.status().state, UpdateState::Unsupported { reason });
            assert!(!dir.join("updates.json").exists(), "{reason:?} wrote updates.json");
            save_channel(&dir, Channel::Nightly).unwrap();
            assert_eq!(Updates::open(&dir, "2026.10.11", None, Some(reason)).status().channel, Channel::Nightly);
            let _ = std::fs::remove_dir_all(dir.parent().unwrap());
        }
    }

    #[test]
    fn an_install_that_fails_as_loki_quits_is_what_about_shows_at_the_next_launch() {
        let dir = temp_dir();
        let log: Log = Arc::default();
        let u = Updates::open(&dir, "2026.1116.0", None, None);
        let denied = FakeFound { install: Err("Permission denied (os error 13)".into()), ..found(&log) };
        check(&u, &FakeRemote::new(Ok(Some(denied))));
        u.quit(&mut || {});
        assert_eq!(
            saved(&dir),
            serde_json::json!({
                "channel": "stable",
                "failed_install": { "version": "2026.1120.0", "message": "Permission denied (os error 13)" }
            })
        );
        let failed = UpdateState::Failed { stage: Stage::Install, message: "Permission denied (os error 13)".into() };
        let next = Updates::open(&dir, "2026.1116.0", None, None);
        assert_eq!(next.status().state, failed);
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000);
        assert_eq!(last_check_at_launch(&next.status().state, now), Some(now));
        assert_eq!(last_check_at_launch(&UpdateState::Idle, now), None);
        let check_failed = UpdateState::Failed { stage: Stage::Check, message: "offline".into() };
        assert_eq!(last_check_at_launch(&check_failed, now), None);
        save_channel(&dir, Channel::Nightly).unwrap();
        assert_eq!(saved(&dir)["failed_install"]["version"], "2026.1120.0");
        assert_eq!(Updates::open(&dir, "2026.1116.0", None, None).status().state, failed);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_install_is_forgotten_once_that_version_or_a_newer_one_runs() {
        let record = |dir: &Path, version: &str| {
            let text =
                serde_json::json!({ "channel": "nightly", "failed_install": { "version": version, "message": "no" } });
            std::fs::write(dir.join("updates.json"), text.to_string()).unwrap();
        };
        let failed = UpdateState::Failed { stage: Stage::Install, message: "no".into() };
        for (recorded, running, forgotten) in [
            ("2026.1120.0", "2026.1120.0", true),
            ("2026.1120.0", "2026.1121.0", true),
            ("2026.1120.0-nightly.9", "2026.1120.0", true),
            ("2026.1120.0-nightly.9", "2026.1120.0-nightly.10", true),
            ("2026.1120.0", "2026.1120.0-nightly.12", false),
            ("2026.1120.0-nightly.10", "2026.1120.0-nightly.9", false),
            ("2026.1120.0", "2026.999.0", false),
        ] {
            let dir = temp_dir();
            record(&dir, recorded);
            let state = Updates::open(&dir, running, None, None).status().state;
            if forgotten {
                assert_eq!(state, UpdateState::Idle, "{recorded} on {running}");
                assert_eq!(saved(&dir), serde_json::json!({ "channel": "nightly" }), "{recorded} on {running}");
            } else {
                assert_eq!(state, failed, "{recorded} on {running}");
                assert_eq!(saved(&dir)["failed_install"]["version"], recorded);
            }
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn an_update_the_mac_could_install_only_as_an_administrator_is_never_downloaded() {
        let log: Log = Arc::default();
        let u = updates(Channel::Stable);
        let message = "loki can't update itself in /Applications.".to_string();
        let stuck = FakeFound { installable: Err(message.clone()), ..found(&log) };
        let seen = check(&u, &FakeRemote::new(Ok(Some(stuck))));
        assert_eq!(seen, [UpdateState::Checking, UpdateState::Failed { stage: Stage::Install, message }]);
        assert!(entries(&log).is_empty(), "no download, and nothing installs at quit");
        u.quit(&mut || {});
        assert!(entries(&log).is_empty());
    }

    #[test]
    fn the_folder_that_must_be_writable_is_the_one_holding_the_app_bundle() {
        let exe = Path::new("/Applications/loki.app/Contents/MacOS/loki");
        let asked = RefCell::new(vec![]);
        let problem = install_problem(exe, &|p: &Path| {
            asked.borrow_mut().push(p.to_path_buf());
            false
        });
        assert_eq!(asked.borrow().as_slice(), [Path::new("/Applications")]);
        let problem = problem.unwrap();
        assert!(problem.contains("/Applications") && problem.contains("~/Applications"), "{problem}");
        assert_eq!(install_problem(exe, &|_: &Path| true), None);
        assert_eq!(install_problem(Path::new("/usr/local/bin/loki"), &|_: &Path| false), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_is_writable_when_this_user_may_change_it() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir();
        assert!(writable(&dir));
        assert!(!writable(&dir.join("missing")));
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        if unsafe { libc::geteuid() } != 0 {
            assert!(!writable(&dir));
        }
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stable_reads_the_latest_release_nightly_the_rolling_one_and_loki_update_url_overrides_both() {
        assert_eq!(
            endpoint(Channel::Stable, None),
            "https://github.com/AlmondLabs/loki/releases/latest/download/latest.json"
        );
        assert_eq!(
            endpoint(Channel::Nightly, None),
            "https://github.com/AlmondLabs/loki/releases/download/nightly/latest.json"
        );
        let mine = "https://github.com/AlmondLabs/loki/releases/download/try-b/latest.json";
        assert_eq!(endpoint(Channel::Stable, Some(mine)), mine);
        assert_eq!(endpoint(Channel::Nightly, Some(mine)), mine);
        assert_eq!(endpoint(Channel::Nightly, Some("")), NIGHTLY_URL, "an empty variable is no override");
        let u = Updates::new("2026.1116.0", Channel::Stable, None, None);
        u.set_channel(Channel::Nightly);
        let remote = FakeRemote::new(Ok(None));
        check(&u, &remote);
        assert_eq!(remote.asked.borrow().as_slice(), [NIGHTLY_URL]);
        let o = Updates::new("2026.1116.0", Channel::Stable, Some(mine.into()), None);
        let remote = FakeRemote::new(Ok(None));
        check(&o, &remote);
        assert_eq!(remote.asked.borrow().as_slice(), [mine]);
    }

    #[test]
    fn a_newer_version_downloads_in_the_background_and_waits_ready_in_memory() {
        let log: Log = Arc::default();
        let u = updates(Channel::Stable);
        let remote = FakeRemote::new(Ok(Some(found(&log))));
        let seen = check(&u, &remote);
        assert_eq!(
            seen,
            [
                UpdateState::Checking,
                UpdateState::Downloading { done: 0, total: None },
                UpdateState::Downloading { done: 4, total: Some(8) },
                UpdateState::Downloading { done: 8, total: Some(8) },
                UpdateState::Ready { version: "2026.1120.0".into() },
            ]
        );
        assert!(entries(&log).is_empty(), "nothing installs before loki quits");
        let none = updates(Channel::Stable);
        assert_eq!(check(&none, &FakeRemote::new(Ok(None))), [UpdateState::Checking, UpdateState::Idle]);
    }

    #[test]
    fn a_failed_check_is_a_status_and_the_next_check_runs() {
        let u = updates(Channel::Stable);
        let failed = UpdateState::Failed { stage: Stage::Check, message: "could not reach github.com".into() };
        assert_eq!(
            check(&u, &FakeRemote::new(Err("could not reach github.com".into()))),
            [UpdateState::Checking, failed]
        );
        let remote = FakeRemote::new(Ok(None));
        assert_eq!(check(&u, &remote), [UpdateState::Checking, UpdateState::Idle]);
        assert_eq!(remote.checks.get(), 1);
    }

    #[test]
    fn a_download_whose_signature_does_not_verify_never_reaches_ready_and_quitting_installs_nothing() {
        for (stage, message) in
            [(Stage::Signature, "signature verification failed"), (Stage::Download, "connection reset")]
        {
            let log: Log = Arc::default();
            let u = updates(Channel::Stable);
            let bad = FakeFound { end: Err(Failure { stage, message: message.into() }), ..found(&log) };
            let seen = check(&u, &FakeRemote::new(Ok(Some(bad))));
            assert!(!seen.iter().any(|s| matches!(s, UpdateState::Ready { .. })), "{seen:?}");
            assert_eq!(u.status().state, UpdateState::Failed { stage, message: message.into() });
            let stops = Cell::new(0);
            u.quit(&mut || stops.set(stops.get() + 1));
            assert_eq!(stops.get(), 1);
            assert!(entries(&log).is_empty(), "nothing is replaced");
            let restart = u.restart(false, &mut || {}, &mut || {}, &mut |_| {});
            assert!(restart.is_err(), "and there is nothing to restart into");
        }
    }

    #[test]
    fn plugin_errors_about_the_key_or_signature_are_the_signature_stage_and_the_rest_the_download() {
        use tauri_plugin_updater::Error as E;
        assert_eq!(stage_of(&E::SignatureUtf8("x".into())), Stage::Signature);
        assert_eq!(stage_of(&E::MissingSignedVersion), Stage::Signature);
        let mismatch = E::SignedVersionMismatch { signed: "2026.1119.2".into(), announced: "2026.1120.0".into() };
        assert_eq!(stage_of(&mismatch), Stage::Signature);
        assert_eq!(stage_of(&E::Network("Download request failed with status: 404".into())), Stage::Download);
        assert_eq!(stage_of(&E::Io(std::io::Error::other("cut off"))), Stage::Download);
    }

    #[test]
    fn a_check_while_downloading_or_with_an_update_ready_does_nothing() {
        let log: Log = Arc::default();
        let u = updates(Channel::Stable);
        u.lock().state = UpdateState::Downloading { done: 1, total: None };
        let remote = FakeRemote::new(Ok(Some(found(&log))));
        assert!(check(&u, &remote).is_empty());
        u.lock().state = UpdateState::Checking;
        assert!(check(&u, &remote).is_empty());
        assert_eq!(remote.checks.get(), 0);
        let ready = updates(Channel::Stable);
        check(&ready, &FakeRemote::new(Ok(Some(found(&log)))));
        let again = FakeRemote::new(Ok(Some(FakeFound { version: "2026.1121.0".into(), ..found(&log) })));
        assert!(check(&ready, &again).is_empty());
        assert_eq!(again.checks.get(), 0);
        assert_eq!(ready.status().state, UpdateState::Ready { version: "2026.1120.0".into() });
    }

    #[test]
    fn quitting_with_an_update_ready_stops_the_daemon_then_installs_once_and_without_one_installs_nothing() {
        let log: Log = Arc::default();
        let u = updates(Channel::Stable);
        check(&u, &FakeRemote::new(Ok(Some(found(&log)))));
        let stop_log = log.clone();
        u.quit(&mut || stop_log.lock().unwrap().push("stop daemon".into()));
        assert_eq!(entries(&log), ["stop daemon", "install 2026.1120.0 verified relaunch=false"]);
        u.quit(&mut || stop_log.lock().unwrap().push("stop daemon".into()));
        assert_eq!(entries(&log).len(), 3);
        let idle = updates(Channel::Stable);
        let quiet: Log = Arc::default();
        let q = quiet.clone();
        idle.quit(&mut || q.lock().unwrap().push("stop daemon".into()));
        assert_eq!(entries(&quiet), ["stop daemon"]);
    }

    #[test]
    fn restart_to_update_relaunches_and_stops_the_daemon_where_each_system_needs() {
        let log: Log = Arc::default();
        let u = updates(Channel::Stable);
        check(&u, &FakeRemote::new(Ok(Some(found(&log)))));
        let (stop, start) = (log.clone(), log.clone());
        let result = u.restart(
            false,
            &mut || stop.lock().unwrap().push("stop daemon".into()),
            &mut || start.lock().unwrap().push("start daemon".into()),
            &mut |_| {},
        );
        assert_eq!(result, Ok(()));
        assert_eq!(entries(&log), ["install 2026.1120.0 verified relaunch=true", "stop daemon"]);
        let log: Log = Arc::default();
        let w = updates(Channel::Stable);
        check(&w, &FakeRemote::new(Ok(Some(found(&log)))));
        let (stop, start) = (log.clone(), log.clone());
        let result = w.restart(
            true,
            &mut || stop.lock().unwrap().push("stop daemon".into()),
            &mut || start.lock().unwrap().push("start daemon".into()),
            &mut |_| {},
        );
        assert_eq!(result, Ok(()));
        assert_eq!(entries(&log), ["stop daemon", "install 2026.1120.0 verified relaunch=true"]);
    }

    #[test]
    fn a_restart_whose_install_fails_says_so_and_leaves_the_daemon_running() {
        for windows in [false, true] {
            let log: Log = Arc::default();
            let u = updates(Channel::Stable);
            let broken = FakeFound { install: Err("could not start the installer".into()), ..found(&log) };
            check(&u, &FakeRemote::new(Ok(Some(broken))));
            let (stop, start) = (log.clone(), log.clone());
            let mut seen = vec![];
            let result = u.restart(
                windows,
                &mut || stop.lock().unwrap().push("stop daemon".into()),
                &mut || start.lock().unwrap().push("start daemon".into()),
                &mut |s| seen.push(s.state),
            );
            assert_eq!(result, Err("could not start the installer".into()));
            let failed = UpdateState::Failed { stage: Stage::Install, message: "could not start the installer".into() };
            assert_eq!(seen, std::slice::from_ref(&failed), "one status: the failure");
            assert_eq!(u.status().state, failed);
            let expected: &[&str] = if windows {
                &["stop daemon", "install 2026.1120.0 verified relaunch=true", "start daemon"]
            } else {
                &["install 2026.1120.0 verified relaunch=true"]
            };
            assert_eq!(entries(&log), expected, "windows={windows}");
        }
    }

    #[test]
    fn linux_checks_only_as_an_appimage_and_a_development_build_never() {
        use tauri::utils::config::BundleType;
        assert_eq!(unsupported(true, "linux", None), Some(Unsupported::Package));
        assert_eq!(unsupported(true, "linux", Some(BundleType::Deb)), Some(Unsupported::Package));
        assert_eq!(unsupported(true, "linux", Some(BundleType::Rpm)), Some(Unsupported::Package));
        assert_eq!(unsupported(true, "linux", Some(BundleType::AppImage)), None);
        assert_eq!(unsupported(true, "macos", Some(BundleType::App)), None);
        assert_eq!(unsupported(true, "windows", Some(BundleType::Nsis)), None);
        assert_eq!(unsupported(true, "windows", None), None);
        assert_eq!(unsupported(false, "macos", Some(BundleType::App)), Some(Unsupported::Development));
        let u = Updates::new("2026.1116.0", Channel::Stable, None, Some(Unsupported::Package));
        let remote = FakeRemote::new(Ok(None));
        assert!(check(&u, &remote).is_empty());
        assert_eq!(remote.checks.get(), 0);
        assert_eq!(u.status().state, UpdateState::Unsupported { reason: Unsupported::Package });
    }

    #[test]
    fn a_long_download_sends_whole_percents_not_every_chunk() {
        let log: Log = Arc::default();
        let u = updates(Channel::Stable);
        let big = FakeFound { chunks: vec![1000; 10_000], total: Some(10_000_000), ..found(&log) };
        let seen = check(&u, &FakeRemote::new(Ok(Some(big))));
        let downloading: Vec<_> = seen.iter().filter(|s| matches!(s, UpdateState::Downloading { .. })).collect();
        assert_eq!(downloading.len(), 101, "the start, then each whole percent");
        assert_eq!(downloading.last(), Some(&&UpdateState::Downloading { done: 10_000_000, total: Some(10_000_000) }));
        assert_eq!(progress_step((1 << 20) - 1, None), 0);
        assert_eq!(progress_step(3 << 20, None), 3);
    }

    #[test]
    fn checks_run_at_launch_then_six_hours_after_the_last_by_the_wall_clock() {
        let t = SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000);
        assert!(check_due(None, t));
        assert!(!check_due(Some(t), t + Duration::from_secs(5 * 60 * 60)));
        assert!(check_due(Some(t), t + CHECK_EVERY));
        assert!(check_due(Some(t), t - Duration::from_secs(60)), "a clock set back does not hold checks off");
    }

    #[test]
    fn the_page_gets_the_status_as_snake_case_json_with_the_state_named_by_kind() {
        let status = |state| UpdateStatus {
            channel: Channel::Nightly,
            current: "2026.1116.0-nightly.12".into(),
            state,
            moved: false,
        };
        let json = |state| serde_json::to_value(status(state)).unwrap();
        use serde_json::json;
        assert_eq!(
            json(UpdateState::Downloading { done: 5, total: None }),
            json!({ "channel": "nightly", "current": "2026.1116.0-nightly.12", "state": { "kind": "downloading", "done": 5, "total": null }, "moved": false })
        );
        assert_eq!(json(UpdateState::Idle)["state"], json!({ "kind": "idle" }));
        assert_eq!(json(UpdateState::Checking)["state"], json!({ "kind": "checking" }));
        assert_eq!(
            json(UpdateState::Ready { version: "2026.1120.0".into() })["state"],
            json!({ "kind": "ready", "version": "2026.1120.0" })
        );
        assert_eq!(
            json(UpdateState::Failed { stage: Stage::Signature, message: "bad".into() })["state"],
            json!({ "kind": "failed", "stage": "signature", "message": "bad" })
        );
        assert_eq!(
            json(UpdateState::Unsupported { reason: Unsupported::Package })["state"],
            json!({ "kind": "unsupported", "reason": "package" })
        );
        assert_eq!(serde_json::from_str::<Channel>("\"stable\"").unwrap(), Channel::Stable);
    }
}
