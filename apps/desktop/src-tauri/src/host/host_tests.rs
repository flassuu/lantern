use super::*;
use std::path::Path;
use std::sync::mpsc;

/// Where the bundled server ends up in a development checkout, produced by
/// `scripts/desktop-sidecar.sh`. The tests that spawn a real server skip
/// themselves when it has not been built, rather than failing on a machine that
/// never ran the script.
fn sidecar_path() -> Option<PathBuf> {
    let host = std::env::var("HOST").ok()?;
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("lantern-server-{host}"));
    path.is_file().then_some(path)
}

fn test_settings(data_dir: &Path, binary: &Path) -> HostSettings {
    HostSettings {
        port: 3459,
        data_dir: data_dir.display().to_string(),
        teacher_password: String::new(),
        web_root: String::new(),
        binary_path: binary.display().to_string(),
    }
}

/// Collects what the host would have sent to the window.
fn recording_context() -> (SpawnContext, mpsc::Receiver<LogLine>, mpsc::Receiver<Option<i32>>) {
    let (line_tx, line_rx) = mpsc::channel();
    let (exit_tx, exit_rx) = mpsc::channel();
    let context = SpawnContext {
        lines: Arc::new(move |line| {
            let _ = line_tx.send(line);
        }),
        exit: Arc::new(move |code| {
            let _ = exit_tx.send(code);
        }),
        resource_dir: None,
    };
    (context, line_rx, exit_rx)
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "lantern-host-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

#[test]
fn reads_a_log_line_into_its_parts() {
    let line = to_log_line(
        r#"{"level":30,"time":1791394897973,"msg":"listening on http://0.0.0.0:3459"}"#.to_string(),
    );
    assert_eq!(line.level, "info");
    assert_eq!(line.msg, "listening on http://0.0.0.0:3459");
    assert_eq!(line.at_ms, 1791394897973);
    assert!(line.raw.starts_with('{'));
}

#[test]
fn maps_every_level_the_server_can_write() {
    for (number, expected) in [
        (10, "debug"),
        (20, "debug"),
        (30, "info"),
        (40, "warn"),
        (50, "error"),
        (60, "fatal"),
    ] {
        let raw = format!(r#"{{"level":{number},"time":1,"msg":"x"}}"#);
        assert_eq!(to_log_line(raw).level, expected, "level {number}");
    }
}

#[test]
fn keeps_a_crash_visible_instead_of_dropping_it() {
    // Not JSON: a panic, or a runtime warning. It has to reach the window, and
    // as an error - a crash that leaves no trace is the one failure this is for.
    let line = to_log_line("thread 'main' panicked at src/lib.rs:42".to_string());
    assert_eq!(line.level, "error");
    assert!(line.msg.contains("panicked"));
    assert!(line.at_ms > 0);
}

#[test]
fn looks_for_the_binary_in_a_sensible_order() {
    let settings = HostSettings::with_defaults("/tmp/data".to_string());
    let resources = PathBuf::from("/opt/app/resources");
    let found = candidates(Some(&resources), &settings);
    assert_eq!(found.len(), 2, "next to the executable, then resources");
    assert!(found[0].to_string_lossy().ends_with(binary_name()));
    assert_eq!(found[1], resources.join(binary_name()));
}

#[test]
fn an_explicit_path_comes_first_so_a_dev_build_can_use_its_own_binary() {
    let settings = HostSettings {
        binary_path: "/home/dev/lantern-server".to_string(),
        ..HostSettings::with_defaults("/tmp/data".to_string())
    };
    let found = candidates(None, &settings);
    assert_eq!(found[0], PathBuf::from("/home/dev/lantern-server"));
}

#[test]
fn reports_every_path_it_looked_in_when_there_is_no_binary() {
    let dir = temp_dir("missing");
    let settings = HostSettings {
        binary_path: dir.join("nowhere").display().to_string(),
        ..HostSettings::with_defaults(dir.display().to_string())
    };
    let state = HostState::new(settings.clone());
    let (context, _lines, _exits) = recording_context();

    let status = start(&context, &state);
    assert!(!status.running);
    assert!(status.binary_path.is_none());
    // The message a teacher sees has to name the paths, not just say "missing".
    let error = status.error.expect("an error message");
    assert!(error.contains("not found"));
    assert!(status.searched.iter().any(|path| path.contains("nowhere")));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn starts_a_real_server_and_stops_it_again() {
    let Some(binary) = sidecar_path() else {
        eprintln!("skipping: run scripts/desktop-sidecar.sh first");
        return;
    };
    let dir = temp_dir("real");
    let state = HostState::new(test_settings(&dir, &binary));
    let (context, lines, _exits) = recording_context();

    let status = start(&context, &state);
    assert!(status.running, "server should be up: {:?}", status.error);
    assert!(status.pid.is_some());
    assert_eq!(status.port, 3459);
    assert_eq!(status.error, None);

    // The banner is what the window shows, and it has to arrive through the pipe
    // rather than being invented here. Which line comes first is the server's
    // business - on a fresh data folder it warns about the seeded admin - so the
    // test waits for the one it cares about.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let mut banner = None;
    while std::time::Instant::now() < deadline {
        let Ok(line) = lines.recv_timeout(deadline - std::time::Instant::now()) else {
            break;
        };
        if line.msg.contains("listening") {
            banner = Some(line);
            break;
        }
    }
    assert!(
        banner.is_some(),
        "the server never reported that it was listening"
    );

    let stopped = stop(&state);
    assert!(!stopped.running);
    assert!(stopped.pid.is_none());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn sees_a_server_it_did_not_start_and_can_stop_it() {
    let Some(binary) = sidecar_path() else {
        eprintln!("skipping: run scripts/desktop-sidecar.sh first");
        return;
    };
    let dir = temp_dir("adopt");
    let settings = test_settings(&dir, &binary);

    // Start it the way this app does, so there is genuinely a process on the port.
    let owner = HostState::new(settings.clone());
    let (context, _lines, _exits) = recording_context();
    let started = start(&context, &owner);
    assert!(started.running, "server should be up: {:?}", started.error);
    assert!(started.managed, "a server this app started is one it owns");

    // Now look at the same port the way a freshly opened window would.
    let found = probe::probe_external(settings.port)
        .expect("the server answers a health check on its port");
    assert_eq!(found.port, settings.port);
    assert!(found.version.is_some(), "the health answer carries a version");
    let pid = found.pid.expect("something holding a port has a pid");
    assert_ne!(pid, started.pid.unwrap(), "the lookup finds the real listener");

    // Adopted, not owned: the app reports the run and stops pretending it is
    // the one that started it.
    let fresh = HostState::new(settings.clone());
    let adopted = adopt(&fresh, &found);
    assert!(adopted.running);
    assert!(!adopted.managed);
    assert_eq!(adopted.external_pid, Some(pid));
    assert_eq!(adopted.started_at, None, "an adopted run has no start mark to show");

    // And stopping the adopted one ends the process that holds the port.
    let stopped = stop(&fresh);
    assert!(!stopped.running);
    assert!(stopped.external_pid.is_none());

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while std::time::Instant::now() < deadline && probe::probe_external(settings.port).is_some() {
        thread::sleep(std::time::Duration::from_millis(200));
    }
    assert!(
        probe::probe_external(settings.port).is_none(),
        "the adopted server is still answering after being stopped"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn surfaces_the_exit_code_of_a_server_that_stops_by_itself() {
    let dir = temp_dir("exit");
    // A stand-in that fails immediately, the way a taken port or a crash does.
    let script = dir.join("fake-server");
    std::fs::write(
        &script,
        "#!/bin/sh\necho '{\"level\":50,\"time\":1,\"msg\":\"address in use\"}'\necho boom >&2\nexit 7\n",
    )
    .expect("write the stand-in");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).ok();
    }

    let state = HostState::new(test_settings(&dir, &script));
    let (context, lines, exits) = recording_context();
    let status = start(&context, &state);
    assert!(status.running);

    let stderr_line = lines
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("the error line");
    assert_eq!(stderr_line.level, "error");

    let code = exits
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("the exit event");
    assert_eq!(code, Some(7));

    // The status reflects it too, so a window opened later is not lying.
    let after = state.status.lock().unwrap().clone();
    assert!(!after.running);
    assert_eq!(after.exit_code, Some(7));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn refuses_settings_that_would_break_the_server_quietly() {
    let dir = temp_dir("settings");
    let fallback = HostSettings::with_defaults(dir.display().to_string());

    // A corrupted file must not stop the app from starting at all.
    let settings = parse_settings("not json at all", fallback.clone());
    assert_eq!(settings.port, DEFAULT_PORT);
    assert_eq!(settings.data_dir, fallback.data_dir);

    // A port of 0 would ask the OS for a random one, which the app could not
    // then talk to; a blank data folder is not a folder.
    let settings = parse_settings(
        r#"{"port":0,"dataDir":"","teacherPassword":"","webRoot":"","binaryPath":""}"#,
        fallback.clone(),
    );
    assert_eq!(settings.port, DEFAULT_PORT);
    assert_eq!(settings.data_dir, fallback.data_dir);

    // A good file is taken as written.
    let settings = parse_settings(
        r#"{"port":4200,"dataDir":"/var/lib/lantern","teacherPassword":"x","webRoot":"/srv","binaryPath":""}"#,
        fallback.clone(),
    );
    assert_eq!(settings.port, 4200);
    assert_eq!(settings.data_dir, "/var/lib/lantern");
    assert_eq!(settings.web_root, "/srv");
    std::fs::remove_dir_all(&dir).ok();
}
