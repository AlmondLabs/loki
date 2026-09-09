//! loki desktop shell (Tauri).
//!
//! A native window around the React canvas. The Rust side:
//!  - hands the page the mod's token and port before any script runs
//!  - holds the app-server socket (with the bearer token) and relays frames
//!  - finds Desktop's harness, or starts its own `letta server --listen …`

mod appserver;
mod bootstrap;
mod harness;
mod install;
mod menu;
mod native;
mod widgets;

use std::path::PathBuf;
use tauri::{Manager, State};

fn loki_dir() -> PathBuf {
    home_dir().join(".letta").join("loki")
}

fn read_token() -> Option<String> {
    std::fs::read_to_string(loki_dir().join("token")).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// The capability token the harness, the mod and this shell share. The mod creates it on first
/// activate, but a first launch starts the harness *before* any mod ran, so the shell writes it
/// when it is missing (32 hex chars from /dev/urandom, mode 0600 — the same shape the mod makes).
fn ensure_token() -> Option<String> {
    if let Some(t) = read_token() { return Some(t); }
    use std::io::Read;
    let mut bytes = [0u8; 16];
    std::fs::File::open("/dev/urandom").ok()?.read_exact(&mut bytes).ok()?;
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
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

/// Settings › letta "update": pull the newest Letta Code the way this one was installed, then restart the
/// harness on it. Only for a harness loki started (Desktop's, or one adopted from an earlier run, is not ours to restart).
#[tauri::command]
fn update_letta(app: tauri::AppHandle, boot: State<'_, bootstrap::BootstrapState>) -> Result<(), String> {
    if app.try_state::<harness::Harness>().is_none() {
        return Err("this harness is not loki's to restart — update Letta Code where it runs".into());
    }
    let Some(rt) = boot.0.lock().ok().and_then(|s| s.runtime()) else { return Err("no Letta Code to update".into()) };
    // loki only ever moves its own copy; a binary named by LOKI_LETTA_BIN is whoever's to update.
    if !rt.private {
        return Err(format!("{} is not loki's copy — update it yourself", rt.letta.display()));
    }
    if boot.0.lock().map(|s| s.installing).unwrap_or(false) { return Ok(()); }
    let home = home_dir();
    let data = loki_dir();
    let before = boot.0.lock().ok().and_then(|s| s.version.clone());
    run_bootstrap_job(app, "updating loki's copy of Letta Code", move |report| {
        let after = bootstrap::install_version(&data, &home, "latest", report)?;
        // npm said yes but the copy did not move: say so instead of restarting the harness for nothing.
        let now = bootstrap::letta_version(&after);
        if before.is_some() && now == before {
            return Err(format!("the install finished, but {} still reports {}", after.letta.display(), now.unwrap_or_default()));
        }
        Ok(after)
    });
    Ok(())
}

/// Install (or retry installing) Letta Code privately, then start the harness. Progress: `loki:bootstrap` events.
#[tauri::command]
fn install_letta(app: tauri::AppHandle, boot: State<'_, bootstrap::BootstrapState>) -> Result<(), String> {
    if boot.0.lock().map(|s| s.installing).unwrap_or(false) { return Ok(()); }
    start_install(app);
    Ok(())
}

/// The install, off the main thread; on success the harness starts and the link (already retrying) connects.
fn start_install(app: tauri::AppHandle) {
    let (data, home) = (loki_dir(), home_dir());
    run_bootstrap_job(app, "installing loki's copy of Letta Code", move |report| bootstrap::install(&data, &home, report));
}

/// An install or update, off the main thread: progress as `loki:bootstrap` events and Status.log, and on
/// success the harness (re)starts on the runtime the job produced — the link, already retrying, reconnects.
fn run_bootstrap_job(app: tauri::AppHandle, opening: &str, job: impl FnOnce(&dyn Fn(bootstrap::Progress)) -> Result<bootstrap::Runtime, String> + Send + 'static) {
    use tauri::Emitter;
    let home = home_dir();
    if let Some(b) = app.try_state::<bootstrap::BootstrapState>() {
        if let Ok(mut s) = b.0.lock() { s.installing = true; s.error = None; s.log.clear(); }
    }
    let _ = app.emit("loki:bootstrap", bootstrap::Progress { stage: "start", message: opening.to_string() });
    tauri::async_runtime::spawn_blocking(move || {
        let report = |p: bootstrap::Progress| {
            eprintln!("loki: bootstrap: {} · {}", p.stage, p.message);
            if let Some(b) = app.try_state::<bootstrap::BootstrapState>() {
                if let Ok(mut s) = b.0.lock() { s.log.push(p.message.clone()); if s.log.len() > 200 { s.log.remove(0); } }
            }
            let _ = app.emit("loki:bootstrap", p);
        };
        let result = job(&report);
        let Some(b) = app.try_state::<bootstrap::BootstrapState>() else { return };
        match result {
            Ok(rt) => {
                harness::ensure_backend_mode(&rt, &home);
                let version = bootstrap::letta_version(&rt);
                let started = app.try_state::<harness::Harness>().map(|h| h.start(&rt, &loki_dir().join("token"), &loki_dir().join("logs"))).unwrap_or(Err("no harness slot".into()));
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

fn home_dir() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

/// Release builds install on every launch; `tauri dev` leaves a developer's shim alone unless asked (LOKI_INSTALL=1).
fn install_wanted() -> bool {
    if std::env::var_os("LOKI_NO_INSTALL").is_some() { return false; }
    !cfg!(debug_assertions) || std::env::var_os("LOKI_INSTALL").is_some()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = ensure_token();
    let script = init_script();
    tauri::Builder::default()
        // Links leave the app through the system browser (window.open is blocked in the webview).
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![appserver_send, appserver_url, client_log, install_status, tool_status, bootstrap_status, install_letta, check_letta_update, update_letta, native::set_waiting, menu::set_menu])
        // Agent-written widgets, transpiled on request: loki://localhost/widgets/<desk>/<name>.js
        .register_uri_scheme_protocol("loki", |_ctx, request| widgets::respond(request.uri().path()))
        .setup(move |app| {
            use tauri::{WebviewUrl, WebviewWindowBuilder};

            // The mod first, so a harness we start below loads the copy that ships with this build.
            // Everything loki writes lives under ~/.letta/loki (loki_dir): the mod bundle, the phone canvas, the private runtime.
            let home = home_dir();
            let mut report = install::Report::skipped(&home);
            if install_wanted() {
                let resources = app.path().resource_dir().ok().and_then(|d| install::find_resources(&d));
                report = match resources {
                    Some(res) => install::run(&res, &loki_dir(), &home),
                    None => install::Report { r#mod: install::State::Error, error: Some("bundled mod not found in the app's resources".into()), ..install::Report::skipped(&home) },
                };
                eprintln!("loki: install: mod {:?} · skill {:?} · app {:?}{}", report.r#mod, report.skill, report.app, report.error.as_deref().map(|e| format!(" · {e}")).unwrap_or_default());
            }

            // Which harness? Desktop's if it is running; otherwise our own on a fixed port.
            let explicit = std::env::var("LOKI_APP_SERVER_URL").ok();
            let data_dir = loki_dir();
            let home_for_boot = home.clone();
            // (url, bearer, own-harness path?, letta runtime if found)
            let (url, bearer, own, runtime) = tauri::async_runtime::block_on(async {
                if let Some(u) = explicit {
                    return (u, None, false, None);
                }
                if let Some(u) = appserver::find_desktop_app_server(&[41414]).await {
                    return (u, None, false, None);
                }
                let token = read_token();
                // A loki harness from an earlier run may still be up (e.g. the app was killed): adopt it.
                if appserver::probe_with(harness::LISTEN_URL, token.as_deref()).await {
                    eprintln!("loki: adopting a running loki harness");
                    return (harness::LISTEN_URL.to_string(), token, false, None);
                }
                (harness::LISTEN_URL.to_string(), token, true, bootstrap::find_letta(&home_for_boot, &data_dir))
            });
            eprintln!("loki: app-server at {url} ({})", if own { "own harness" } else { "existing" });
            // A harness that was already up loaded whatever mod it found at its start.
            report.needs_reload = report.changed() && !own;
            app.manage(report);
            app.manage(bootstrap::BootstrapState(std::sync::Mutex::new(runtime.as_ref().map(bootstrap::Status::from_runtime).unwrap_or_default())));
            if own {
                app.manage(harness::Harness::default());
                match &runtime {
                    Some(rt) => {
                        eprintln!("loki: letta at {}{}", rt.letta.display(), if rt.private { " (installed by loki)" } else { "" });
                        harness::ensure_backend_mode(rt, &home);
                        if let Err(e) = app.state::<harness::Harness>().start(rt, &loki_dir().join("token"), &loki_dir().join("logs")) {
                            eprintln!("loki: {e}");
                            if let Ok(mut s) = app.state::<bootstrap::BootstrapState>().0.lock() { s.error = Some(e); }
                        }
                    }
                    None if std::env::var_os("LOKI_NO_BOOTSTRAP").is_some() => eprintln!("loki: letta not found and LOKI_NO_BOOTSTRAP is set"),
                    None => {
                        eprintln!("loki: no copy of Letta Code under {} — installing one", loki_dir().display());
                        start_install(app.handle().clone());
                    }
                }
                // SIGTERM/SIGINT (a `kill`, a logout) never reach Tauri's exit events: stop the harness ourselves.
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    use tokio::signal::unix::{signal, SignalKind};
                    let (Ok(mut term), Ok(mut int)) = (signal(SignalKind::terminate()), signal(SignalKind::interrupt())) else { return };
                    tokio::select! { _ = term.recv() => {}, _ = int.recv() => {} }
                    if let Some(h) = handle.try_state::<harness::Harness>() { h.stop(); }
                    handle.exit(0);
                });
            }

            let link = appserver::Link::new(url, bearer);
            app.manage(link.clone());
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move { link.run(handle).await });

            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("loki")
                .inner_size(1440.0, 900.0)
                .min_inner_size(900.0, 600.0)
                // The native title bar: macOS draws the desk's name (the page sets it) with the lights inline.
                .theme(Some(tauri::Theme::Dark))
                .background_color(tauri::window::Color(0x12, 0x15, 0x1b, 0xff))
                .initialization_script(&script)
                .build()?;
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
