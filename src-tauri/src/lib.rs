//! loki desktop shell (Tauri).
//!
//! A native window around the React canvas. The Rust side:
//!  - hands the page the mod's token and port before any script runs
//!  - holds the app-server socket (with the bearer token) and relays frames
//!  - finds Desktop's harness, or starts its own `letta server --listen …`

mod appserver;
mod harness;
mod menu;
mod native;
mod widgets;

use std::path::PathBuf;
use tauri::{Manager, State};

fn loki_dir() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"));
    home.join(".letta").join("loki")
}

fn read_token() -> Option<String> {
    std::fs::read_to_string(loki_dir().join("token")).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let script = init_script();
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![appserver_send, appserver_url, client_log, native::set_waiting, menu::set_menu])
        // Agent-written widgets, transpiled on request: loki://localhost/widgets/<desk>/<name>.js
        .register_uri_scheme_protocol("loki", |_ctx, request| widgets::respond(request.uri().path()))
        .setup(move |app| {
            use tauri::{WebviewUrl, WebviewWindowBuilder};

            // Which harness? Desktop's if it is running; otherwise our own on a fixed port.
            let explicit = std::env::var("LOKI_APP_SERVER_URL").ok();
            let (url, bearer, own) = tauri::async_runtime::block_on(async {
                if let Some(u) = explicit {
                    return (u, None, None);
                }
                if let Some(u) = appserver::find_desktop_app_server(&[41414]).await {
                    return (u, None, None);
                }
                let token = read_token();
                // A loki harness from an earlier run may still be up (e.g. the app was killed): adopt it.
                if appserver::probe_with(harness::LISTEN_URL, token.as_deref()).await {
                    eprintln!("loki: adopting a running loki harness");
                    return (harness::LISTEN_URL.to_string(), token, None);
                }
                let token_file = loki_dir().join("token");
                let started = harness::Harness::spawn(&token_file, &loki_dir().join("logs")).ok();
                (harness::LISTEN_URL.to_string(), token, started)
            });
            eprintln!("loki: app-server at {url} ({})", if own.is_some() { "own harness" } else { "existing" });
            if let Some(h) = own {
                app.manage(h);
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
