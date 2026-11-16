#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    loki_lib::prefer_x11();
    loki_lib::run()
}
