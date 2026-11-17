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
const APP_MENU: &str = "loki";

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn set_menu(app: AppHandle, menus: Vec<MenuSpec>) -> Result<(), String> {
    build(&app, menus).map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn set_menu(menus: Vec<MenuSpec>) -> Result<(), String> {
    let _ = menus;
    Ok(())
}

#[cfg(target_os = "macos")]
fn build<R: Runtime>(app: &AppHandle<R>, menus: Vec<MenuSpec>) -> tauri::Result<()> {
    let (own, rest): (Vec<MenuSpec>, Vec<MenuSpec>) = menus.into_iter().partition(|m| m.title == APP_MENU);
    let mut app_menu =
        SubmenuBuilder::new(app, "loki").item(&PredefinedMenuItem::about(app, Some("About loki"), None)?).separator();
    for m in own {
        app_menu = add_items(app, app_menu, m.items)?;
    }
    let app_menu = app_menu.separator().hide().hide_others().show_all().separator().quit().build()?;
    let edit = SubmenuBuilder::new(app, "Edit").undo().redo().separator().cut().copy().paste().select_all().build()?;

    let mut bar = MenuBuilder::new(app).item(&app_menu).item(&edit);
    for m in rest {
        let sub = add_items(app, SubmenuBuilder::new(app, &m.title), m.items)?;
        bar = bar.item(&sub.build()?);
    }
    let window = SubmenuBuilder::new(app, "Window").minimize().maximize().separator().close_window().build()?;
    bar = bar.item(&window);
    app.set_menu(bar.build()?)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn add_items<'m, R: Runtime>(
    app: &AppHandle<R>,
    mut sub: SubmenuBuilder<'m, R, AppHandle<R>>,
    items: Vec<MenuItemSpec>,
) -> tauri::Result<SubmenuBuilder<'m, R, AppHandle<R>>> {
    for it in items {
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
    Ok(sub)
}

#[cfg(target_os = "macos")]
pub fn listen<R: Runtime>(app: &AppHandle<R>) {
    app.on_menu_event(|app, event| {
        let _ = app.emit("loki:menu", event.id().0.clone());
    });
}
