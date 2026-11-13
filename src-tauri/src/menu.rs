//! The menu bar, built from the keymap the page sends at startup (app/src/shell/keymap.ts is the
//! only source of truth). Our items emit `loki:menu` with the binding id; the page runs the action.
//! The App, Edit and Window menus are the system's predefined items.
//!
//! The Mac's only (plan 014 KTD4): Windows and Linux set no native menu at all; loki's own ☰ in its title strip
//! opens the same menus there, from the same keymap. `set_menu` is a no-op on those systems.

use serde::Deserialize;
#[cfg(target_os = "macos")]
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
#[cfg(target_os = "macos")]
use tauri::{AppHandle, Emitter, Runtime};

#[derive(Deserialize)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct MenuItemSpec {
    pub id: Option<String>,
    pub label: Option<String>,
    pub accelerator: Option<String>,
    pub separator: Option<bool>,
}

#[derive(Deserialize)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct MenuSpec {
    pub title: String,
    pub items: Vec<MenuItemSpec>,
}

#[cfg(target_os = "macos")]
pub const SETTINGS_ID: &str = "app.settings";

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn set_menu(app: AppHandle, menus: Vec<MenuSpec>) -> Result<(), String> {
    build(&app, menus).map_err(|e| e.to_string())
}

/// Windows and Linux: no menu bar; the ☰ in the title strip carries the menus.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn set_menu(menus: Vec<MenuSpec>) -> Result<(), String> {
    let _ = menus;
    Ok(())
}

#[cfg(target_os = "macos")]
fn build<R: Runtime>(app: &AppHandle<R>, menus: Vec<MenuSpec>) -> tauri::Result<()> {
    let settings = MenuItemBuilder::with_id(SETTINGS_ID, "Settings…").accelerator("CmdOrCtrl+Comma").build(app)?;
    let app_menu = SubmenuBuilder::new(app, "loki")
        .item(&PredefinedMenuItem::about(app, Some("About loki"), None)?)
        .separator()
        .item(&settings)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit").undo().redo().separator().cut().copy().paste().select_all().build()?;

    let mut bar = MenuBuilder::new(app).item(&app_menu).item(&edit);
    for m in menus {
        let mut sub = SubmenuBuilder::new(app, &m.title);
        for it in m.items {
            if it.separator == Some(true) {
                sub = sub.separator();
                continue;
            }
            let (Some(id), Some(label)) = (it.id, it.label) else { continue };
            let mut item = MenuItemBuilder::with_id(id, label);
            if let Some(acc) = it.accelerator {
                item = item.accelerator(acc);
            }
            sub = sub.item(&item.build(app)?);
        }
        bar = bar.item(&sub.build()?);
    }
    let window = SubmenuBuilder::new(app, "Window").minimize().maximize().separator().close_window().build()?;
    bar = bar.item(&window);
    app.set_menu(bar.build()?)?;
    Ok(())
}

/// Route every menu click to the page as `loki:menu` carrying the binding id. Registered once, at setup.
#[cfg(target_os = "macos")]
pub fn listen<R: Runtime>(app: &AppHandle<R>) {
    app.on_menu_event(|app, event| {
        let _ = app.emit("loki:menu", event.id().0.clone());
    });
}
