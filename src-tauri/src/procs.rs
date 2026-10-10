//! The process list, for the one thing the shell needs from it: loki's daemon left from an earlier run (loki crashed
//! or was force-quit), found by its command line and stopped by pid and start time before a new one starts.

/// One process as sysinfo sees it: its pid, its name (`node`, `loki.exe`), its arguments and when it started
/// (seconds since the epoch), so a pid found now is known to be the same process when it is stopped later.
#[derive(Clone, Debug, Default)]
pub struct Proc {
    pub pid: u32,
    pub name: String,
    pub cmd: Vec<String>,
    pub started: u64,
    /// The process that started it, when it is still known.
    pub parent: Option<u32>,
}

/// The machine's processes at one moment.
#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub procs: Vec<Proc>,
}

/// loki's own daemon left from an earlier run: its pid and when it started.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Leftover {
    pub pid: u32,
    pub started: u64,
}

/// The arguments of a command line, however the process list gave it: already split (sysinfo), or one Windows
/// string with quoted paths. Quotes around an argument are dropped.
pub fn command_words(cmd: &[String]) -> Vec<String> {
    let words = match cmd {
        [one] if one.contains(char::is_whitespace) => split_windows(one),
        _ => cmd.to_vec(),
    };
    words.into_iter().map(|w| unquote(&w).to_string()).filter(|w| !w.is_empty()).collect()
}

fn unquote(w: &str) -> &str {
    w.strip_prefix('"').and_then(|x| x.strip_suffix('"')).unwrap_or(w)
}

/// A Windows command line split the way programs read it (CommandLineToArgvW): whitespace outside quotes ends an
/// argument; 2n backslashes before a quote are n and the quote toggles, 2n+1 are n and a literal quote; other
/// backslashes are themselves — so a quoted `C:\Program Files\…` stays whole.
fn split_windows(line: &str) -> Vec<String> {
    let (mut out, mut cur, mut quoted, mut any) = (vec![], String::new(), false, false);
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' {
            let n = chars[i..].iter().take_while(|&&x| x == '\\').count();
            if chars.get(i + n) == Some(&'"') {
                cur.extend(std::iter::repeat_n('\\', n / 2));
                if n % 2 == 1 {
                    cur.push('"');
                    i += n + 1;
                } else {
                    i += n;
                }
            } else {
                cur.extend(std::iter::repeat_n('\\', n));
                i += n;
            }
            any = true;
            continue;
        }
        if c == '"' {
            quoted = !quoted;
            any = true;
        } else if c.is_whitespace() && !quoted {
            if any { out.push(std::mem::take(&mut cur)); }
            any = false;
        } else {
            cur.push(c);
            any = true;
        }
        i += 1;
    }
    if any { out.push(cur); }
    out
}

/// Whether a command line is loki's daemon for this token file (harness::daemon_command): `--loki-daemon` with
/// `--token-file <token_file>`.
pub fn is_own_daemon(words: &[String], token_file: &std::path::Path) -> bool {
    let after = |flag: &str| words.iter().position(|w| w == flag).and_then(|i| words.get(i + 1));
    words.iter().any(|w| w == "--loki-daemon") && after("--token-file").is_some_and(|f| same_path(f, &token_file.to_string_lossy()))
}

/// loki's daemon left from an earlier run: its loki is gone (a running loki's daemon is that loki's, and is never
/// stopped). The daemon's own lock keeps a second one from serving; this lets a new loki replace an orphan.
pub fn daemon_leftover(snap: &Snapshot, token_file: &std::path::Path) -> Option<Leftover> {
    snap.procs.iter().find(|p| is_own_daemon(&command_words(&p.cmd), token_file) && !has_live_loki_parent(snap, p)).map(|p| Leftover { pid: p.pid, started: p.started })
}

/// Windows paths match whatever their slashes and case; other systems compare them as written.
fn same_path(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        let norm = |p: &str| p.replace('/', "\\").to_lowercase();
        norm(a) == norm(b)
    } else {
        a == b
    }
}

/// Whether a loki that is still running started this process: then it is that loki's live daemon (a dev build
/// beside the installed app, say), not a leftover, and must never be stopped. A leftover's loki is gone: its
/// parent is launchd, init or a subreaper, or on Windows a pid no process has any more.
fn has_live_loki_parent(snap: &Snapshot, p: &Proc) -> bool {
    let Some(parent) = p.parent else { return false };
    snap.procs.iter().any(|q| q.pid == parent && is_loki_shell(&q.name))
}

/// loki's own binary, as the process list names it: `loki` on the Mac and Linux, `loki.exe` on Windows.
fn is_loki_shell(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n == "loki" || n == "loki.exe"
}

/// The process source (sysinfo), the same on every system.
pub mod os {
    use super::{Proc, Snapshot};
    use sysinfo::{Pid, ProcessRefreshKind, ProcessStatus, ProcessesToUpdate, System, UpdateKind};

    /// Every process with its command line.
    pub fn snapshot() -> Snapshot {
        let mut sys = System::new();
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always));
        let procs = sys
            .processes()
            .iter()
            .map(|(pid, p)| Proc { pid: pid.as_u32(), name: p.name().to_string_lossy().into_owned(), cmd: p.cmd().iter().map(|a| a.to_string_lossy().into_owned()).collect(), started: p.start_time(), parent: p.parent().map(|pp| pp.as_u32()) })
            .collect();
        Snapshot { procs }
    }

    /// When `pid` started (seconds since the epoch), to know it is still the same process later. None once it
    /// has exited, a zombie included.
    pub fn start_time(pid: u32) -> Option<u64> {
        let mut sys = System::new();
        let pid = Pid::from_u32(pid);
        sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[pid]), true, ProcessRefreshKind::nothing());
        sys.process(pid).filter(|p| !matches!(p.status(), ProcessStatus::Zombie | ProcessStatus::Dead)).map(|p| p.start_time())
    }

    /// Kill `pid` if it is still the process that started at `started`, and wait (up to 3 s) for it to go, so the
    /// daemon started next finds its folder's lock free. False when it was already gone or is another process now.
    pub fn kill(pid: u32, started: Option<u64>) -> bool {
        let Some(at) = started else { return false };
        if start_time(pid) != Some(at) { return false; }
        let mut sys = System::new();
        let p = Pid::from_u32(pid);
        sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[p]), true, ProcessRefreshKind::nothing());
        if !sys.process(p).is_some_and(|proc| proc.kill()) { return false; }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while start_time(pid) == Some(at) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn a_daemon_whose_loki_is_gone_is_a_leftover_and_one_whose_loki_runs_is_not() {
        let tf = std::path::PathBuf::from("/home/x/.loki/token");
        let daemon = |pid, parent| Proc { pid, name: "node".into(), cmd: s(&["node", "/data/daemon/daemon.mjs", "--loki-daemon", "--dir", "/home/x/.loki", "--mod", "/data/mod/loki-mod.mjs", "--token-file", "/home/x/.loki/token"]), started: 99, parent };
        let shell = Proc { pid: 5, name: "loki".into(), cmd: vec![], started: 1, parent: Some(1) };
        let orphan = Snapshot { procs: vec![daemon(40, Some(1))] };
        assert_eq!(daemon_leftover(&orphan, &tf), Some(Leftover { pid: 40, started: 99 }));
        let owned = Snapshot { procs: vec![daemon(40, Some(5)), shell] };
        assert_eq!(daemon_leftover(&owned, &tf), None, "a running loki's daemon");
        assert_eq!(daemon_leftover(&orphan, std::path::Path::new("/elsewhere/token")), None, "another folder's daemon");
        let not_daemon = Snapshot { procs: vec![Proc { pid: 41, name: "node".into(), cmd: s(&["node", "x.mjs", "--token-file", "/home/x/.loki/token"]), started: 1, parent: None }] };
        assert_eq!(daemon_leftover(&not_daemon, &tf), None, "no --loki-daemon marker");
        // Its loki gone: reparented to launchd or init, a subreaper, or (Windows) a pid no process has.
        for (parent, procs) in [(Some(1), vec![Proc { pid: 1, name: "launchd".into(), cmd: vec![], started: 0, parent: None }]), (Some(900), vec![Proc { pid: 900, name: "systemd".into(), cmd: vec![], started: 0, parent: Some(1) }]), (Some(4321), vec![]), (None, vec![])] {
            let mut all = vec![daemon(40, parent)];
            all.extend(procs);
            assert_eq!(daemon_leftover(&Snapshot { procs: all }, &tf), Some(Leftover { pid: 40, started: 99 }), "{parent:?}");
        }
        for shell in ["loki", "loki.exe", "LOKI.EXE"] {
            let snap = Snapshot { procs: vec![daemon(40, Some(5)), Proc { pid: 5, name: shell.into(), cmd: vec![], started: 1, parent: Some(1) }] };
            assert_eq!(daemon_leftover(&snap, &tf), None, "{shell}");
        }
    }

    #[test]
    fn a_windows_command_line_is_split_the_way_programs_read_it() {
        // sysinfo hands the arguments over already split; quoted paths keep their spaces and backslashes.
        let split = s(&[r"C:\Program Files\nodejs\node.exe", r"C:\Users\someone\.loki\daemon\daemon.mjs", "--loki-daemon"]);
        assert_eq!(command_words(&split), split);
        // …or as one string, the way Windows stores a command line.
        let one = s(&[r#""C:\Program Files\nodejs\node.exe" "C:\Users\some one\.loki\daemon\daemon.mjs" --loki-daemon --token-file "C:\Users\some one\.loki\token""#]);
        let words = command_words(&one);
        assert_eq!(words[0], r"C:\Program Files\nodejs\node.exe");
        assert_eq!(words[1], r"C:\Users\some one\.loki\daemon\daemon.mjs");
        assert_eq!(words.last().unwrap(), r"C:\Users\some one\.loki\token");
        assert!(is_own_daemon(&words, std::path::Path::new(r"C:\Users\some one\.loki\token")));
        // Windows spells paths either way and ignores case.
        assert!(is_own_daemon(&words, std::path::Path::new("c:/users/some one/.loki/token")) == cfg!(windows));
        // A quoted argument that is itself quoted by sysinfo loses its quotes too.
        assert_eq!(command_words(&s(&["node.exe", "\"C:\\x\\token\""])), s(&["node.exe", "C:\\x\\token"]));
        assert_eq!(split_windows(r#"a\\\"b "c\\" d"#), s(&[r#"a\"b"#, r"c\", "d"]));
        assert_eq!(command_words(&[]), Vec::<String>::new());
        assert_eq!(command_words(&s(&[""])), Vec::<String>::new());
    }

    fn sleeper() -> std::process::Child {
        if cfg!(windows) {
            std::process::Command::new("ping").args(["-n", "30", "127.0.0.1"]).stdout(std::process::Stdio::null()).spawn().unwrap()
        } else {
            std::process::Command::new("sleep").arg("30").spawn().unwrap()
        }
    }

    /// The real OS: the reader lists this process with its command line and start time.
    #[test]
    fn the_os_reader_lists_this_process() {
        let me = std::process::id();
        let snap = os::snapshot();
        let mine = snap.procs.iter().find(|p| p.pid == me).expect("this process in the list");
        assert!(!mine.cmd.is_empty(), "its command line: {mine:?}");
        assert!(os::start_time(me).is_some());
        assert_eq!(os::start_time(u32::MAX), None);
    }

    #[test]
    fn kill_stops_the_process_it_was_given_and_only_that_one() {
        let mut child = sleeper();
        let pid = child.id();
        let started = os::start_time(pid);
        assert!(started.is_some());
        assert!(!os::kill(pid, started.map(|t| t + 1000)), "a different start time is a different process: left alone");
        assert!(child.try_wait().unwrap().is_none());
        assert!(os::kill(pid, started));
        assert!(child.wait().is_ok());
        assert!(!os::kill(pid, started), "already gone");
    }
}
