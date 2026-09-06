//! The menu bar, built from the keymap the page sends at startup (app/src/shell/keymap.ts is the
//! only source of truth). Our items emit `loki:menu` with the binding id; the page runs the action.
//! The App, Edit and Window menus are the system's predefined items.

use serde::Deserialize;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

#[derive(Deserialize)]
pub struct MenuItemSpec {
    pub id: Option<String>,
    pub label: Option<String>,
    pub accelerator: Option<String>,
    pub separator: Option<bool>,
}

#[derive(Deserialize)]
pub struct MenuSpec {
    pub title: String,
    pub items: Vec<MenuItemSpec>,
}

pub const SETTINGS_ID: &str = "app.settings";

#[tauri::command]
pub fn set_menu(app: AppHandle, menus: Vec<MenuSpec>) -> Result<(), String> {
    build(&app, menus).map_err(|e| e.to_string())
}

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
pub fn listen<R: Runtime>(app: &AppHandle<R>) {
    app.on_menu_event(|app, event| {
        let _ = app.emit("loki:menu", event.id().0.clone());
    });
}
