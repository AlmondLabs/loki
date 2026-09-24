//! loki desktop shell (Tauri).
//!
//! A native window around the React canvas. The Rust side:
//!  - hands the page the mod's token and port before any script runs
//!  - holds the app-server socket (with the bearer token) and relays frames
//!  - attaches to a running app-server (Desktop's, a `letta server`), or launches its own `letta server --listen …`
//!    from the machine's Letta Code — installing that with npm first when the Mac has none (bootstrap.rs)

mod appserver;
mod bootstrap;
mod harness;
mod install;
mod menu;
mod native;
mod scratch;
mod widgets;

use std::path::{Path, PathBuf};
use tauri::{Manager, State};

fn loki_dir() -> PathBuf {
    home_dir().join(".letta").join("loki")
}

fn read_token() -> Option<String> {
    std::fs::read_to_string(loki_dir().join("token")).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// 16 bytes from the system's random source as 32 lowercase hex chars — the shape the mod makes
/// (`randomBytes(16).toString("hex")`). The OS source, not /dev/urandom: Windows has no such file, and
/// reading it there silently produced no token, so the harness started pointing at a missing token file.
fn new_token() -> Option<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).ok()?;
    Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// The capability token the harness, the mod and this shell share. The mod creates it on first
/// activate, but a first launch starts the harness *before* any mod ran, so the shell writes it
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

fn init_script() -> String {
    let token = read_token().unwrap_or_default();
    let mod_port: u16 = std::env::var("LOKI_PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(41414);
    let desk = std::env::var("LOKI_DESK").ok();
    format!(
        "window.__LOKI__ = {{ token: {token}, modPort: {port}, desk: {desk} }};",
        token = serde_json::to_string(&token).unwrap_or_else(|_| "\"\"".into()),
        port = mod_port,
        desk = serde_json::to_string(&desk).unwrap_or_else(|_| "null".into()),
    )
}

/// The page's console, mirrored to the shell's stderr (there is no devtools in a packaged app).
#[tauri::command]
fn client_log(level: String, message: String) {
    eprintln!("loki[{level}]: {message}");
}

/// The page sends an app-server frame (already JSON).
#[tauri::command]
async fn appserver_send(link: State<'_, appserver::SharedLink>, text: String) -> Result<bool, String> {
    Ok(link.send(text).await)
}

/// Which app-server the shell is linked to, for the title block / diagnostics.
#[tauri::command]
fn appserver_url(link: State<'_, appserver::SharedLink>) -> String {
    link.url.clone()
}

/// What launch did about the mod and the skill (Settings shows it).
#[tauri::command]
fn install_status(report: State<'_, install::Report>) -> install::Report {
    report.inner().clone()
}

/// Where the programs loki depends on were found, if at all (letta: see bootstrap_status).
#[tauri::command]
fn tool_status(boot: State<'_, bootstrap::BootstrapState>) -> install::Tools {
    let mut t = install::tools(&home_dir());
    if let Ok(s) = boot.0.lock() { if s.letta.is_some() { t.letta = s.letta.clone(); } }
    t
}

/// Letta Code: found, being installed, installed, or failed.
#[tauri::command]
fn bootstrap_status(app: tauri::AppHandle, boot: State<'_, bootstrap::BootstrapState>) -> bootstrap::Status {
    let mut s = boot.0.lock().map(|s| s.clone()).unwrap_or_default();
    s.managed = app.try_state::<harness::Harness>().is_some() && s.letta.is_some();
    s
}

/// Settings › letta "check": what `letta --version` says and the newest release on npm. Off the main thread.
#[tauri::command]
async fn check_letta_update(app: tauri::AppHandle) -> Result<bootstrap::Status, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let boot = app.state::<bootstrap::BootstrapState>();
        let rt = boot.0.lock().ok().and_then(|s| s.runtime());
        let version = rt.as_ref().and_then(bootstrap::letta_version);
        let latest = bootstrap::latest_version();
        let mut s = boot.0.lock().map_err(|e| e.to_string())?;
        s.version = version;
        s.latest = latest?.into();
        s.managed = app.try_state::<harness::Harness>().is_some() && s.letta.is_some();
        Ok(s.clone())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Settings › letta "update": `npm install -g @letta-ai/letta-code@latest` — the same command that installed it,
/// into the same global folder — then restart the harness on it. Only for a harness loki launched (Desktop's, or
/// one adopted from an earlier run, is not ours to restart), and never for a binary named by LOKI_LETTA_BIN.
#[tauri::command]
fn update_letta(app: tauri::AppHandle, boot: State<'_, bootstrap::BootstrapState>) -> Result<(), String> {
    if app.try_state::<harness::Harness>().is_none() {
        return Err("this harness is not loki's to restart — update Letta Code where it runs".into());
    }
    let Some(rt) = boot.0.lock().ok().and_then(|s| s.runtime()) else { return Err("no Letta Code to update".into()) };
    if rt.explicit {
        return Err(format!("{} is named by LOKI_LETTA_BIN — not npm's to update", rt.letta.display()));
    }
    if boot.0.lock().map(|s| s.installing).unwrap_or(false) { return Ok(()); }
    let home = home_dir();
    let before = boot.0.lock().ok().and_then(|s| s.version.clone());
    run_bootstrap_job(app, "updating Letta Code with npm", move |report| {
        let after = bootstrap::install_version(&home, "latest", report)?;
        // npm said yes but the copy did not move: say so instead of restarting the harness for nothing.
        let now = bootstrap::letta_version(&after);
        if before.is_some() && now == before {
            return Err(format!("the install finished, but {} still reports {}", after.letta.display(), now.unwrap_or_default()));
        }
        Ok(after)
    });
    Ok(())
}

/// Settings › letta: the harness's scratch folder, the default, and the line for a terminal (scratch.rs).
#[tauri::command]
fn scratch_settings() -> scratch::Settings {
    scratch::settings(&loki_dir(), &home_dir())
}

/// Settings › letta: a new scratch folder (None: back to the default). Saved, then the harness restarts on it —
/// the env var is read at launch — when it is loki's own; a turn in progress stops, the link reconnects.
#[tauri::command]
fn set_scratch_dir(app: tauri::AppHandle, boot: State<'_, bootstrap::BootstrapState>, path: Option<String>) -> Result<scratch::Settings, String> {
    let (data, home) = (loki_dir(), home_dir());
    let chosen = match path.as_deref().map(str::trim) {
        Some(p) if !p.is_empty() => Some(scratch::validate(p, &home)?),
        _ => None,
    };
    scratch::write(&data, &scratch::ShellPrefs { scratch_dir: chosen.map(|p| p.to_string_lossy().into_owned()) })?;
    if app.try_state::<harness::Harness>().is_some() {
        if let Some(rt) = boot.0.lock().ok().and_then(|s| s.runtime()) {
            start_harness(&app, &rt)?;
        }
    }
    Ok(scratch::settings(&data, &home))
}

/// Install (or retry installing) Letta Code with npm, then start the harness. Progress: `loki:bootstrap` events.
#[tauri::command]
fn install_letta(app: tauri::AppHandle, boot: State<'_, bootstrap::BootstrapState>) -> Result<(), String> {
    if boot.0.lock().map(|s| s.installing).unwrap_or(false) { return Ok(()); }
    start_install(app);
    Ok(())
}

/// The install, off the main thread; on success the harness starts and the link (already retrying) connects.
fn start_install(app: tauri::AppHandle) {
    let home = home_dir();
    run_bootstrap_job(app, "installing Letta Code with npm", move |report| bootstrap::install(&home, report));
}

/// `letta server` on `rt`, with loki's token, logs, scratch folder and private mods folder.
fn start_harness(app: &tauri::AppHandle, rt: &bootstrap::Runtime) -> Result<(), String> {
    let (data, home) = (loki_dir(), home_dir());
    let Some(h) = app.try_state::<harness::Harness>() else { return Err("no harness slot".into()) };
    h.start(rt, &harness::Launch { token_file: &data.join("token"), log_dir: &data.join("logs"), scratch: &scratch::effective_dir(&data, &home) })
}

/// Every line an install or update produced, on disk: Welcome and Settings show the last few, this keeps them all
/// (one section per attempt, appended). Best effort — a log that cannot be written never stops an install.
fn install_log_line(line: &str) {
    use std::io::Write;
    let path = loki_dir().join("logs").join("install.log");
    if let Some(dir) = path.parent() { let _ = std::fs::create_dir_all(dir); }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) { let _ = writeln!(f, "{line}"); }
}

/// An install or update, off the main thread: progress as `loki:bootstrap` events, Status.log and
/// ~/.letta/loki/logs/install.log, and on success the harness (re)starts on the runtime the job produced — the
/// link, already retrying, reconnects.
fn run_bootstrap_job(app: tauri::AppHandle, opening: &str, job: impl FnOnce(&dyn Fn(bootstrap::Progress)) -> Result<bootstrap::Runtime, String> + Send + 'static) {
    use tauri::Emitter;
    let home = home_dir();
    if let Some(b) = app.try_state::<bootstrap::BootstrapState>() {
        if let Ok(mut s) = b.0.lock() { s.installing = true; s.error = None; s.log.clear(); }
    }
    install_log_line(&format!("\n--- {opening} · {} · loki {} ---", bootstrap::stamp(), env!("CARGO_PKG_VERSION")));
    let _ = app.emit("loki:bootstrap", bootstrap::Progress { stage: "start", message: opening.to_string() });
    tauri::async_runtime::spawn_blocking(move || {
        let report = |p: bootstrap::Progress| {
            eprintln!("loki: bootstrap: {} · {}", p.stage, p.message);
            install_log_line(&format!("[{}] {}", p.stage, p.message));
            if let Some(b) = app.try_state::<bootstrap::BootstrapState>() {
                if let Ok(mut s) = b.0.lock() { s.log.push(p.message.clone()); if s.log.len() > 200 { s.log.remove(0); } }
            }
            let _ = app.emit("loki:bootstrap", p);
        };
        let result = job(&report);
        match &result {
            Ok(rt) => install_log_line(&format!("done: {}", rt.letta.display())),
            Err(e) => install_log_line(&format!("error: {e}")),
        }
        let Some(b) = app.try_state::<bootstrap::BootstrapState>() else { return };
        match result {
            Ok(rt) => {
                harness::ensure_backend_mode(&rt, &home);
                let version = bootstrap::letta_version(&rt);
                let started = start_harness(&app, &rt);
                if let Ok(mut s) = b.0.lock() {
                    let (log, latest) = (std::mem::take(&mut s.log), s.latest.take());
                    *s = bootstrap::Status::from_runtime(&rt);
                    s.log = log;
                    s.version = version;
                    s.latest = latest;
                    if let Err(e) = started { s.error = Some(e); }
                }
                let _ = app.emit("loki:bootstrap", bootstrap::Progress { stage: "done", message: "harness starting".into() });
            }
            Err(e) => {
                if let Ok(mut s) = b.0.lock() { s.installing = false; s.error = Some(e.clone()); }
                let _ = app.emit("loki:bootstrap", bootstrap::Progress { stage: "error", message: e });
            }
        }
    });
}

/// The user's home folder, where everything loki keeps lives (~/.letta/loki). It has to be the folder the
/// mod's `os.homedir()` answers inside the harness, or the two would read different tokens and state: on
/// Windows that is USERPROFILE (Node ignores a HOME there, such as Git Bash's), elsewhere HOME. An empty
/// value counts as unset. `run` checks it once at launch and stops with a line on stderr when there is none,
/// rather than keeping ~/.letta under `/` as it once did.
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

/// Release builds install on every launch; `tauri dev` leaves a developer's shim alone unless asked (LOKI_INSTALL=1).
fn install_wanted() -> bool {
    if std::env::var_os("LOKI_NO_INSTALL").is_some() { return false; }
    !cfg!(debug_assertions) || std::env::var_os("LOKI_INSTALL").is_some()
}

/// The checkout a development build was compiled from, when it should be wired into Letta where nothing is yet
/// (install.rs `link_checkout`). Release builds: never (the path is not even in the binary). LOKI_NO_INSTALL: no.
fn dev_checkout() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        if std::env::var_os("LOKI_NO_INSTALL").is_some() { return None; }
        return PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().map(Path::to_path_buf);
    }
    #[allow(unreachable_code)]
    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if platform_home().is_none() {
        eprintln!("loki: {HOME_VAR} is not set, so there is no home folder for ~/.letta/loki; set it and start loki again");
        std::process::exit(1);
    }
    let _ = ensure_token();
    let script = init_script();
    tauri::Builder::default()
        // Links leave the app through the system browser (window.open is blocked in the webview).
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![appserver_send, appserver_url, client_log, install_status, tool_status, bootstrap_status, install_letta, check_letta_update, update_letta, native::set_waiting, native::set_global_shortcut, menu::set_menu, scratch_settings, set_scratch_dir])
        // Agent-written widgets, transpiled on request: loki://localhost/widgets/<desk>/<name>.js
        .register_uri_scheme_protocol("loki", |_ctx, request| widgets::respond(request.uri().path()))
        .setup(move |app| {
            use tauri::{WebviewUrl, WebviewWindowBuilder};

            // The mod first, so a harness we launch below loads the copy that ships with this build.
            // Everything loki writes lives under ~/.letta/loki (loki_dir): the mod bundle, the phone canvas; the shim in ~/.letta/mods.
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
                eprintln!("loki: dev: mod {:?} · skill {:?} · shim {} → {}{}", report.r#mod, report.skill, report.shim, report.mod_path, report.error.as_deref().map(|e| format!(" · {e}")).unwrap_or_default());
            }

            // Which harness? A running app-server if there is one (Desktop's, a `letta server`, loki's own from an
            // earlier run); otherwise launch our own on a fixed port from the machine's Letta Code.
            let explicit = std::env::var("LOKI_APP_SERVER_URL").ok();
            let token = read_token();
            let home_for_boot = home.clone();
            // (url, bearer, launching our own?, letta runtime if found)
            let (url, bearer, own, runtime) = tauri::async_runtime::block_on(async {
                if let Some(u) = explicit {
                    return (u, None, false, None);
                }
                if let Some((u, b)) = appserver::find_app_server(&[41414, 41415], token.as_deref()).await {
                    return (u, b, false, None);
                }
                (harness::LISTEN_URL.to_string(), token, true, bootstrap::find_letta(&home_for_boot))
            });
            eprintln!("loki: app-server at {url} ({})", if own { "launching" } else if url == harness::LISTEN_URL { "a loki harness already running" } else { "attached" });
            // A harness that was already up loaded whatever mod it found at its start.
            report.needs_reload = report.changed() && !own;
            app.manage(report);
            app.manage(bootstrap::BootstrapState(std::sync::Mutex::new(runtime.as_ref().map(bootstrap::Status::from_runtime).unwrap_or_default())));
            if own {
                app.manage(harness::Harness::default());
                match &runtime {
                    Some(rt) => {
                        eprintln!("loki: letta at {}{}", rt.letta.display(), if rt.explicit { " (LOKI_LETTA_BIN)" } else { "" });
                        harness::ensure_backend_mode(rt, &home);
                        if let Err(e) = start_harness(app.handle(), rt) {
                            eprintln!("loki: {e}");
                            if let Ok(mut s) = app.state::<bootstrap::BootstrapState>().0.lock() { s.error = Some(e); }
                        }
                    }
                    None => {
                        eprintln!("loki: no Letta Code on this Mac — installing it with npm");
                        start_install(app.handle().clone());
                    }
                }
                // SIGTERM/SIGINT (a `kill`, a logout) never reach Tauri's exit events: stop the harness ourselves.
                // Windows has no such signals; Ctrl-C in the console of a `tauri dev` is the one that reaches us there
                // (a GUI build has no console, and its quit paths all go through the exit events below).
                let handle = app.handle().clone();
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

            let link = appserver::Link::new(url, bearer);
            app.manage(link.clone());
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move { link.run(handle).await });

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
            window.build()?;
            menu::listen(app.handle());
            native::setup_tray(app.handle())?;
            if let Err(e) = native::setup_shortcut(app.handle()) { eprintln!("loki: global shortcut unavailable: {e}"); }
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
            // Quit from the menu, the dock, or the last window closing: take the harness down first.
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
}
