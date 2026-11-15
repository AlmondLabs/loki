//! loki replaces itself (plan 2026-11-15-2319, U4; KTD1, KTD3, KTD8, KTD11). A release build asks its channel's
//! `latest.json` for a newer loki at launch and every six hours, through `tauri-plugin-updater`'s Rust API. A newer one
//! is downloaded in the background and checked against the update key compiled into the app; only then is it Ready,
//! held in memory. Quitting loki installs it, and Restart to Update installs it and opens the new version at once. A
//! failed check, download or signature is a status the page shows quietly, never a dialog, and leaves the running
//! version as it was. A crash or a force-quit loses the download; the next launch checks and downloads again.
//!
//! The channel, Stable or Nightly, is the shell's to keep in `~/.loki/updates.json`. The page sees `UpdateStatus`
//! through `update_status` and `loki:update` events, and never the plugin itself: no capability grants its commands.
//!
//! The updater sits behind `Remote` and `Found`, so the tests drive every state with fakes and no network.

use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime};

/// The event every change of UpdateStatus goes out as, carrying the whole status (as `loki:runtime` does the daemon's).
pub const UPDATE_EVENT: &str = "loki:update";

/// Where each channel's newest release describes itself: the newest stable's `latest.json`, or the rolling nightly's.
const STABLE_URL: &str = "https://github.com/AlmondLabs/loki/releases/latest/download/latest.json";
const NIGHTLY_URL: &str = "https://github.com/AlmondLabs/loki/releases/download/nightly/latest.json";

/// Overrides both channels' address (KTD11), so an update can be tried by hand against a throwaway prerelease. The
/// plugin accepts only HTTPS, and the signature is still checked against the compiled-in key.
const OVERRIDE_VAR: &str = "LOKI_UPDATE_URL";

/// The channel's file in loki's root.
const CHANNEL_FILE: &str = "updates.json";

/// How long between checks (R10).
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// How often the check loop wakes to see whether a check is due. It reads the wall clock rather than sleeping six
/// hours, which would not count the hours a laptop sleeps.
const WAKE_EVERY: Duration = Duration::from_secs(10 * 60);

/// How long a check may take before it counts as failed, so a stalled connection never leaves loki Checking for good.
const CHECK_TIMEOUT: Duration = Duration::from_secs(60);

/// Which releases loki updates to: every stable, or every merge to `main` (R15).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Channel {
    Stable,
    Nightly,
}

impl Channel {
    /// The channel a version is on, by `core/version.ts`'s rule: a nightly carries a `-nightly.` part.
    pub fn of(version: &str) -> Channel {
        if version.contains("-nightly.") {
            Channel::Nightly
        } else {
            Channel::Stable
        }
    }
}

/// The `latest.json` a check reads: the channel's, unless `LOKI_UPDATE_URL` names another (an empty one is unset).
pub fn endpoint(channel: Channel, override_url: Option<&str>) -> String {
    match override_url.filter(|u| !u.is_empty()) {
        Some(url) => url.to_string(),
        None => match channel {
            Channel::Stable => STABLE_URL.to_string(),
            Channel::Nightly => NIGHTLY_URL.to_string(),
        },
    }
}

/// `updates.json` as loki writes it.
#[derive(Serialize, Deserialize)]
struct ChannelFile {
    channel: Channel,
}

/// The saved channel in `dir`. The first run, and a file that cannot be read, take the running version's channel and
/// write it, so people who came from the nightly cask stay on Nightly (KTD8).
pub fn load_channel(dir: &Path, current: &str) -> Channel {
    let saved = std::fs::read_to_string(dir.join(CHANNEL_FILE))
        .ok()
        .and_then(|text| serde_json::from_str::<ChannelFile>(&text).ok());
    if let Some(file) = saved {
        return file.channel;
    }
    let channel = Channel::of(current);
    if let Err(e) = save_channel(dir, channel) {
        eprintln!("loki: update: {e}");
    }
    channel
}

/// Write the channel to `dir`'s `updates.json`, for the next launch and the next check.
pub fn save_channel(dir: &Path, channel: Channel) -> Result<(), String> {
    let path = dir.join(CHANNEL_FILE);
    let text = serde_json::to_string_pretty(&ChannelFile { channel }).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(dir)
        .and_then(|()| std::fs::write(&path, text + "\n"))
        .map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// What failed: the check, the download, the signature check of what was downloaded, or Restart to Update's install.
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

/// What `update_status` answers and `loki:update` carries: the channel, the running version, and the update's state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct UpdateStatus {
    pub channel: Channel,
    pub current: String,
    pub state: UpdateState,
}

/// Why a build never checks, if it does not: `release` is false in a development build, `os` is
/// `std::env::consts::OS`, and `appimage` is the `APPIMAGE` variable an AppImage sets for the program inside it.
pub fn unsupported(release: bool, os: &str, appimage: Option<&OsStr>) -> Option<Unsupported> {
    if !release {
        Some(Unsupported::Development)
    } else if os == "linux" && appimage.is_none_or(OsStr::is_empty) {
        Some(Unsupported::Package)
    } else {
        None
    }
}

/// A download that did not end in verified bytes, and at which stage.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    pub stage: Stage,
    pub message: String,
}

/// A newer loki a check found: its version, its download (verified before it returns), and its install.
pub trait Found: Send + Sync {
    /// The version it would install.
    fn version(&self) -> &str;
    /// Download it, telling `on_chunk` each chunk's length and the whole size once known, and check its signature.
    fn download(&self, on_chunk: &mut dyn FnMut(usize, Option<u64>)) -> Result<Vec<u8>, Failure>;
    /// Install the verified bytes. With `relaunch`, Windows' installer opens loki again once it is done; without it,
    /// it only installs. Windows' install ends this process when the installer starts.
    fn install(&self, bytes: &[u8], relaunch: bool) -> Result<(), String>;
}

/// Where a check asks: the updater, or a fake in the tests.
pub trait Remote {
    /// The newer loki `endpoint` describes, None when it names nothing newer than this one.
    fn check(&self, endpoint: &str) -> Result<Option<Box<dyn Found>>, String>;
}

/// A Ready update: what was found, and its verified bytes.
struct Held {
    found: Box<dyn Found>,
    bytes: Vec<u8>,
}

struct Inner {
    channel: Channel,
    state: UpdateState,
    held: Option<Held>,
}

/// The shell's update state, managed by the app: the status the page sees and the bytes of a Ready update.
pub struct Updates {
    current: String,
    override_url: Option<String>,
    inner: Mutex<Inner>,
}

/// How far a download has come in steps worth an event: whole percents, or whole MiB while the size is unknown, so a
/// download sends at most about a hundred events rather than one per chunk.
fn progress_step(done: u64, total: Option<u64>) -> u64 {
    match total {
        Some(t) if t > 0 => done.saturating_mul(100) / t,
        _ => done >> 20,
    }
}

/// Whether a check is due at `now`, the last having run at `last`: always the first; then once CHECK_EVERY has passed,
/// or when the clock was set back past the last check.
pub fn check_due(last: Option<SystemTime>, now: SystemTime) -> bool {
    last.is_none_or(|t| !matches!(now.duration_since(t), Ok(d) if d < CHECK_EVERY))
}

impl Updates {
    /// The state at launch: Idle, or Unsupported for good when this build never checks.
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
        Updates { current: current.to_string(), override_url, inner: Mutex::new(Inner { channel, state, held: None }) }
    }

    /// A poisoned lock still holds a usable state: nothing in it is left half-changed by a panic.
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The status as the page sees it.
    pub fn status(&self) -> UpdateStatus {
        let inner = self.lock();
        UpdateStatus { channel: inner.channel, current: self.current.clone(), state: inner.state.clone() }
    }

    /// The channel the next check reads. A download under way or Ready stays as it is.
    pub fn set_channel(&self, channel: Channel) {
        self.lock().channel = channel;
    }

    /// Move to `state`, keeping `held` (Some only for Ready), and tell `publish`.
    fn settle(&self, state: UpdateState, held: Option<Held>, publish: &mut dyn FnMut(UpdateStatus)) {
        {
            let mut inner = self.lock();
            inner.state = state;
            inner.held = held;
        }
        publish(self.status());
    }

    /// One check, and the download when it finds a newer loki. Nothing happens while a check or download is under way,
    /// while an update is Ready (it installs when loki quits), or in a build that never checks. Blocks until the
    /// download has ended; every change of state goes to `publish`.
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
        let found = match remote.check(&url) {
            Ok(Some(found)) => found,
            Ok(None) => return self.settle(UpdateState::Idle, None, publish),
            Err(message) => {
                eprintln!("loki: update: check of {url} failed: {message}");
                return self.settle(UpdateState::Failed { stage: Stage::Check, message }, None, publish);
            }
        };
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

    /// Take a Ready update's bytes, once: a quit and a restart never both install it.
    fn take(&self) -> Option<Held> {
        self.lock().held.take()
    }

    /// Quitting (KTD3): the daemon is stopped first, whatever else happens, then a Ready update installs without
    /// relaunching; the next launch is the new version. With nothing Ready, nothing is installed. A failed install
    /// leaves the version on disk as it was, so the current one opens next time.
    pub fn quit(&self, stop_daemon: &mut dyn FnMut()) {
        stop_daemon();
        let Some(held) = self.take() else { return };
        eprintln!("loki: update: installing {} as loki quits", held.found.version());
        if let Err(e) = held.found.install(&held.bytes, false) {
            eprintln!("loki: update: could not install {}: {e}", held.found.version());
        }
    }

    /// Restart to Update: install the Ready update and stop the daemon; the caller then relaunches loki. On the Mac and
    /// Linux the swap comes first, while the daemon still runs (it runs from `~/.loki`, not from the app), so a failed
    /// swap leaves it running. Windows' installer ends this process, so there (`installer_exits`) the daemon stops first
    /// and is started again if the installer could not start. A failure is the status, Failed at Install.
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

/// The stage a plugin error belongs to: anything about the key or the signature is the signature check; the rest of a
/// download's errors (a cut-off connection, a server's error) are the download.
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

/// The updater plugin as a `Remote`: the endpoint chosen at run time, the plugin's own version comparison (strictly
/// newer by semver, which the nightly numbering makes right for both channels, KTD2).
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
}

/// A plugin `Update` as `Found`. Its `download` checks the signature against the key in tauri.conf.json before it
/// returns the bytes. Its Windows install passes the NSIS installer `/P /UPDATE`, and `/R` (relaunch) only when
/// `restart_after_install` is left on (tauri-plugin-updater 2.12, `updater_parameters`).
struct PluginFound(tauri_plugin_updater::Update);

impl Found for PluginFound {
    fn version(&self) -> &str {
        &self.0.version
    }

    fn download(&self, on_chunk: &mut dyn FnMut(usize, Option<u64>)) -> Result<Vec<u8>, Failure> {
        tauri::async_runtime::block_on(self.0.download(on_chunk, || {}))
            .map_err(|e| Failure { stage: stage_of(&e), message: e.to_string() })
    }

    fn install(&self, bytes: &[u8], relaunch: bool) -> Result<(), String> {
        self.0.clone().restart_after_install(relaunch).install(bytes).map_err(|e| e.to_string())
    }
}

/// Tell every window (UPDATE_EVENT).
fn publish(app: &tauri::AppHandle, status: UpdateStatus) {
    use tauri::Emitter;
    if let Err(e) = app.emit(UPDATE_EVENT, status) {
        eprintln!("loki: {UPDATE_EVENT}: {e}");
    }
}

/// One check through the plugin, publishing as it goes. Blocks.
fn check_now(app: &tauri::AppHandle) {
    use tauri::Manager;
    app.state::<Updates>().check(&Plugin(app.clone()), &mut |s| publish(app, s));
}

/// At launch: manage the update state, with the channel read from `dir`, and in a build that checks start the loop
/// that checks at once and then every CHECK_EVERY.
pub fn start(app: &tauri::AppHandle, dir: &Path) {
    use tauri::Manager;
    let current = app.package_info().version.to_string();
    let channel = load_channel(dir, &current);
    let reason = unsupported(!cfg!(debug_assertions), std::env::consts::OS, std::env::var_os("APPIMAGE").as_deref());
    let override_url = std::env::var(OVERRIDE_VAR).ok().filter(|u| !u.is_empty());
    if let Some(url) = &override_url {
        eprintln!("loki: update: checking {url} ({OVERRIDE_VAR})");
    }
    app.manage(Updates::new(&current, channel, override_url, reason));
    if reason.is_some() {
        return;
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("loki-update-checker".into()).spawn(move || {
        let mut last: Option<SystemTime> = None;
        loop {
            let now = SystemTime::now();
            if check_due(last, now) {
                last = Some(now);
                check_now(&app);
            }
            std::thread::sleep(WAKE_EVERY);
        }
    });
    if let Err(e) = spawned {
        eprintln!("loki: update: could not start the check loop: {e}");
    }
}

/// The update's status, for About and the Restart to Update notice.
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

/// About's Stable or Nightly: saved in `~/.loki/updates.json`, read by the next check (R15).
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

    /// What the fakes did, in order, shared with the test.
    type Log = Arc<Mutex<Vec<String>>>;

    fn entries(log: &Log) -> Vec<String> {
        log.lock().unwrap().clone()
    }

    /// A newer loki that downloads in `chunks` of a `total` size, then ends in `end`; its install records itself.
    struct FakeFound {
        version: String,
        chunks: Vec<usize>,
        total: Option<u64>,
        end: Result<Vec<u8>, Failure>,
        install: Result<(), String>,
        log: Log,
    }

    impl Found for FakeFound {
        fn version(&self) -> &str {
            &self.version
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
            log: log.clone(),
        }
    }

    /// Answers each check from `answer`, counting the checks and recording the endpoint asked.
    struct FakeRemote {
        answer: RefCell<Option<Result<Option<FakeFound>, String>>>,
        asked: RefCell<Vec<String>>,
        checks: Cell<usize>,
    }

    impl FakeRemote {
        fn new(answer: Result<Option<FakeFound>, String>) -> Self {
            FakeRemote { answer: RefCell::new(Some(answer)), asked: RefCell::new(vec![]), checks: Cell::new(0) }
        }
    }

    impl Remote for FakeRemote {
        fn check(&self, endpoint: &str) -> Result<Option<Box<dyn Found>>, String> {
            self.checks.set(self.checks.get() + 1);
            self.asked.borrow_mut().push(endpoint.to_string());
            let answer = self.answer.borrow_mut().take().unwrap_or(Ok(None));
            answer.map(|f| f.map(|f| Box::new(f) as Box<dyn Found>))
        }
    }

    fn updates(channel: Channel) -> Updates {
        Updates::new("2026.1116.0", channel, None, None)
    }

    /// Run one check, returning the states it published.
    fn check(u: &Updates, remote: &FakeRemote) -> Vec<UpdateState> {
        let mut seen = vec![];
        u.check(remote, &mut |s| seen.push(s.state));
        seen
    }

    fn temp_dir() -> std::path::PathBuf {
        crate::runtime::tests::temp_root()
    }

    #[test]
    fn the_channel_file_starts_on_the_running_versions_channel_and_a_set_channel_survives_a_restart() {
        let dir = temp_dir().join(".loki");
        assert_eq!(load_channel(&dir, "2026.1116.0-nightly.4821"), Channel::Nightly);
        let text = std::fs::read_to_string(dir.join("updates.json")).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&text).unwrap(),
            serde_json::json!({ "channel": "nightly" })
        );
        // About chose Stable; the next launch, still on the nightly, keeps the choice.
        save_channel(&dir, Channel::Stable).unwrap();
        assert_eq!(load_channel(&dir, "2026.1116.0-nightly.4821"), Channel::Stable);
        // A stable build's first run is on Stable; a file loki cannot read is written again from the version.
        let other = temp_dir();
        assert_eq!(load_channel(&other, "2026.1116.0"), Channel::Stable);
        std::fs::write(other.join("updates.json"), "{ \"channel\": \"beta\" }").unwrap();
        assert_eq!(load_channel(&other, "2026.1116.1-nightly.9"), Channel::Nightly);
        assert_eq!(load_channel(&other, "2026.1116.0"), Channel::Nightly, "and that is the saved channel now");
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
        let _ = std::fs::remove_dir_all(&other);
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
        // The check asks the address of the channel set last.
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
        // Nothing newer: back to Idle, which About shows as up to date.
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
        // AE5: a tampered download, and one cut off halfway.
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
        // Ready: a later check (the six-hourly one, or Check for Updates) leaves the update as it is.
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
        // Without relaunch: Windows' installer gets /P /UPDATE and no /R, so loki stays closed until it is opened.
        assert_eq!(entries(&log), ["stop daemon", "install 2026.1120.0 verified relaunch=false"]);
        // Exit follows ExitRequested: the second quit stops the daemon again and installs nothing.
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
        // The Mac and Linux: the swap first, the daemon still running; then it stops and the caller relaunches.
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
        // Windows: the installer ends loki, so the daemon stops first; with relaunch it opens loki again (/R).
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
        assert_eq!(unsupported(true, "linux", None), Some(Unsupported::Package));
        assert_eq!(unsupported(true, "linux", Some(OsStr::new(""))), Some(Unsupported::Package));
        assert_eq!(unsupported(true, "linux", Some(OsStr::new("/home/x/loki.AppImage"))), None);
        assert_eq!(unsupported(true, "macos", None), None);
        assert_eq!(unsupported(true, "windows", None), None);
        assert_eq!(unsupported(false, "macos", None), Some(Unsupported::Development));
        // A .deb install: no check runs, and the status says why.
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
        // No size from the server: a step per MiB.
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
        let status =
            |state| UpdateStatus { channel: Channel::Nightly, current: "2026.1116.0-nightly.12".into(), state };
        let json = |state| serde_json::to_value(status(state)).unwrap();
        use serde_json::json;
        assert_eq!(
            json(UpdateState::Downloading { done: 5, total: None }),
            json!({ "channel": "nightly", "current": "2026.1116.0-nightly.12", "state": { "kind": "downloading", "done": 5, "total": null } })
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
