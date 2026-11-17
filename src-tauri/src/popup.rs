#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use serde::Deserialize;

#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PopupEntry {
    /// An item: chosen, its index among the menu's items (depth first, separators not counted) is the answer.
    Item {
        label: String,
        enabled: bool,
        /// A choice's tick; absent for a command.
        checked: Option<bool>,
        /// The key shown on the right, in the keymap's form ("cmd+shift+m").
        keys: Option<String>,
        /// The action's icon as PNG bytes, drawn at 2x for 16 points (native-menu.ts `iconImage`); only its shape is read.
        icon: Option<Vec<u8>>,
    },
    Separator,
    Submenu {
        label: String,
        enabled: bool,
        items: Vec<PopupEntry>,
    },
}

#[derive(Debug, Default, PartialEq, Eq, Clone, Copy)]
pub struct Modifiers {
    pub cmd: bool,
    pub shift: bool,
    pub alt: bool,
    pub ctrl: bool,
}

pub fn key_equivalent(spec: &str) -> Option<(String, Modifiers)> {
    let mut mods = Modifiers::default();
    let mut key = None;
    for part in spec.split('+').filter(|p| !p.is_empty()) {
        match part {
            "cmd" => mods.cmd = true,
            "shift" => mods.shift = true,
            "alt" => mods.alt = true,
            "ctrl" => mods.ctrl = true,
            other => key = Some(other),
        }
    }
    let key = key.or_else(|| spec.ends_with('+').then_some("+"))?;
    let character = match key {
        "enter" => "\r".to_string(),
        "tab" => "\t".to_string(),
        "space" => " ".to_string(),
        "escape" => "\u{1b}".to_string(),
        "backspace" => "\u{8}".to_string(),
        "delete" => "\u{f728}".to_string(),
        "up" => "\u{f700}".to_string(),
        "down" => "\u{f701}".to_string(),
        "left" => "\u{f702}".to_string(),
        "right" => "\u{f703}".to_string(),
        // A letter is given lower case, Shift as a modifier, as AppKit draws ⇧⌘M from "m" and Shift.
        single if single.chars().count() == 1 => single.to_lowercase(),
        _ => return None,
    };
    Some((character, mods))
}

/// Pop the menu up in the window at `x`, `y` (CSS pixels from the window's top-left corner) and answer with the index of
/// the item chosen, or None when the menu closed with nothing chosen.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn popup_menu(
    window: tauri::WebviewWindow,
    entries: Vec<PopupEntry>,
    x: f64,
    y: f64,
) -> Result<Option<usize>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let target = window.clone();
    window.run_on_main_thread(move || mac::pop_up(&target, &entries, x, y, tx)).map_err(|e| e.to_string())?;
    Ok(rx.await.unwrap_or(None))
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn popup_menu(entries: Vec<PopupEntry>, x: f64, y: f64) -> Result<Option<usize>, String> {
    let _ = (entries, x, y);
    Err("native pop-up menus are the Mac's".into())
}

#[cfg(target_os = "macos")]
mod mac {
    use super::{key_equivalent, PopupEntry};
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, NSObject};
    use objc2::{define_class, msg_send, sel, AnyThread, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSControlStateValueOff, NSControlStateValueOn, NSEventModifierFlags, NSImage, NSMenu, NSMenuItem, NSView,
    };
    use objc2_foundation::{NSData, NSPoint, NSSize, NSString};
    use std::cell::RefCell;
    use tokio::sync::oneshot::Sender;

    thread_local! {
        static ANSWER: RefCell<Option<Sender<Option<usize>>>> = const { RefCell::new(None) };
        /// The last menu and the target its items send to, kept until the next menu opens: an item's target is a weak
        /// reference, and AppKit may send the chosen item's action after the menu's tracking has returned.
        static LAST: RefCell<Option<(Retained<NSMenu>, Retained<PopupTarget>)>> = const { RefCell::new(None) };
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "LokiPopupTarget"]
        struct PopupTarget;

        impl PopupTarget {
            #[unsafe(method(pick:))]
            fn pick(&self, sender: &NSMenuItem) {
                if let Some(tx) = ANSWER.with(|a| a.borrow_mut().take()) {
                    let _ = tx.send(usize::try_from(sender.tag()).ok());
                }
            }
        }
    );

    impl PopupTarget {
        fn new(mtm: MainThreadMarker) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(());
            unsafe { msg_send![super(this), init] }
        }
    }

    const ICON_POINTS: f64 = 16.0;

    fn icon_image(png: &[u8]) -> Option<Retained<NSImage>> {
        let image = NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(png))?;
        image.setSize(NSSize::new(ICON_POINTS, ICON_POINTS));
        image.setTemplate(true);
        Some(image)
    }

    fn item(mtm: MainThreadMarker, label: &str) -> Retained<NSMenuItem> {
        unsafe {
            NSMenuItem::initWithTitle_action_keyEquivalent(
                NSMenuItem::alloc(mtm),
                &NSString::from_str(label),
                None,
                &NSString::from_str(""),
            )
        }
    }

    fn build(
        mtm: MainThreadMarker,
        entries: &[PopupEntry],
        target: &PopupTarget,
        next: &mut isize,
    ) -> Retained<NSMenu> {
        let menu = NSMenu::new(mtm);
        // Enabled is the page's to say, not AppKit's guess from the target.
        menu.setAutoenablesItems(false);
        for entry in entries {
            match entry {
                PopupEntry::Separator => menu.addItem(&NSMenuItem::separatorItem(mtm)),
                PopupEntry::Item { label, enabled, checked, keys, icon } => {
                    let it = item(mtm, label);
                    unsafe {
                        it.setTarget(Some(target as &AnyObject));
                        it.setAction(Some(sel!(pick:)));
                    }
                    it.setTag(*next);
                    *next += 1;
                    it.setEnabled(*enabled);
                    if let Some(on) = checked {
                        it.setState(if *on { NSControlStateValueOn } else { NSControlStateValueOff });
                    }
                    if let Some((key, mods)) = keys.as_deref().and_then(key_equivalent) {
                        it.setKeyEquivalent(&NSString::from_str(&key));
                        let mut mask = NSEventModifierFlags::empty();
                        if mods.cmd {
                            mask |= NSEventModifierFlags::Command;
                        }
                        if mods.shift {
                            mask |= NSEventModifierFlags::Shift;
                        }
                        if mods.alt {
                            mask |= NSEventModifierFlags::Option;
                        }
                        if mods.ctrl {
                            mask |= NSEventModifierFlags::Control;
                        }
                        it.setKeyEquivalentModifierMask(mask);
                    }
                    if let Some(image) = icon.as_deref().and_then(icon_image) {
                        it.setImage(Some(&image));
                    }
                    menu.addItem(&it);
                }
                PopupEntry::Submenu { label, enabled, items } => {
                    let it = item(mtm, label);
                    let sub = build(mtm, items, target, next);
                    sub.setTitle(&NSString::from_str(label));
                    it.setSubmenu(Some(&sub));
                    it.setEnabled(*enabled);
                    menu.addItem(&it);
                }
            }
        }
        menu
    }

    pub fn pop_up(window: &tauri::WebviewWindow, entries: &[PopupEntry], x: f64, y: f64, tx: Sender<Option<usize>>) {
        let (Some(mtm), Ok(view)) = (MainThreadMarker::new(), window.ns_view()) else {
            let _ = tx.send(None);
            return;
        };
        let view: &NSView = unsafe { &*view.cast() };
        let target = PopupTarget::new(mtm);
        let menu = build(mtm, entries, &target, &mut 0);
        LAST.with(|l| *l.borrow_mut() = Some((menu.clone(), target)));
        ANSWER.with(|a| *a.borrow_mut() = Some(tx));
        // The content view is not flipped: its origin is the bottom-left corner, the page's the top-left.
        let at = NSPoint::new(x, view.frame().size.height - y);
        let chosen = menu.popUpMenuPositioningItem_atLocation_inView(None, at, Some(view));
        if !chosen {
            if let Some(tx) = ANSWER.with(|a| a.borrow_mut().take()) {
                let _ = tx.send(None);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_letter_is_lower_case_with_its_modifiers() {
        let (key, mods) = key_equivalent("cmd+shift+m").unwrap();
        assert_eq!(key, "m");
        assert_eq!(mods, Modifiers { cmd: true, shift: true, alt: false, ctrl: false });
    }

    #[test]
    fn named_keys_become_the_characters_appkit_draws() {
        assert_eq!(key_equivalent("cmd+enter").unwrap().0, "\r");
        assert_eq!(key_equivalent("cmd+[").unwrap().0, "[");
        assert_eq!(key_equivalent("alt+up").unwrap().0, "\u{f700}");
        assert_eq!(key_equivalent("cmd++").unwrap().0, "+");
    }

    #[test]
    fn a_spec_with_no_key_or_an_unknown_one_shows_none() {
        assert_eq!(key_equivalent("cmd+shift"), None);
        assert_eq!(key_equivalent("cmd+pagedown"), None);
        assert_eq!(key_equivalent(""), None);
    }

    #[test]
    fn the_page_sends_items_separators_and_submenus() {
        let entries: Vec<PopupEntry> = serde_json::from_str(
            r#"[
              {"type":"item","label":"Archive","enabled":true,"keys":"cmd+e","icon":[137,80,78,71]},
              {"type":"separator"},
              {"type":"submenu","label":"Move","enabled":true,"items":[{"type":"item","label":"Work","enabled":false,"checked":true}]}
            ]"#,
        )
        .unwrap();
        assert_eq!(
            entries,
            vec![
                PopupEntry::Item {
                    label: "Archive".into(),
                    enabled: true,
                    checked: None,
                    keys: Some("cmd+e".into()),
                    icon: Some(vec![137, 80, 78, 71])
                },
                PopupEntry::Separator,
                PopupEntry::Submenu {
                    label: "Move".into(),
                    enabled: true,
                    items: vec![PopupEntry::Item {
                        label: "Work".into(),
                        enabled: false,
                        checked: Some(true),
                        keys: None,
                        icon: None
                    }]
                },
            ]
        );
    }
}
