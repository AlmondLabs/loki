//! The parts a browser tab cannot have: a menu-bar item and dock badge that
//! carry the waiting count, and a global shortcut (⌥Space) that brings Catch Up
//! up from anywhere.
//!
//! All of it is the Mac's (plan 014 KTD3): the tray and the global-shortcut plugin are macOS-only dependencies,
//! so a Linux build needs no appindicator library. Elsewhere the page's commands are there and do nothing, and the
//! page hides the switches (R3).

#[cfg(target_os = "macos")]
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
#[cfg(target_os = "macos")]
use tauri::{AppHandle, Emitter, Manager};
#[cfg(target_os = "macos")]
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[cfg(target_os = "macos")]
pub const TRAY_ID: &str = "loki-tray";

#[cfg(target_os = "macos")]
fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg(target_os = "macos")]
pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let mut builder = TrayIconBuilder::with_id(TRAY_ID).tooltip("loki").title("").show_menu_on_left_click(false);
    // The L in one colour, black on clear: macOS tints a template for a light or a dark menu bar. The app icon itself
    // would show as a solid square there.
    if let Ok(icon) = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-template.png")) {
        builder = builder.icon(icon).icon_as_template(true);
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
#[cfg(target_os = "macos")]
fn catch_up_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::ALT), Code::Space)
}

/// Install the plugin and register ⌥Space. The page can release it or take it again (`set_global_shortcut`),
/// since ⌥Space is also Raycast's, Alfred's and the input-source switcher's on many Macs.
#[cfg(target_os = "macos")]
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

/// Preferences › Keyboard shortcuts: hold or release ⌥Space. Registering again after a release is how the user reclaims it
/// from another app; the error names what went wrong so Settings can show it.
#[cfg(target_os = "macos")]
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
#[cfg(target_os = "macos")]
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

/// Windows and Linux: no system-wide key yet, and Settings shows no switch for it (R3).
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn set_global_shortcut(enabled: bool) -> Result<(), String> {
    let _ = enabled;
    Ok(())
}

/// Windows and Linux: no tray item or dock badge to carry the count yet.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn set_waiting(count: u32) {
    let _ = count;
}

/// Give the window an empty unified toolbar, as Mail's and Notes' windows have, so AppKit itself lays the traffic
/// lights out low in a 52 pt title bar, on every pass. Moving them after AppKit has laid them out (Tauri's
/// `traffic_light_position`) put them back in the corner for a frame on every focus, resize, title or appearance
/// change. The toolbar has no items, its title bar is transparent over the page (TitleBarStyle::Overlay), and it
/// draws no separator; the page lays its own title row out on the lights' (app sidebar.tsx GLASS_LIGHTS).
#[cfg(target_os = "macos")]
pub fn add_unified_toolbar(window: &tauri::WebviewWindow) {
    let w = window.clone();
    let _ = window.run_on_main_thread(move || {
        use objc2::MainThreadMarker;
        use objc2_app_kit::{NSTitlebarSeparatorStyle, NSToolbar, NSWindow, NSWindowToolbarStyle};
        use objc2_foundation::NSString;
        let Some(mtm) = MainThreadMarker::new() else { return };
        let Ok(ptr) = w.ns_window() else { return };
        // SAFETY: Tauri hands back the window's live NSWindow, and this runs on the main thread, where AppKit wants it.
        let ns_window: &NSWindow = unsafe { &*ptr.cast::<NSWindow>() };
        let toolbar = NSToolbar::initWithIdentifier(mtm.alloc(), &NSString::from_str("loki"));
        ns_window.setToolbar(Some(&toolbar));
        ns_window.setToolbarStyle(NSWindowToolbarStyle::Unified);
        ns_window.setTitlebarSeparatorStyle(NSTitlebarSeparatorStyle::None);
    });
}

/// Where AppKit has put the main window's traffic lights, in points from the window's top-left corner: the close
/// button's left edge, the zoom button's right edge, and the buttons' centre line. The page lays its toolbar row out
/// on it (app sidebar.tsx adoptTrafficLights), so the lights stay wherever the system puts them, on any macOS.
#[cfg(target_os = "macos")]
#[derive(Clone, Debug, serde::Serialize)]
pub struct TrafficLights {
    left: f64,
    right: f64,
    middle: f64,
}

/// The main window's traffic lights as AppKit has laid them out in the toolbar's title bar; none before the window has
/// its buttons, or off the main thread, where AppKit cannot be asked. A command without `async` runs on the main thread.
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn traffic_lights(window: tauri::WebviewWindow) -> Option<TrafficLights> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSWindow, NSWindowButton};
    MainThreadMarker::new()?;
    let ptr = window.ns_window().ok()?;
    // SAFETY: Tauri hands back the window's live NSWindow, and this runs on the main thread, where AppKit wants it.
    let ns_window: &NSWindow = unsafe { &*ptr.cast::<NSWindow>() };
    // The toolbar was added in a task queued after the window was built; lay the frame out so its buttons are placed.
    if let Some(content) = ns_window.contentView() {
        // SAFETY: the content view's superview is the window's frame view, alive as long as the window.
        if let Some(frame) = unsafe { content.superview() } {
            frame.layoutSubtreeIfNeeded();
        }
    }
    let height = ns_window.frame().size.height;
    let in_window = |kind| {
        let button = ns_window.standardWindowButton(kind)?;
        Some(button.convertRect_toView(button.bounds(), None))
    };
    let close = in_window(NSWindowButton::CloseButton)?;
    let zoom = in_window(NSWindowButton::ZoomButton)?;
    // Window coordinates run up from the bottom; the page's run down from the top.
    Some(TrafficLights {
        left: close.origin.x,
        right: zoom.origin.x + zoom.size.width,
        middle: height - (close.origin.y + close.size.height / 2.0),
    })
}

/// Windows and Linux: loki draws its own window buttons, so there are no lights to report.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn traffic_lights() -> Option<()> {
    None
}
