//! loki desktop shell (Tauri).
//!
//! A native window around the React canvas. The Rust side:
//!  - moves loki's root to ~/.loki once (root.rs) and hands the page the token and the mod's port before any script runs
//!  - installs what a release build ships (install.rs): the mod and daemon bundles, the phone canvas, the agent's skill
//!  - runs loki's daemon on the Node a release fetches for itself (runtime.rs; a development build, the machine's:
//!    node.rs) once git is in place, off the main thread so the window shows the download; restarts it when it dies
//!    (harness.rs), and stops it on quit;
//!    the page talks to the daemon itself, over the mod's port

mod harness;
mod install;
mod menu;
mod native;
mod node;
mod popup;
mod procs;
mod runtime;
mod widgets;

use std::path::{Path, PathBuf};
use tauri::{Manager, State};

/// loki's root, where the daemon, the mod and the shell keep everything: ~/.loki.
fn loki_dir() -> PathBuf {
    home_dir().join(".loki")
}

fn read_token() -> Option<String> {
    std::fs::read_to_string(loki_dir().join("token")).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// 16 bytes from the system's random source as 32 lowercase hex chars — the shape the mod makes
/// (`randomBytes(16).toString("hex")`). The OS source, not /dev/urandom: Windows has no such file, and
/// reading it there silently produced no token, so the daemon started pointing at a missing token file.
fn new_token() -> Option<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).ok()?;
    Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// The capability token the daemon, the mod and this shell share. The mod creates it on first
/// activate, but a first launch starts the daemon *before* any mod ran, so the shell writes it
/// when it is missing (`new_token`, mode 0600 where the system has modes — the same shape the mod makes).
fn ensure_token() -> Option<String> {
    if let Some(t) = read_token() {
        return Some(t);
    }
    let token = new_token()?;
    match write_token_file(&loki_dir(), &token) {
        Ok(()) => {
            eprintln!("loki: wrote a new capability token");
            Some(token)
        }
        // The mod wrote one between the read above and this write: that one is the token.
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => read_token(),
        Err(e) => {
            eprintln!("loki: could not write the capability token: {e}");
            None
        }
    }
}

/// Write a new token file in `dir`, readable by this user only from the moment it exists: made with mode 0600 (and
/// `dir`, when it has to be made, 0700) where the system has modes, never written first and narrowed after, when
/// another user could read it in between. Never replaces a file already there (AlreadyExists).
fn write_token_file(dir: &std::path::Path, token: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut folder = std::fs::DirBuilder::new();
    folder.recursive(true);
    let mut file = std::fs::OpenOptions::new();
    file.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
        folder.mode(0o700);
        file.mode(0o600);
    }
    folder.create(dir)?;
    file.open(dir.join("token"))?.write_all(token.as_bytes())
}

/// The system as the page names it (`__LOKI__.os`, read by `platform` in app/src/desk/env.ts): macos, windows or linux.
/// Any other unix desktop reads as linux, the nearest in keys and chrome.
fn page_os(os: &str) -> &'static str {
    match os {
        "macos" => "macos",
        "windows" => "windows",
        _ => "linux",
    }
}

/// What the page is told before its scripts run: the daemon token, the mod's port, the desk to open and the system.
/// Only the app's own top-level page gets it: Tauri adds initialization scripts to subframes on Windows, and an
/// agent-written widget runs in a sandboxed subframe that must never see the token (app/src/desk/widgetBridge.ts).
fn init_script() -> String {
    let token = read_token().unwrap_or_default();
    let mod_port: u16 = std::env::var("LOKI_PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(41414);
    let desk = std::env::var("LOKI_DESK").ok();
    format!(
        "if (window.top === window) {{ window.__LOKI__ = {{ token: {token}, modPort: {port}, desk: {desk}, os: \"{os}\" }}; }}",
        token = serde_json::to_string(&token).unwrap_or_else(|_| "\"\"".into()),
        port = mod_port,
        desk = serde_json::to_string(&desk).unwrap_or_else(|_| "null".into()),
        os = page_os(std::env::consts::OS),
    )
}

/// The Settings window's label (plan 2026-11-12-1505, U18): one at most, brought forward when it is already open.
const SETTINGS_WINDOW: &str = "settings";

/// A Preferences page id as the page names them (settings/pages.ts): lowercase words, nothing that could leave a string.
fn settings_page(page: Option<&str>) -> Option<&str> {
    page.filter(|p| !p.is_empty() && p.len() <= 32 && p.chars().all(|c| c.is_ascii_lowercase() || c == '-'))
}

/// The Settings window's start-up script: the main window's, then which window this is and the page to open on.
fn settings_script(page: Option<&str>) -> String {
    format!(
        "{} if (window.top === window && window.__LOKI__) {{ window.__LOKI__.window = \"settings\"; window.__LOKI__.page = {}; }}",
        init_script(),
        serde_json::to_string(&settings_page(page)).unwrap_or_else(|_| "null".into()),
    )
}

/// Open Settings in a window of its own (plan 2026-11-12-1505, U18), or bring the open one forward on `page`. Async,
/// because a window made from a synchronous command deadlocks on Windows; only the Mac's page calls it today.
#[tauri::command]
async fn open_settings<R: tauri::Runtime>(app: tauri::AppHandle<R>, page: Option<String>) -> Result<(), String> {
    use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
    if let Some(win) = app.get_webview_window(SETTINGS_WINDOW) {
        if let Some(p) = settings_page(page.as_deref()) {
            app.emit_to(SETTINGS_WINDOW, "loki:settings-page", p).map_err(|e| e.to_string())?;
        }
        let _ = win.unminimize();
        win.show().map_err(|e| e.to_string())?;
        return win.set_focus().map_err(|e| e.to_string());
    }
    let window = WebviewWindowBuilder::new(&app, SETTINGS_WINDOW, WebviewUrl::default())
        .title("Settings")
        .inner_size(820.0, 600.0)
        .min_inner_size(680.0, 460.0)
        .initialization_script(settings_script(page.as_deref()));
    // As the main window: the lights over the page, the system's sidebar material behind the section list.
    #[cfg(target_os = "macos")]
    let window = window.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true).transparent(true).effects(
        tauri::window::EffectsBuilder::new()
            .effect(tauri::window::Effect::Sidebar)
            .state(tauri::window::EffectState::FollowsWindowActiveState)
            .build(),
    );
    #[cfg(not(target_os = "macos"))]
    let window = window.background_color(tauri::window::Color(0x1c, 0x1c, 0x1e, 0xff));
    window.build().map(|_| ()).map_err(|e| e.to_string())
}

/// The page's console, mirrored to the shell's stderr (there is no devtools in a packaged app).
#[tauri::command]
fn client_log(level: String, message: String) {
    eprintln!("loki[{level}]: {message}");
}

/// What launch did about the mod, the skill and the phone canvas (Settings shows it).
#[tauri::command]
fn install_status(report: State<'_, install::Report>) -> install::Report {
    report.inner().clone()
}

/// The daemon as Welcome and Settings see it: the Node it runs on, why it could not start, and what comes before it
/// starts (plan 2026-11-15-2319, KTD7). While the runtime downloads, `preparing` says what and how far; a download that
/// fails keeps it beside `error`, so Welcome can say what failed. `tools_missing` names the system whose git is missing
/// (the Mac's command line tools, Linux's package), for Welcome's tools step.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonStatus {
    pub node: Option<String>,
    pub error: Option<String>,
    pub preparing: Option<Preparing>,
    pub tools_missing: Option<node::Os>,
}

/// A runtime download as Welcome shows it: `node` or `git` (PortableGit), its version, the bytes so far and the total
/// once the server has said it.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Preparing {
    pub name: String,
    pub version: String,
    pub done: u64,
    pub total: Option<u64>,
}

/// The event every change of DaemonStatus goes out as, carrying the whole status. The page also asks daemon_status
/// every few seconds until the daemon runs, so an event it missed (sent before it listened) costs it nothing.
const RUNTIME_EVENT: &str = "loki:runtime";

/// How often a download's progress goes out between its first and last byte: often enough for a bar that moves, not
/// an event for every 64 KiB read.
const PROGRESS_EVERY: std::time::Duration = std::time::Duration::from_millis(250);

/// DaemonStatus, kept current by start_daemon and the supervisor; `supervising` while a supervisor thread watches
/// the daemon, so a retry never starts a second one beside it; `starting` while start_daemon runs, so a retry during
/// the first download never runs a second start whose download would delete the first one's files.
#[derive(Default)]
struct DaemonState {
    status: std::sync::Mutex<DaemonStatus>,
    supervising: std::sync::atomic::AtomicBool,
    starting: std::sync::atomic::AtomicBool,
}

/// Clears DaemonState::starting when a start ends, however it ends.
struct Starting<'a>(&'a std::sync::atomic::AtomicBool);

impl Drop for Starting<'_> {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Claim the one start; None while another start holds it.
fn begin_start(flag: &std::sync::atomic::AtomicBool) -> Option<Starting<'_>> {
    (!flag.swap(true, std::sync::atomic::Ordering::SeqCst)).then_some(Starting(flag))
}

impl DaemonState {
    fn get(&self) -> DaemonStatus {
        self.status.lock().map(|s| s.clone()).unwrap_or_default()
    }
    fn set(&self, f: impl FnOnce(&mut DaemonStatus)) {
        if let Ok(mut s) = self.status.lock() {
            f(&mut s);
        }
    }
}

/// Change the daemon's status and tell every window (RUNTIME_EVENT).
fn publish(app: &tauri::AppHandle, f: impl FnOnce(&mut DaemonStatus)) {
    use tauri::Emitter;
    let state = app.state::<DaemonState>();
    state.set(f);
    if let Err(e) = app.emit(RUNTIME_EVENT, state.get()) {
        eprintln!("loki: {RUNTIME_EVENT}: {e}");
    }
}

#[tauri::command]
fn daemon_status(state: State<'_, DaemonState>) -> DaemonStatus {
    state.get()
}

/// Welcome's Try Again and Check Again: run the start sequence again (the runtime, git, the daemon), unless a
/// supervisor already watches a daemon (it restarts the daemon itself). Off the main thread: it may download.
#[tauri::command]
async fn retry_daemon(app: tauri::AppHandle) -> Result<DaemonStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DaemonState>();
        if !state.supervising.load(std::sync::atomic::Ordering::SeqCst) {
            if let Err(e) = start_daemon(&app) {
                eprintln!("loki: {e}");
            }
        }
        state.get()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Welcome's Install Command Line Tools on the Mac: `xcode-select --install`, which has macOS show its own installer
/// and returns. Check Again looks for git once that has finished. Other systems have no such command.
#[tauri::command]
async fn install_tools() -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("only the Mac installs its command line tools from loki".into());
    }
    tauri::async_runtime::spawn_blocking(|| {
        let out = std::process::Command::new("/usr/bin/xcode-select")
            .arg("--install")
            .stdin(std::process::Stdio::null())
            .output()
            .map_err(|e| format!("could not run xcode-select: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Start loki's daemon and keep it running, once what it needs is in place (`prepare`): a daemon left by a crashed
/// loki is stopped first, and one that dies is restarted (supervise_daemon). A development build runs the checkout's
/// sources; a release build the installed bundle. What happened lands in DaemonState for daemon_status, and goes out
/// as RUNTIME_EVENT.
fn start_daemon(app: &tauri::AppHandle) -> Result<(), String> {
    let (home, data) = (home_dir(), loki_dir());
    let state = app.state::<DaemonState>();
    // One start at a time: a second one waits for nothing and changes nothing; the running one publishes what happens.
    let Some(_starting) = begin_start(&state.starting) else { return Ok(()) };
    let failed = |node: Option<String>, e: &str| {
        publish(app, |s| *s = DaemonStatus { node, error: Some(e.to_string()), ..DaemonStatus::default() })
    };
    // A release build runs only the Node its runtime.json names, fetched into ~/.loki/runtime when it is not there yet.
    let host = if runtime_wanted() {
        match runtime::Host::this(&data, &home) {
            Ok(h) => Some(h),
            Err(e) => {
                failed(None, &e);
                return Err(e);
            }
        }
    } else {
        None
    };
    let tools = || {
        let host = node::Host::this(&home);
        runtime::tools_missing(&host, &runtime::developer_dir).then_some(host.os)
    };
    let prepared =
        prepare(host.as_ref(), tools, &std::time::Instant::now, &mut |status| publish(app, |s| *s = status))?;
    let runtime_path = prepared.as_ref().map(|r| r.path.clone()).unwrap_or_default();
    let node = match node::find_node_program(&home, prepared.as_ref().map(|r| r.node.as_path())) {
        Ok(n) => n,
        Err(missing) => {
            let message = missing.message();
            failed(None, &message);
            return Err(message);
        }
    };
    let (entry, mod_entry) = match dev_checkout() {
        Some(checkout) => (checkout.join("daemon").join("main.ts"), checkout.join("mod").join("boot.ts")),
        None => (data.join("daemon").join("daemon.mjs"), data.join("mod").join("loki-mod.mjs")),
    };
    let token_file = data.join("token");
    if let Some(left) = procs::daemon_leftover(&procs::os::snapshot(), &token_file) {
        eprintln!("loki: daemon: one left from an earlier run (pid {}) — stopping it", left.pid);
        procs::os::kill(left.pid, Some(left.started));
    }
    let node_shown = node.display().to_string();
    let launch = move |app: &tauri::AppHandle| -> Result<(), String> {
        let Some(h) = app.try_state::<harness::Harness>() else { return Err("no harness slot".into()) };
        let daemon =
            harness::Daemon { node: &node, entry: &entry, mod_entry: &mod_entry, dir: &data, path: &runtime_path };
        h.start_daemon(&daemon, &harness::Launch { token_file: &token_file, log_dir: &data.join("logs") })
    };
    if let Err(e) = launch(app) {
        failed(Some(node_shown), &e);
        return Err(e);
    }
    eprintln!("loki: daemon on {node_shown}");
    // The daemon runs on this runtime now, so the versions before it can go.
    if let (Some(host), Some(_)) = (&host, &prepared) {
        runtime::prune(host);
    }
    publish(app, |s| *s = DaemonStatus { node: Some(node_shown), ..DaemonStatus::default() });
    if !state.supervising.swap(true, std::sync::atomic::Ordering::SeqCst) {
        supervise_daemon(app.clone(), launch);
    }
    Ok(())
}

/// Release builds run the daemon on the runtime they fetch (runtime.rs); `tauri dev` keeps finding the machine's Node.
fn runtime_wanted() -> bool {
    !cfg!(debug_assertions)
}

/// What comes before the daemon starts (KTD7), in order: the runtime (a release build's `runtime`; None in a
/// development build), fetched where it is missing, then git (`tools_missing`, the system whose git is missing). Each
/// change of state goes to `publish`: the download's progress as it comes (at most every PROGRESS_EVERY by `now`), a
/// failed download with what was being fetched, the tools step. A step that stops the start returns why, its status
/// already published. Blocks while it downloads.
fn prepare(
    runtime: Option<&runtime::Host>,
    tools_missing: impl FnOnce() -> Option<node::Os>,
    now: &dyn Fn() -> std::time::Instant,
    publish: &mut dyn FnMut(DaemonStatus),
) -> Result<Option<runtime::Runtime>, String> {
    let fetched = match runtime {
        None => None,
        Some(host) => {
            let (mut current, mut sent): (Option<Preparing>, Option<std::time::Instant>) = (None, None);
            let result = runtime::ensure(host, &mut |p| {
                if p.done == 0 && p.total.is_none() {
                    eprintln!("loki: runtime: fetching {} {}", p.name, p.version);
                }
                let preparing =
                    Preparing { name: p.name.into(), version: p.version.into(), done: p.done, total: p.total };
                current = Some(preparing.clone());
                let t = now();
                if progress_due(sent, t, p) {
                    sent = Some(t);
                    publish(DaemonStatus { preparing: Some(preparing), ..DaemonStatus::default() });
                }
            });
            match result {
                Ok(r) => Some(r),
                Err(e) => {
                    publish(DaemonStatus { error: Some(e.clone()), preparing: current, ..DaemonStatus::default() });
                    return Err(e);
                }
            }
        }
    };
    if let Some(os) = tools_missing() {
        publish(DaemonStatus { tools_missing: Some(os), ..DaemonStatus::default() });
        return Err("git is missing; Welcome asks for it".into());
    }
    Ok(fetched)
}

/// Whether a download's progress goes out now: the first word, a download's start and its last byte always; anything
/// between once PROGRESS_EVERY has passed since the last that went out.
fn progress_due(last: Option<std::time::Instant>, now: std::time::Instant, p: &runtime::Progress) -> bool {
    p.done == 0 || p.total == Some(p.done) || last.is_none_or(|t| now.duration_since(t) >= PROGRESS_EVERY)
}

/// Watch the daemon once a second. One that exits on its own is started again after harness::restart_delay; one loki
/// stopped is left down — and then the supervisor ends, so retry_daemon may start it again. One that found another
/// daemon already serving (harness::EXIT_HELD) is tried again every HELD_RETRY: that one may be a leftover that dies
/// later, and then this loki's takes over.
/// How often a daemon that found another one serving tries again.
const HELD_RETRY: std::time::Duration = std::time::Duration::from_secs(30);

fn supervise_daemon(app: tauri::AppHandle, launch: impl Fn(&tauri::AppHandle) -> Result<(), String> + Send + 'static) {
    std::thread::Builder::new()
        .name("loki-daemon-supervisor".into())
        .spawn(move || {
            let mut exits: Vec<std::time::Instant> = vec![];
            let mut held = false;
            // Whether the window was told the daemon keeps stopping; taken back once it has run a minute.
            let mut looping = false;
            loop {
                std::thread::sleep(std::time::Duration::from_secs(1));
                let Some(h) = app.try_state::<harness::Harness>() else { break };
                if h.was_stopped() { break; }
                let Some(status) = h.exited() else {
                    if looping && exits.last().is_some_and(|t| t.elapsed() >= std::time::Duration::from_secs(60)) {
                        looping = false;
                        publish(&app, |s| s.error = None);
                    }
                    continue;
                };
                if status.code() == Some(harness::EXIT_HELD) {
                    if !held { eprintln!("loki: daemon: another daemon is already serving — using that one, and trying again every {} s", HELD_RETRY.as_secs()); }
                    held = true;
                    std::thread::sleep(HELD_RETRY);
                    if h.was_stopped() { break; }
                    if let Err(e) = launch(&app) { eprintln!("loki: daemon start failed: {e}"); }
                    continue;
                }
                held = false;
                exits.retain(|t| t.elapsed() < std::time::Duration::from_secs(60));
                let delay = harness::restart_delay(exits.len());
                exits.push(std::time::Instant::now());
                eprintln!("loki: daemon exited ({status}) — restarting in {} s", delay.as_secs());
                std::thread::sleep(delay);
                if h.was_stopped() { break; }
                let result = launch(&app);
                if let Err(e) = &result { eprintln!("loki: daemon restart failed: {e}"); }
                // A start that works says nothing of a daemon that dies again a moment later: one that keeps
                // stopping is reported until it has run a minute.
                let note = harness::crash_loop_note(exits.len(), &loki_dir().join("logs").join("daemon.log"));
                looping = note.is_some();
                publish(&app, |s| s.error = result.err().or(note));
            }
            app.state::<DaemonState>().supervising.store(false, std::sync::atomic::Ordering::SeqCst);
        })
        .expect("the daemon supervisor thread");
}

/// SIGTERM/SIGINT (a `kill`, a logout) never reach Tauri's exit events: stop the daemon ourselves. Windows has no such
/// signals; Ctrl-C in the console of a `tauri dev` is the one that reaches us there (a GUI build has no console, and
/// its quit paths all go through the exit events).
fn stop_on_signals(handle: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{signal, SignalKind};
            let (Ok(mut term), Ok(mut int)) = (signal(SignalKind::terminate()), signal(SignalKind::interrupt())) else {
                return;
            };
            tokio::select! { _ = term.recv() => {}, _ = int.recv() => {} }
        }
        #[cfg(not(unix))]
        let Ok(()) = tokio::signal::ctrl_c().await
        else {
            return;
        };
        if let Some(h) = handle.try_state::<harness::Harness>() {
            h.stop();
        }
        handle.exit(0);
    });
}

/// The user's home folder, where everything loki keeps lives (~/.loki). It has to be the folder the
/// daemon's `os.homedir()` answers, or the two would read different tokens and state: on Windows that is
/// USERPROFILE (Node ignores a HOME there, such as Git Bash's), elsewhere HOME. An empty value counts as
/// unset. `run` checks it once at launch and stops with a line on stderr when there is none, rather than
/// keeping loki's root under `/`.
fn home_from(windows: bool, var: impl Fn(&str) -> Option<std::ffi::OsString>) -> Option<PathBuf> {
    var(if windows { "USERPROFILE" } else { "HOME" }).filter(|v| !v.is_empty()).map(PathBuf::from)
}

const HOME_VAR: &str = if cfg!(windows) { "USERPROFILE" } else { "HOME" };

fn platform_home() -> Option<PathBuf> {
    home_from(cfg!(windows), |k| std::env::var_os(k))
}

fn home_dir() -> PathBuf {
    platform_home().unwrap_or_else(|| panic!("{HOME_VAR} is not set (checked at launch)"))
}

/// Release builds install on every launch; `tauri dev` runs the checkout instead, unless asked (LOKI_INSTALL=1).
fn install_wanted() -> bool {
    if std::env::var_os("LOKI_NO_INSTALL").is_some() {
        return false;
    }
    !cfg!(debug_assertions) || std::env::var_os("LOKI_INSTALL").is_some()
}

/// The checkout a development build was compiled from: its daemon runs the checkout's daemon/main.ts with
/// `--mod mod/boot.ts`, and the skill is linked there where nothing is yet (install.rs `link_checkout`). Release
/// builds: never (the path is not even in the binary). LOKI_NO_INSTALL: no, the installed bundles run.
fn dev_checkout() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        if std::env::var_os("LOKI_NO_INSTALL").is_some() {
            return None;
        }
        return PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().map(Path::to_path_buf);
    }
    #[allow(unreachable_code)]
    None
}

/// Linux runs loki through XWayland (plan 014 KTD8): GDK_BACKEND=x11 unless the user chose a backend, since an
/// undecorated window on native Wayland still has open resize and unresponsive-button bugs. The value to set, if any.
#[cfg(any(target_os = "linux", test))]
fn gdk_backend(current: Option<&std::ffi::OsStr>) -> Option<&'static str> {
    if current.is_some() {
        None
    } else {
        Some("x11")
    }
}

/// Called first thing in `main`, before GTK or any thread starts (setting the environment later would race them).
#[cfg(target_os = "linux")]
pub fn prefer_x11() {
    if let Some(v) = gdk_backend(std::env::var_os("GDK_BACKEND").as_deref()) {
        std::env::set_var("GDK_BACKEND", v);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if platform_home().is_none() {
        eprintln!("loki: {HOME_VAR} is not set, so there is no home folder for ~/.loki; set it and start loki again");
        std::process::exit(1);
    }
    let _ = ensure_token();
    let script = init_script();
    let builder = tauri::Builder::default();
    // One loki per user off the Mac (plan 014 KTD7): a second launch hands over to the running one, which comes
    // forward, and exits before it starts a daemon. First of the plugins, as the plugin asks.
    #[cfg(any(windows, target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
    }));
    builder
        // Links leave the app through the system browser (window.open is blocked in the webview).
        .plugin(tauri_plugin_opener::init())
        // The system's folder dialog: Browse in "new desk" on every OS (the mod's AppleScript chooser serves browser tabs).
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            client_log,
            install_status,
            daemon_status,
            retry_daemon,
            install_tools,
            open_settings,
            native::set_waiting,
            native::set_global_shortcut,
            native::traffic_lights,
            menu::set_menu,
            popup::popup_menu
        ])
        // Agent-written widgets, transpiled on request: loki://localhost/widgets/<desk>/<name>.js
        .register_uri_scheme_protocol("loki", |_ctx, request| widgets::respond(request.uri().path()))
        .setup(move |app| {
            use tauri::{WebviewUrl, WebviewWindowBuilder};

            // What this build ships goes in place first, so the daemon started below runs this build's bundles.
            let (home, data) = (home_dir(), loki_dir());
            let mut report = install::Report::skipped(&home);
            if install_wanted() {
                let resources = app.path().resource_dir().ok().and_then(|d| install::find_resources(&d));
                report = match resources {
                    Some(res) => install::run(&res, &data, &home),
                    None => install::Report {
                        r#mod: install::State::Error,
                        error: Some("bundled mod not found in the app's resources".into()),
                        ..install::Report::skipped(&home)
                    },
                };
                eprintln!(
                    "loki: install: mod {:?} · skill {:?} · app {:?}{}",
                    report.r#mod,
                    report.skill,
                    report.app,
                    report.error.as_deref().map(|e| format!(" · {e}")).unwrap_or_default()
                );
            } else if let Some(checkout) = dev_checkout() {
                report = install::link_checkout(&checkout, &home);
                eprintln!(
                    "loki: dev: mod {:?} {} · skill {:?}{}",
                    report.r#mod,
                    report.mod_path,
                    report.skill,
                    report.error.as_deref().map(|e| format!(" · {e}")).unwrap_or_default()
                );
            }
            app.manage(report);

            // loki's daemon runs the agents and serves the page. Its start may first download the runtime, so it runs
            // beside the window, which opens at once and shows Welcome's progress; retry_daemon runs it again.
            app.manage(harness::Harness::default());
            app.manage(DaemonState::default());
            let handle = app.handle().clone();
            drop(tauri::async_runtime::spawn_blocking(move || {
                if let Err(e) = start_daemon(&handle) {
                    eprintln!("loki: {e}");
                }
            }));
            stop_on_signals(app.handle().clone());

            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("loki")
                .inner_size(1440.0, 900.0)
                .min_inner_size(900.0, 600.0)
                .initialization_script(&script)
                // No page opens a second loki window. A link that asks for one (a mail drawn in its frame, whose
                // clicks the Mac's webview keeps from loki's own listener) goes to the system browser when it is a
                // web or mail address, and nowhere otherwise.
                .on_new_window({
                    let app = app.handle().clone();
                    move |url, _features| {
                        if matches!(url.scheme(), "http" | "https" | "mailto") {
                            use tauri_plugin_opener::OpenerExt;
                            if let Err(e) = app.opener().open_url(url.as_str(), None::<&str>) {
                                eprintln!("loki: open link: {e}");
                            }
                        }
                        tauri::webview::NewWindowResponse::Deny
                    }
                });
            // No native title bar: the lights float over loki's own top edge, on the panes' title bars' row (app
            // sidebar.tsx paneTop); the title stays set for the Window menu, Mission Control and screen readers, just
            // not drawn.
            #[cfg(target_os = "macos")]
            let window = window.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
            // The Mac's own sidebar material behind a transparent window (plan 2026-11-12-1505, U13): Liquid Glass lets
            // it through the sidebar and paints everything else; today's look paints the whole window, so it never
            // shows there. It dims with the window, as Mail's does, and macOS draws it solid under Reduce Transparency.
            #[cfg(target_os = "macos")]
            let window = window.transparent(true).effects(
                tauri::window::EffectsBuilder::new()
                    .effect(tauri::window::Effect::Sidebar)
                    .state(tauri::window::EffectState::FollowsWindowActiveState)
                    .build(),
            );
            // Elsewhere it starts on loki's dark ground; the page applies the saved light/dark preference after it loads.
            #[cfg(not(target_os = "macos"))]
            let window = window.background_color(tauri::window::Color(0x1c, 0x1c, 0x1e, 0xff));
            // Windows and Linux (plan 014 KTD4): no system title bar at all; the strip draws Slack's there, with ☰ and
            // minimise, maximise and close (Sidebar.tsx TitleStrip). The window still resizes from its edges.
            #[cfg(not(target_os = "macos"))]
            let window = window.decorations(false);
            let window = window.build()?;
            // AppKit lays the lights out in the toolbar's taller title bar, beside the sidebar's toggle (native.rs).
            #[cfg(target_os = "macos")]
            native::add_unified_toolbar(&window);
            #[cfg(not(target_os = "macos"))]
            let _ = window;
            // The menu bar, the tray and ⌥Space are the Mac's (plan 014 KTD3); elsewhere their commands are no-ops.
            #[cfg(target_os = "macos")]
            {
                menu::listen(app.handle());
                native::setup_tray(app.handle())?;
                if let Err(e) = native::setup_shortcut(app.handle()) {
                    eprintln!("loki: global shortcut unavailable: {e}");
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(h) = window.app_handle().try_state::<harness::Harness>() {
                    h.stop();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building loki")
        .run(|app, event| {
            // Quit from the menu, the dock, or the last window closing: take the daemon down first.
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                if let Some(h) = app.try_state::<harness::Harness>() {
                    h.stop();
                }
            }
        });
}

#[cfg(test)]
mod tests {

    #[test]
    fn a_new_token_file_is_private_from_the_start_and_never_replaces_one_there() {
        let dir = std::env::temp_dir().join(format!("loki-token-{}", std::process::id())).join(".loki");
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
        write_token_file(&dir, "first").unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("token")).unwrap(), "first");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(dir.join("token")).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        }
        let again = write_token_file(&dir, "second").unwrap_err();
        assert_eq!(again.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read_to_string(dir.join("token")).unwrap(), "first");
        std::fs::remove_dir_all(dir.parent().unwrap()).unwrap();
    }

    use super::*;

    #[test]
    fn one_start_at_a_time_and_the_next_may_start_once_it_ends() {
        let flag = std::sync::atomic::AtomicBool::new(false);
        let first = begin_start(&flag);
        assert!(first.is_some());
        assert!(begin_start(&flag).is_none(), "a second start while the first runs");
        drop(first);
        assert!(begin_start(&flag).is_some(), "a start after the first ended");
    }
    use std::ffi::OsString;

    #[test]
    fn tokens_are_32_lowercase_hex_chars_and_fresh_each_time() {
        let (a, b) = (new_token().unwrap(), new_token().unwrap());
        assert_eq!(a.len(), 32, "{a}");
        assert!(
            a.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)),
            "the mod's shape, /^[a-f0-9]{{32}}$/: {a}"
        );
        assert_ne!(a, b);
    }

    fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<OsString> {
        move |k| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| OsString::from(v))
    }

    #[test]
    fn home_is_the_platforms_own_variable_and_never_slash() {
        assert_eq!(home_from(true, env(&[("USERPROFILE", r"C:\Users\x")])), Some(PathBuf::from(r"C:\Users\x")));
        assert_eq!(
            home_from(true, env(&[("USERPROFILE", r"C:\Users\x"), ("HOME", "/c/Users/x")])),
            Some(PathBuf::from(r"C:\Users\x")),
            "a Git Bash HOME does not win: os.homedir() reads USERPROFILE"
        );
        assert_eq!(home_from(true, env(&[("HOME", "/home/x")])), None);
        assert_eq!(home_from(false, env(&[("HOME", "/Users/x")])), Some(PathBuf::from("/Users/x")));
        assert_eq!(home_from(false, env(&[("USERPROFILE", r"C:\Users\x")])), None);
        assert_eq!(home_from(false, env(&[])), None);
        assert_eq!(home_from(false, env(&[("HOME", "")])), None, "an empty HOME is no home");
    }

    #[test]
    fn linux_asks_for_x11_only_when_no_backend_is_chosen() {
        assert_eq!(gdk_backend(None), Some("x11"));
        assert_eq!(gdk_backend(Some(std::ffi::OsStr::new("wayland"))), None, "the user's own choice stands");
        assert_eq!(gdk_backend(Some(std::ffi::OsStr::new("x11"))), None);
    }

    #[test]
    fn the_settings_window_is_told_which_it_is_and_only_a_plain_page() {
        assert_eq!(settings_page(Some("keys")), Some("keys"));
        assert_eq!(settings_page(Some("learn")), Some("learn"));
        assert_eq!(settings_page(Some("")), None);
        assert_eq!(settings_page(Some("x\";alert(1)//")), None);
        assert_eq!(settings_page(Some("Keys")), None);
        assert_eq!(settings_page(None), None);
        let script = settings_script(Some("keys"));
        assert!(script.contains("window.__LOKI__.window = \"settings\"; window.__LOKI__.page = \"keys\";"));
        assert!(settings_script(None).ends_with("window.__LOKI__.page = null; }"));
        // the main window's script first, so the token and the system arrive as they do there
        assert!(script.starts_with("if (window.top === window) { window.__LOKI__ = "));
    }

    #[test]
    fn the_page_is_told_its_system_in_one_of_three_words() {
        assert_eq!(page_os("macos"), "macos");
        assert_eq!(page_os("windows"), "windows");
        assert_eq!(page_os("linux"), "linux");
        assert_eq!(page_os("freebsd"), "linux");
        let expected = if cfg!(target_os = "macos") {
            "macos"
        } else if cfg!(windows) {
            "windows"
        } else {
            "linux"
        };
        let script = init_script();
        assert!(
            script.ends_with(&format!(", os: \"{expected}\" }}; }}")),
            "the script ends with the os (not printed: it carries the token)"
        );
        // Only the top-level page: a widget's sandboxed frame, which Windows also runs it in, gets nothing.
        assert!(
            script.starts_with("if (window.top === window) { window.__LOKI__ = "),
            "the token is set in the top-level window only"
        );
    }

    // ── The start sequence (plan 2026-11-15-2319, KTD7): the runtime, then git, then the daemon. ──

    use crate::runtime::tests::{host as runtime_host, names, temp_root, Server};
    use std::time::{Duration, Instant};

    /// A clock that moves on a second at every look, so every byte of progress is due and none is throttled away.
    fn ticking() -> impl Fn() -> Instant {
        let start = Instant::now();
        let n = std::cell::Cell::new(0u64);
        move || {
            n.set(n.get() + 1);
            start + Duration::from_secs(n.get())
        }
    }

    #[test]
    fn a_new_mac_fetches_node_then_asks_for_the_command_line_tools_and_starts_nothing() {
        let root = temp_root();
        let server = Server::new();
        let h = runtime_host(&root, "darwin-arm64", &server);
        let mut seen: Vec<DaemonStatus> = vec![];
        let result = prepare(Some(&h), || Some(node::Os::Macos), &ticking(), &mut |s| seen.push(s));
        assert!(result.is_err(), "no git: the daemon does not start");
        let fetching: Vec<&Preparing> = seen.iter().filter_map(|s| s.preparing.as_ref()).collect();
        assert!(!fetching.is_empty());
        assert!(fetching.iter().all(|p| p.name == "node" && p.version == "22.23.5"), "{fetching:?}");
        let last = fetching.last().unwrap();
        assert_eq!(last.total, Some(last.done), "the last progress is the whole download");
        assert_eq!(fetching.first().unwrap().total, None, "the first is said before the server answers");
        assert!(seen.iter().all(|s| s.error.is_none() && s.node.is_none()));
        assert_eq!(
            seen.last(),
            Some(&DaemonStatus { tools_missing: Some(node::Os::Macos), ..DaemonStatus::default() }),
            "then the tools step, and nothing else"
        );
        // Check Again once macOS installed them: Node is there, so nothing is fetched, and the start goes on.
        let mut again: Vec<DaemonStatus> = vec![];
        let rt = prepare(Some(&h), || None, &ticking(), &mut |s| again.push(s)).unwrap();
        assert!(again.is_empty(), "a present runtime and git: nothing to show {again:?}");
        assert_eq!(rt.unwrap().node, root.join("node-22.23.5-darwin-arm64").join("bin").join("node"));
        assert_eq!(server.fetches.get(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_failed_download_says_what_failed_and_try_again_runs_the_whole_sequence() {
        let root = temp_root();
        let server = Server::new();
        let mut h = runtime_host(&root, "linux-x64", &server);
        h.fetch = Box::new(|_| Err("connection reset".into()));
        let mut seen: Vec<DaemonStatus> = vec![];
        let err = prepare(Some(&h), || None, &ticking(), &mut |s| seen.push(s)).unwrap_err();
        assert!(err.contains("could not download node-v22.23.5-linux-x64.tar.gz"), "{err}");
        let last = seen.last().unwrap();
        assert_eq!(last.error.as_deref(), Some(err.as_str()));
        let failed = last.preparing.as_ref().expect("what was being fetched stays beside the error");
        assert_eq!((failed.name.as_str(), failed.version.as_str()), ("node", "22.23.5"));
        assert_eq!(last.tools_missing, None);
        // Try Again: the download starts over and the error goes with its first progress.
        h.fetch = server.fetch();
        let mut again: Vec<DaemonStatus> = vec![];
        let rt = prepare(Some(&h), || None, &ticking(), &mut |s| again.push(s)).unwrap();
        assert!(rt.is_some());
        assert!(again.iter().all(|s| s.error.is_none()), "{again:?}");
        assert_eq!(names(&root), ["node-22.23.5-linux-x64"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn windows_without_git_bash_shows_portable_git_being_fetched_and_no_tools_step() {
        let root = temp_root();
        let server = Server::new();
        let mut h = runtime_host(&root, "win-x64", &server);
        h.git = true;
        let mut seen: Vec<DaemonStatus> = vec![];
        let rt = prepare(Some(&h), || None, &ticking(), &mut |s| seen.push(s)).unwrap().unwrap();
        assert_eq!(rt.path.len(), 3, "Node's folder, then PortableGit's cmd and bin");
        let fetched: Vec<&str> = seen.iter().filter_map(|s| s.preparing.as_ref()).map(|p| p.name.as_str()).collect();
        assert_eq!(fetched.first(), Some(&"node"));
        assert_eq!(fetched.last(), Some(&"git"));
        assert!(seen.iter().filter_map(|s| s.preparing.as_ref()).any(|p| p.name == "git" && p.version == "2.56.1"));
        assert!(seen.iter().all(|s| s.tools_missing.is_none()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_update_naming_a_new_node_shows_only_the_download_and_a_dev_build_fetches_nothing() {
        let root = temp_root();
        let server = Server::new();
        let h = runtime_host(&root, "darwin-arm64", &server);
        // What an earlier release fetched: another version, so the one this release names is missing.
        std::fs::create_dir_all(root.join("node-22.19.0-darwin-arm64").join("bin")).unwrap();
        std::fs::write(root.join("node-22.19.0-darwin-arm64").join("bin").join("node"), b"v22.19.0").unwrap();
        let mut seen: Vec<DaemonStatus> = vec![];
        let rt = prepare(Some(&h), || None, &ticking(), &mut |s| seen.push(s)).unwrap();
        assert!(rt.is_some_and(|r| r.node.starts_with(root.join("node-22.23.5-darwin-arm64"))));
        assert!(!seen.is_empty());
        assert!(
            seen.iter().all(|s| s.preparing.as_ref().is_some_and(|p| p.version == "22.23.5")
                && s.error.is_none()
                && s.tools_missing.is_none()),
            "only the download, never another step: {seen:?}"
        );
        // A development build runs the machine's Node: nothing to fetch, only the git check.
        let mut dev: Vec<DaemonStatus> = vec![];
        assert_eq!(prepare(None, || None, &ticking(), &mut |s| dev.push(s)), Ok(None));
        assert!(dev.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn download_progress_goes_out_at_its_ends_and_at_most_every_quarter_second_between() {
        let t0 = Instant::now();
        let p = |done: u64| runtime::Progress { name: "node", version: "22.23.5", done, total: Some(1000) };
        assert!(progress_due(None, t0, &p(500)), "the first word always goes out");
        assert!(progress_due(Some(t0), t0, &p(0)), "a download's start always does");
        assert!(progress_due(Some(t0), t0, &p(1000)), "and its end");
        assert!(!progress_due(Some(t0), t0 + Duration::from_millis(100), &p(500)));
        assert!(progress_due(Some(t0), t0 + PROGRESS_EVERY, &p(500)));
        let unknown = runtime::Progress { name: "node", version: "22.23.5", done: 500, total: None };
        assert!(!progress_due(Some(t0), t0 + Duration::from_millis(100), &unknown));
    }
}
