//! The parts a browser tab cannot have: a menu-bar item and dock badge that
//! carry the waiting count, and a global shortcut (⌥Space) that brings Catch Up
//! up from anywhere.

use tauri::{AppHandle, Emitter, Manager};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

pub const TRAY_ID: &str = "loki-tray";

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let mut builder = TrayIconBuilder::with_id(TRAY_ID).tooltip("loki").title("").show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone()).icon_as_template(true);
    }
    builder
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { .. } = event {
                let app = tray.app_handle();
                show_main(app);
                let _ = app.emit("loki:catch-up", ());
            }
        })
        .build(app)?;
    Ok(())
}

/// The one global shortcut: ⌥Space brings the inbox up from anywhere on the Mac.
fn catch_up_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::ALT), Code::Space)
}

/// Install the plugin and register ⌥Space. The page can release it or take it again (`set_global_shortcut`),
/// since ⌥Space is also Raycast's, Alfred's and the input-source switcher's on many Macs.
pub fn setup_shortcut(app: &AppHandle) -> tauri::Result<()> {
    let catch_up = catch_up_shortcut();
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, shortcut, event| {
                if shortcut == &catch_up && event.state() == ShortcutState::Pressed {
                    show_main(app);
                    let _ = app.emit("loki:catch-up", ());
                }
            })
            .build(),
    )?;
    app.global_shortcut().register(catch_up).map_err(|e| tauri::Error::Anyhow(e.into()))?;
    Ok(())
}

/// Settings › keys: hold or release ⌥Space. Registering again after a release is how the user reclaims it
/// from another app; the error names what went wrong so Settings can show it.
#[tauri::command]
pub fn set_global_shortcut(app: AppHandle, enabled: bool) -> Result<(), String> {
    let catch_up = catch_up_shortcut();
    let gs = app.global_shortcut();
    if gs.is_registered(catch_up) {
        gs.unregister(catch_up).map_err(|e| e.to_string())?;
    }
    if enabled {
        gs.register(catch_up).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The page tells us how many conversations are waiting; the tray title and dock badge follow.
#[tauri::command]
pub fn set_waiting(app: AppHandle, count: u32) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_title(Some(if count > 0 { count.to_string() } else { String::new() }));
        let _ = tray.set_tooltip(Some(if count > 0 { format!("loki · {count} waiting") } else { "loki".to_string() }));
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_badge_count(if count > 0 { Some(count as i64) } else { None });
    }
}
