//! The harness's scratch folder: where Letta Code's Bash tool keeps the output of background commands
//! (`LETTA_SCRATCHPAD`). Letta's default is a fresh folder under the system temp directory, but since
//! Letta Code 0.31.13 memory subagents — the dreaming (reflection) pass, its selector, the explicit-merge
//! reviewer — run in a sandbox that may write only under `~/.letta`, the transcripts and the memory repo.
//! The temp directory is not on that list, so every Bash call in those subagents fails and every pass
//! ends with no changes. A scratch folder under `~/.letta` is the fix; loki sets one for the harness it
//! starts and lets Settings › letta change it. Letta names the files inside by a per-process counter
//! (`task_1.log`), so two harnesses must never share one folder: the terminal's Letta gets its own.
//!
//! Persisted in `<data>/shell.json` (the shell's few preferences), applied at each harness start.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const PREFS_FILE: &str = "shell.json";
/// What the Settings page suggests for a `letta` run from a terminal: a sibling of loki's, never the same folder.
pub const TERMINAL_SUGGESTION: &str = "$HOME/.letta/scratch";

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShellPrefs {
    /// The scratch folder, when it is not the default; absolute, under ~/.letta.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scratch_dir: Option<String>,
}

/// What Settings shows: the folder in use, the default, and the line for a terminal.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub path: String,
    pub default_path: String,
    pub is_default: bool,
    pub terminal_suggestion: String,
}

pub fn default_dir(data: &Path) -> PathBuf {
    data.join("scratch")
}

pub fn read(data: &Path) -> ShellPrefs {
    std::fs::read_to_string(data.join(PREFS_FILE)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

pub fn write(data: &Path, prefs: &ShellPrefs) -> Result<(), String> {
    std::fs::create_dir_all(data).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(prefs).map_err(|e| e.to_string())?;
    std::fs::write(data.join(PREFS_FILE), text + "\n").map_err(|e| e.to_string())
}

/// The folder the harness gets: the preference when one is set, else the default.
pub fn effective_dir(data: &Path, home: &Path) -> PathBuf {
    match read(data).scratch_dir.as_deref().and_then(|p| validate(p, home).ok()) {
        Some(p) => p,
        None => default_dir(data),
    }
}

/// A candidate from Settings: `~` expanded, absolute, strictly inside ~/.letta (the one root the memory
/// subagent sandbox lets everything write to), and not a folder Letta or loki already own.
pub fn validate(candidate: &str, home: &Path) -> Result<PathBuf, String> {
    let trimmed = candidate.trim();
    if trimmed.is_empty() {
        return Err("empty path".into());
    }
    let expanded = match home_relative(trimmed, cfg!(windows)) { Some(rest) => home.join(rest), None => PathBuf::from(trimmed) };
    if !expanded.is_absolute() {
        return Err("the path must be absolute".into());
    }
    let letta = home.join(".letta");
    if !expanded.starts_with(&letta) || expanded == letta {
        return Err(format!("the sandbox only allows folders under {}", letta.display()));
    }
    for taken in ["lc-local-backend", "transcripts", "agents", "settings.json", "mods", "skills"] {
        if expanded == letta.join(taken) || expanded.starts_with(letta.join(taken)) {
            return Err(format!("{} is Letta's own; pick another folder under {}", expanded.display(), letta.display()));
        }
    }
    Ok(expanded)
}

/// What follows `~` and its separators when `path` starts at the home (`~`, `~/…`, and on Windows `~\…` too),
/// else None. Only on Windows is a backslash a separator; on the Mac and Linux `~\x` is a file name. A drive-letter
/// path such as `C:\Users\x\.letta\scratch` needs nothing here: it is absolute to `Path` on Windows already.
fn home_relative(path: &str, windows: bool) -> Option<&str> {
    let sep = |c: char| c == '/' || (windows && c == '\\');
    let rest = path.strip_prefix('~')?;
    if !rest.is_empty() && !rest.starts_with(sep) { return None; }
    Some(rest.trim_start_matches(sep))
}

/// Empty and recreate the folder (mode 0700): the logs inside belong to a process that is gone.
pub fn prepare(dir: &Path) -> Result<(), String> {
    if dir.exists() {
        std::fs::remove_dir_all(dir).map_err(|e| format!("could not clear {}: {e}", dir.display()))?;
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

pub fn settings(data: &Path, home: &Path) -> Settings {
    let path = effective_dir(data, home);
    let default = default_dir(data);
    Settings { is_default: path == default, path: path.to_string_lossy().into_owned(), default_path: default.to_string_lossy().into_owned(), terminal_suggestion: TERMINAL_SUGGESTION.into() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("loki-scratch-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn default_is_under_the_data_dir_and_prefs_round_trip() {
        let home = tmp("home");
        let data = home.join(".letta").join("loki");
        assert_eq!(default_dir(&data), data.join("scratch"));
        assert_eq!(read(&data), ShellPrefs::default());
        assert_eq!(effective_dir(&data, &home), data.join("scratch"));
        let custom = home.join(".letta").join("scratch-two");
        write(&data, &ShellPrefs { scratch_dir: Some(custom.to_string_lossy().into_owned()) }).unwrap();
        assert_eq!(read(&data).scratch_dir.as_deref(), Some(custom.to_str().unwrap()));
        assert_eq!(effective_dir(&data, &home), custom);
        let s = settings(&data, &home);
        assert!(!s.is_default);
        assert_eq!(s.default_path, data.join("scratch").to_string_lossy());
        // A preference that stopped being valid (outside ~/.letta) falls back to the default instead of breaking the harness.
        write(&data, &ShellPrefs { scratch_dir: Some("/tmp/elsewhere".into()) }).unwrap();
        assert_eq!(effective_dir(&data, &home), data.join("scratch"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_leading_tilde_is_the_home_with_either_separator_on_windows() {
        assert_eq!(home_relative("~", false), Some(""));
        assert_eq!(home_relative("~/.letta/scratch", false), Some(".letta/scratch"));
        assert_eq!(home_relative("~\\.letta\\scratch", true), Some(".letta\\scratch"));
        assert_eq!(home_relative("~/.letta/scratch", true), Some(".letta/scratch"));
        assert_eq!(home_relative("~\\.letta", false), None, "a backslash is a file-name character on the Mac and Linux");
        assert_eq!(home_relative("~someone/.letta", false), None, "another user's home is not expanded");
        assert_eq!(home_relative("/abs/.letta", false), None);
    }

    #[cfg(windows)]
    #[test]
    fn validate_takes_drive_letter_paths_and_tilde_backslash_on_windows() {
        let home = PathBuf::from(r"C:\Users\x");
        assert_eq!(validate(r"C:\Users\x\.letta\scratch", &home).unwrap(), home.join(".letta").join("scratch"));
        assert_eq!(validate(r"~\.letta\scratch", &home).unwrap(), home.join(".letta").join("scratch"));
        assert!(validate(r"relative\path", &home).is_err());
        assert!(validate(r"\Users\x\.letta\scratch", &home).is_err(), "no drive: not absolute on Windows");
        assert!(validate(r"D:\elsewhere", &home).is_err());
        assert!(validate(r"~\.letta\transcripts", &home).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn validate_keeps_the_folder_inside_the_sandbox_root_and_off_lettas_own() {
        let home = PathBuf::from("/Users/someone");
        assert_eq!(validate("~/.letta/scratch", &home).unwrap(), home.join(".letta/scratch"));
        assert_eq!(validate("/Users/someone/.letta/loki/scratch", &home).unwrap(), home.join(".letta/loki/scratch"));
        assert!(validate("/tmp/x", &home).is_err());
        assert!(validate("relative/path", &home).is_err());
        assert!(validate("~/.letta", &home).is_err());
        assert!(validate("~/.letta/lc-local-backend/x", &home).is_err());
        assert!(validate("~/.letta/transcripts", &home).is_err());
        assert!(validate("   ", &home).is_err());
    }

    #[test]
    fn prepare_empties_and_recreates() {
        let dir = tmp("prepare").join("scratch");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("task_1.log"), "old").unwrap();
        prepare(&dir).unwrap();
        assert!(dir.is_dir());
        assert!(!dir.join("task_1.log").exists());
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }
}
