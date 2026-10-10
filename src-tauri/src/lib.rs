//! loki desktop shell (Tauri).
//!
//! A native window around the React canvas. The Rust side:
//!  - moves loki's root to ~/.loki once (root.rs) and hands the page the token and the mod's port before any script runs
//!  - installs what a release build ships (install.rs): the mod and daemon bundles, the phone canvas, the agent's skill
//!  - runs loki's daemon on the machine's Node (node.rs, harness.rs), restarts it when it dies, and stops it on quit;
//!    the page talks to the daemon itself, over the mod's port

mod harness;
mod install;
mod menu;
mod native;
mod node;
mod procs;
mod root;
mod widgets;

use std::path::{Path, PathBuf};
use tauri::{Manager, State};

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
    if let Some(t) = read_token() { return Some(t); }
    let token = new_token()?;
    let dir = loki_dir();
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join("token");
    std::fs::write(&path, &token).ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    eprintln!("loki: wrote a new capability token");
    Some(token)
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

fn init_script() -> String {
    let token = read_token().unwrap_or_default();
    let mod_port: u16 = std::env::var("LOKI_PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(41414);
    let desk = std::env::var("LOKI_DESK").ok();
    format!(
        "window.__LOKI__ = {{ token: {token}, modPort: {port}, desk: {desk}, os: \"{os}\" }};",
        token = serde_json::to_string(&token).unwrap_or_else(|_| "\"\"".into()),
        port = mod_port,
        desk = serde_json::to_string(&desk).unwrap_or_else(|_| "null".into()),
        os = page_os(std::env::consts::OS),
    )
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

/// Where the programs loki depends on were found, if at all.
#[tauri::command]
fn tool_status() -> install::Tools {
    install::tools(&home_dir())
}

/// The daemon as Welcome and Settings see it: the Node it runs on, why it could not start, and — when no new-enough
/// Node was found — what Welcome's Node step needs to say.
#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonStatus {
    pub node: Option<String>,
    pub error: Option<String>,
    pub node_missing: Option<node::NodeMissing>,
}

/// DaemonStatus, kept current by start_daemon and the supervisor; `supervising` while a supervisor thread watches
/// the daemon, so a retry never starts a second one beside it.
#[derive(Default)]
struct DaemonState {
    status: std::sync::Mutex<DaemonStatus>,
    supervising: std::sync::atomic::AtomicBool,
}

impl DaemonState {
    fn get(&self) -> DaemonStatus {
        self.status.lock().map(|s| s.clone()).unwrap_or_default()
    }
    fn set(&self, f: impl FnOnce(&mut DaemonStatus)) {
        if let Ok(mut s) = self.status.lock() { f(&mut s); }
    }
}

#[tauri::command]
fn daemon_status(state: State<'_, DaemonState>) -> DaemonStatus {
    state.get()
}

/// Welcome's "check again" once the person has installed Node: look for Node afresh and start the daemon, unless a
/// supervisor already watches one (it restarts the daemon itself). Off the main thread: the look runs `node --version`.
#[tauri::command]
async fn retry_daemon(app: tauri::AppHandle) -> Result<DaemonStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DaemonState>();
        if !state.supervising.load(std::sync::atomic::Ordering::SeqCst) {
            if let Err(e) = start_daemon(&app) { eprintln!("loki: {e}"); }
        }
        state.get()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Start loki's daemon and keep it running: a daemon left by a crashed loki is stopped first, and one that dies is
/// restarted (supervise_daemon). A development build runs the checkout's sources; a release build the installed
/// bundle. What happened lands in DaemonState for daemon_status.
fn start_daemon(app: &tauri::AppHandle) -> Result<(), String> {
    let (home, data) = (home_dir(), loki_dir());
    let state = app.state::<DaemonState>();
    let node = match node::find_node_program(&home) {
        Ok(n) => n,
        Err(missing) => {
            let message = missing.message();
            state.set(|s| *s = DaemonStatus { node: None, error: Some(message.clone()), node_missing: Some(missing) });
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
        let daemon = harness::Daemon { node: &node, entry: &entry, mod_entry: &mod_entry, dir: &data };
        h.start_daemon(&daemon, &harness::Launch { token_file: &token_file, log_dir: &data.join("logs") })
    };
    if let Err(e) = launch(app) {
        state.set(|s| *s = DaemonStatus { node: Some(node_shown), error: Some(e.clone()), node_missing: None });
        return Err(e);
    }
    eprintln!("loki: daemon on {node_shown}");
    state.set(|s| *s = DaemonStatus { node: Some(node_shown), error: None, node_missing: None });
    if !state.supervising.swap(true, std::sync::atomic::Ordering::SeqCst) {
        supervise_daemon(app.clone(), launch);
    }
    Ok(())
}

/// Watch the daemon once a second. One that exits on its own is started again after harness::restart_delay; one loki
/// stopped, or one that found another daemon already serving (harness::EXIT_HELD), is left down — and then the
/// supervisor ends, so retry_daemon may start it again.
fn supervise_daemon(app: tauri::AppHandle, launch: impl Fn(&tauri::AppHandle) -> Result<(), String> + Send + 'static) {
    std::thread::Builder::new()
        .name("loki-daemon-supervisor".into())
        .spawn(move || {
            let mut exits: Vec<std::time::Instant> = vec![];
            loop {
                std::thread::sleep(std::time::Duration::from_secs(1));
                let Some(h) = app.try_state::<harness::Harness>() else { break };
                if h.was_stopped() { break; }
                let Some(status) = h.exited() else { continue };
                if status.code() == Some(harness::EXIT_HELD) {
                    eprintln!("loki: daemon: another daemon is already serving — using that one");
                    break;
                }
                exits.retain(|t| t.elapsed() < std::time::Duration::from_secs(60));
                let delay = harness::restart_delay(exits.len());
                exits.push(std::time::Instant::now());
                eprintln!("loki: daemon exited ({status}) — restarting in {} s", delay.as_secs());
                std::thread::sleep(delay);
                if h.was_stopped() { break; }
                let result = launch(&app);
                if let Err(e) = &result { eprintln!("loki: daemon restart failed: {e}"); }
                app.state::<DaemonState>().set(|s| s.error = result.err());
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
            let (Ok(mut term), Ok(mut int)) = (signal(SignalKind::terminate()), signal(SignalKind::interrupt())) else { return };
            tokio::select! { _ = term.recv() => {}, _ = int.recv() => {} }
        }
        #[cfg(not(unix))]
        let Ok(()) = tokio::signal::ctrl_c().await else { return };
        if let Some(h) = handle.try_state::<harness::Harness>() { h.stop(); }
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
    if std::env::var_os("LOKI_NO_INSTALL").is_some() { return false; }
    !cfg!(debug_assertions) || std::env::var_os("LOKI_INSTALL").is_some()
}

/// The checkout a development build was compiled from: its daemon runs the checkout's daemon/main.ts with
/// `--mod mod/boot.ts`, and the skill is linked there where nothing is yet (install.rs `link_checkout`). Release
/// builds: never (the path is not even in the binary). LOKI_NO_INSTALL: no, the installed bundles run.
fn dev_checkout() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        if std::env::var_os("LOKI_NO_INSTALL").is_some() { return None; }
        return PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().map(Path::to_path_buf);
    }
    #[allow(unreachable_code)]
    None
}

/// Linux runs loki through XWayland (plan 014 KTD8): GDK_BACKEND=x11 unless the user chose a backend, since an
/// undecorated window on native Wayland still has open resize and unresponsive-button bugs. The value to set, if any.
#[cfg(any(target_os = "linux", test))]
fn gdk_backend(current: Option<&std::ffi::OsStr>) -> Option<&'static str> {
    if current.is_some() { None } else { Some("x11") }
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
    // loki's root is ~/.loki, with a link at ~/.letta/loki: moved once, before anything opens a file in it (root.rs).
    // A failed move is said and loki carries on; the old folder stays where it was.
    match root::move_root(&home_dir()) {
        Ok(moved) => eprintln!("loki: root: {moved:?}"),
        Err(e) => eprintln!("loki: root not moved: {e}"),
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
        .invoke_handler(tauri::generate_handler![client_log, install_status, tool_status, daemon_status, retry_daemon, native::set_waiting, native::set_global_shortcut, menu::set_menu])
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
                    None => install::Report { r#mod: install::State::Error, error: Some("bundled mod not found in the app's resources".into()), ..install::Report::skipped(&home) },
                };
                eprintln!("loki: install: mod {:?} · skill {:?} · app {:?}{}", report.r#mod, report.skill, report.app, report.error.as_deref().map(|e| format!(" · {e}")).unwrap_or_default());
            } else if let Some(checkout) = dev_checkout() {
                report = install::link_checkout(&checkout, &home);
                eprintln!("loki: dev: mod {:?} {} · skill {:?}{}", report.r#mod, report.mod_path, report.skill, report.error.as_deref().map(|e| format!(" · {e}")).unwrap_or_default());
            }
            app.manage(report);

            // loki's daemon runs the agents and serves the page. No Node yet: Welcome says so, and retry_daemon starts
            // it once one is installed.
            app.manage(harness::Harness::default());
            app.manage(DaemonState::default());
            if let Err(e) = start_daemon(app.handle()) { eprintln!("loki: {e}"); }
            stop_on_signals(app.handle().clone());

            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("loki")
                .inner_size(1440.0, 900.0)
                .min_inner_size(900.0, 600.0)
                // It starts on the system theme; the page applies the saved light/dark preference after it loads.
                .background_color(tauri::window::Color(0x1a, 0x1d, 0x21, 0xff))
                .initialization_script(&script);
            // Slack style: no native title bar. The lights float over loki's own top strip (Sidebar.tsx,
            // TITLEBAR_HEIGHT, a drag region) at their standard spot; the title stays set for the Window menu,
            // Mission Control and screen readers, just not drawn.
            #[cfg(target_os = "macos")]
            let window = window.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
            // Windows and Linux (plan 014 KTD4): no system title bar at all; the strip draws Slack's there, with ☰ and
            // minimise, maximise and close (Sidebar.tsx TitleStrip). The window still resizes from its edges.
            #[cfg(not(target_os = "macos"))]
            let window = window.decorations(false);
            window.build()?;
            // The menu bar, the tray and ⌥Space are the Mac's (plan 014 KTD3); elsewhere their commands are no-ops.
            #[cfg(target_os = "macos")]
            {
                menu::listen(app.handle());
                native::setup_tray(app.handle())?;
                if let Err(e) = native::setup_shortcut(app.handle()) { eprintln!("loki: global shortcut unavailable: {e}"); }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(h) = window.app_handle().try_state::<harness::Harness>() { h.stop(); }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building loki")
        .run(|app, event| {
            // Quit from the menu, the dock, or the last window closing: take the daemon down first.
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                if let Some(h) = app.try_state::<harness::Harness>() { h.stop(); }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    #[test]
    fn tokens_are_32_lowercase_hex_chars_and_fresh_each_time() {
        let (a, b) = (new_token().unwrap(), new_token().unwrap());
        assert_eq!(a.len(), 32, "{a}");
        assert!(a.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)), "the mod's shape, /^[a-f0-9]{{32}}$/: {a}");
        assert_ne!(a, b);
    }

    fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<OsString> {
        move |k| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| OsString::from(v))
    }

    #[test]
    fn home_is_the_platforms_own_variable_and_never_slash() {
        assert_eq!(home_from(true, env(&[("USERPROFILE", r"C:\Users\x")])), Some(PathBuf::from(r"C:\Users\x")));
        assert_eq!(home_from(true, env(&[("USERPROFILE", r"C:\Users\x"), ("HOME", "/c/Users/x")])), Some(PathBuf::from(r"C:\Users\x")), "a Git Bash HOME does not win: os.homedir() reads USERPROFILE");
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
    fn the_page_is_told_its_system_in_one_of_three_words() {
        assert_eq!(page_os("macos"), "macos");
        assert_eq!(page_os("windows"), "windows");
        assert_eq!(page_os("linux"), "linux");
        assert_eq!(page_os("freebsd"), "linux");
        let expected = if cfg!(target_os = "macos") { "macos" } else if cfg!(windows) { "windows" } else { "linux" };
        assert!(init_script().ends_with(&format!(", os: \"{expected}\" }};")), "the script ends with the os (not printed: it carries the token)");
    }
}
