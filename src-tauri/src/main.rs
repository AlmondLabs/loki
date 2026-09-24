// Prevents an extra console window on Windows in release; harmless elsewhere.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Before anything else runs, so GTK and every thread see it (lib.rs `prefer_x11`, plan 014 KTD8).
    #[cfg(target_os = "linux")]
    loki_lib::prefer_x11();
    loki_lib::run()
}
