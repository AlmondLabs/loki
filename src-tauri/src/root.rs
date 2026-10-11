//! loki's root moves from `~/.letta/loki` to `~/.loki` (plan 017, KTD7), once, before anything opens a file in it:
//! the folder is renamed and a link left at the old path (a symlink, or a junction on Windows), so every path that
//! still names `~/.letta/loki` (agents' memories, old widget references, an older loki still installed) resolves.

use std::path::{Path, PathBuf};

/// The old and the new root under `home`.
pub fn roots(home: &Path) -> (PathBuf, PathBuf) {
    (home.join(".letta").join("loki"), home.join(".loki"))
}

/// What `move_root` did.
#[derive(Debug, PartialEq, Eq)]
pub enum RootMove {
    /// The folder moved and the link was left.
    Moved,
    /// The old path already leads to the new root.
    Already,
    /// Nothing was there: the new root was made. No link: nothing names the old path.
    Fresh,
}

/// Move the root. On an error nothing is made at the new path: loki runs on the old folder (`root_in_use`), and the
/// move is tried again at the next launch.
pub fn move_root(home: &Path) -> Result<RootMove, String> {
    let (old, new) = roots(home);
    if let (Ok(a), Ok(b)) = (std::fs::canonicalize(&old), std::fs::canonicalize(&new)) {
        if a == b {
            return Ok(RootMove::Already);
        }
    }
    let old_is_dir = std::fs::symlink_metadata(&old).map(|m| m.is_dir()).unwrap_or(false);
    if !old_is_dir {
        // Nothing to move (a new install, or one whose old folder and link were removed): only the new root matters.
        if new.is_dir() {
            return Ok(RootMove::Already);
        }
        std::fs::create_dir_all(&new).map_err(|e| format!("making {}: {e}", new.display()))?;
        return Ok(RootMove::Fresh);
    }
    if std::fs::symlink_metadata(&new).is_ok() {
        return Err(format!("both {} and {} exist; loki runs on {} until {} is moved aside", old.display(), new.display(), old.display(), new.display()));
    }
    std::fs::rename(&old, &new).map_err(|e| format!("moving {} to {}: {e}", old.display(), new.display()))?;
    if let Err(e) = link(&new, &old) {
        // Without the link the old paths break: put the folder back.
        let _ = std::fs::rename(&new, &old);
        return Err(e);
    }
    Ok(RootMove::Moved)
}

/// The root loki runs on once `move_root` has had its turn: the new one, unless the move failed with the old folder
/// still a real folder (not the link a finished move leaves) — then the old one, so a failed move never starts loki
/// on an empty root beside the person's data.
pub fn root_in_use(home: &Path, moved: &Result<RootMove, String>) -> PathBuf {
    let (old, new) = roots(home);
    let old_is_dir = std::fs::symlink_metadata(&old).map(|m| m.is_dir()).unwrap_or(false);
    if moved.is_err() && old_is_dir { old } else { new }
}

#[cfg(unix)]
fn link(target: &Path, at: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(target, at).map_err(|e| format!("linking {} to {}: {e}", at.display(), target.display()))
}

/// A junction, which needs no privilege (a directory symlink does).
#[cfg(windows)]
fn link(target: &Path, at: &Path) -> Result<(), String> {
    let out = std::process::Command::new("cmd").arg("/C").arg("mklink").arg("/J").arg(at).arg(target).output().map_err(|e| format!("mklink: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("linking {} to {}: {}", at.display(), target.display(), String::from_utf8_lossy(&out.stderr).trim()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("loki-root-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn the_folder_moves_once_and_the_old_path_still_resolves() {
        let home = tmp("move");
        let (old, new) = roots(&home);
        std::fs::create_dir_all(old.join("state")).unwrap();
        std::fs::write(old.join("state").join("pins.json"), "{}").unwrap();
        assert_eq!(move_root(&home), Ok(RootMove::Moved));
        assert_eq!(std::fs::read_to_string(new.join("state").join("pins.json")).unwrap(), "{}");
        assert_eq!(std::fs::read_to_string(old.join("state").join("pins.json")).unwrap(), "{}");
        std::fs::write(old.join("token"), "t").unwrap(); // written through the link
        assert_eq!(std::fs::read_to_string(new.join("token")).unwrap(), "t");
        assert_eq!(move_root(&home), Ok(RootMove::Already));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_first_start_makes_the_new_root_and_nothing_under_letta() {
        let home = tmp("fresh");
        assert_eq!(move_root(&home), Ok(RootMove::Fresh));
        let (_, new) = roots(&home);
        assert!(new.is_dir());
        assert!(!home.join(".letta").exists(), "no old path to keep resolving");
        assert_eq!(move_root(&home), Ok(RootMove::Already));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn once_the_old_folder_and_its_link_are_gone_nothing_brings_them_back() {
        let home = tmp("letgo");
        let (old, new) = roots(&home);
        std::fs::create_dir_all(&old).unwrap();
        assert_eq!(move_root(&home), Ok(RootMove::Moved));
        // The link: a symlink is removed as a file, a Windows junction as a directory (remove_file refuses it there).
        #[cfg(windows)]
        std::fs::remove_dir(&old).unwrap();
        #[cfg(not(windows))]
        std::fs::remove_file(&old).unwrap();
        std::fs::remove_dir(home.join(".letta")).unwrap();
        assert_eq!(move_root(&home), Ok(RootMove::Already));
        assert!(!home.join(".letta").exists());
        assert!(new.is_dir());
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A move that fails (here: the old folder cannot be renamed out of a read-only parent) leaves no new root behind,
    /// and loki runs on the old one; the next launch tries again rather than finding two roots.
    #[cfg(unix)]
    #[test]
    fn a_failed_move_makes_no_new_root_and_runs_on_the_old_one() {
        use std::os::unix::fs::PermissionsExt;
        let home = tmp("fail");
        let (old, new) = roots(&home);
        std::fs::create_dir_all(&old).unwrap();
        let letta = home.join(".letta");
        std::fs::set_permissions(&letta, std::fs::Permissions::from_mode(0o555)).unwrap();
        let moved = move_root(&home);
        let writable = std::fs::rename(&old, letta.join("probe")).is_ok(); // root ignores the mode
        std::fs::set_permissions(&letta, std::fs::Permissions::from_mode(0o755)).unwrap();
        if !writable {
            assert!(moved.is_err());
            assert!(!new.exists(), "nothing made at the new path");
            assert_eq!(root_in_use(&home, &moved), old);
            assert_eq!(move_root(&home), Ok(RootMove::Moved), "tried again once it can be");
            assert_eq!(root_in_use(&home, &Ok(RootMove::Moved)), new);
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn two_roots_are_left_alone() {
        let home = tmp("both");
        let (old, new) = roots(&home);
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(&new).unwrap();
        let moved = move_root(&home);
        assert!(moved.as_ref().unwrap_err().contains(&format!("loki runs on {}", old.display())));
        assert!(std::fs::symlink_metadata(&old).unwrap().is_dir());
        assert_eq!(root_in_use(&home, &moved), old, "the old folder, as the message says");
        let _ = std::fs::remove_dir_all(&home);
    }
}
