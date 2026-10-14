//! The server, running inside the desktop app.
//!
//! The desktop app is the scenario where nobody else is at the keyboard: the
//! teacher double-clicks an icon, and something has to be listening on the LAN
//! for the students' phones. So the app owns the server process: it spawns the
//! bundled binary, keeps its settings, and pipes its output to the window.
//!
//! Nothing here needs a dependency. `std::process` spawns, two threads read the
//! pipes, and `tauri::Emitter` carries each line to the webview.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};

pub mod probe;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// What the server binds by default; the same port the docs and the runbook use.
pub const DEFAULT_PORT: u16 = 3300;

/// The file name of the bundled server, inside the bundle and next to the app.
fn binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "lantern-server.exe"
    } else {
        "lantern-server"
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSettings {
    /// Port the server listens on. The app's API base follows it, so changing it
    /// here is all it takes to move the whole app to another port.
    pub port: u16,
    /// Where the database and uploads live. A relative path is resolved against
    /// the working directory, which for a double-clicked app is nowhere useful —
    /// the default is an absolute path inside the app's data directory.
    pub data_dir: String,
    /// Seeded as the first teacher when the server starts. It only seeds a
    /// data directory with no teacher yet; to change an existing one, the app
    /// calls `POST /api/auth/password`. An admin is created later from the
    /// server console, if an institution needs one.
    /// Seeded as the *first teacher* account, not an admin: one person with a
    /// laptop runs a class. Sent as TEACHER_PASSWORD.
    pub teacher_password: String,
    /// Optional `--webroot`: the built student client, so phones on the LAN have
    /// something to open. Empty means "serve the API only".
    pub web_root: String,
    /// Explicit path to the server binary. Empty means "look for the sidecar".
    pub binary_path: String,
}

impl HostSettings {
    pub fn with_defaults(data_dir: String) -> Self {
        Self {
            port: DEFAULT_PORT,
            data_dir,
            teacher_password: String::new(),
            web_root: String::new(),
            binary_path: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub port: u16,
    /// Epoch millis of the last successful start, for the uptime readout.
    pub started_at: Option<i64>,
    /// Filled in on every read, so the window does not have to do the arithmetic.
    pub uptime_ms: Option<i64>,
    pub exit_code: Option<i32>,
    /// The binary that was used, or the first candidate when none was found.
    pub binary_path: Option<String>,
    /// Every path that was looked for, so a dev build can say what was missing
    /// instead of only that something is.
    pub searched: Vec<String>,
    /// Set when the last start or stop failed.
    pub error: Option<String>,
    /// Whether this app started the process. False on a server that was already
    /// listening when the window opened - adopted rather than owned, which is the
    /// difference between "stop" meaning kill our child and meaning kill a pid
    /// somebody else owns.
    pub managed: bool,
    /// The pid of an adopted server. Set only while `running` and `!managed`.
    pub external_pid: Option<u32>,
}

/// A server already listening that this app did not start.
///
/// The app adopts one instead of pretending the port is free: a teacher who ran
/// the server by hand, or who has it on autostart, would otherwise be told to
/// press Start and watch the port conflict.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalServer {
    pub port: u16,
    /// Whoever is holding the port, when the platform can be asked.
    pub pid: Option<u32>,
    /// What `/api/health` answers, so the window can say which build is running.
    pub version: Option<String>,
}

/// One line of the server's output, already split into what the console needs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    /// The line as the server wrote it.
    pub raw: String,
    pub level: String,
    pub msg: String,
    /// Epoch millis; the webview formats it, so no date library is needed here.
    pub at_ms: i64,
}

/// Where a started server's output goes. The window supplies closures that emit
/// Tauri events; a test supplies ones that push into a vector. Everything below
/// this line is therefore testable without a running application.
pub type LineSink = Arc<dyn Fn(LogLine) + Send + Sync>;
pub type ExitSink = Arc<dyn Fn(Option<i32>) + Send + Sync>;

#[derive(Clone)]
pub struct SpawnContext {
    pub lines: LineSink,
    pub exit: ExitSink,
    /// Where a bundled app keeps its resources; None in a development build.
    pub resource_dir: Option<PathBuf>,
}

pub struct HostState {
    pub settings: Mutex<HostSettings>,
    /// Shared with the thread that watches for an exit, so the process and the
    /// window can both reach it without the window owning it.
    child: Arc<Mutex<Option<Child>>>,
    pub status: Arc<Mutex<ServerStatus>>,
}

impl HostState {
    pub fn new(settings: HostSettings) -> Self {
        let port = settings.port;
        Self {
            settings: Mutex::new(settings),
            child: Arc::new(Mutex::new(None)),
            status: Arc::new(Mutex::new(ServerStatus {
                port,
                ..ServerStatus::default()
            })),
        }
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// pino's numeric level, mapped to the names the clients already use.
fn level_from_record(record: &serde_json::Value) -> &'static str {
    match record.get("level").and_then(|value| value.as_i64()) {
        Some(10) | Some(20) => "debug",
        Some(40) => "warn",
        Some(50) => "error",
        Some(60) => "fatal",
        _ => "info",
    }
}

/// Turns one stdout line into a log line.
///
/// The server writes JSON into a pipe, so this is a real parse on every line.
/// Anything that is not JSON - a panic, a warning from the runtime - is passed
/// through as an error line rather than dropped: a crash that leaves no trace is
/// the one failure this window exists to make visible.
fn to_log_line(raw: String) -> LogLine {
    match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(record) => LogLine {
            msg: record
                .get("msg")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string(),
            level: level_from_record(&record).to_string(),
            at_ms: record
                .get("time")
                .and_then(|value| value.as_i64())
                .unwrap_or_else(now_ms),
            raw,
        },
        Err(_) => LogLine {
            level: "error".to_string(),
            msg: raw.clone(),
            at_ms: now_ms(),
            raw,
        },
    }
}

fn read_stream<R: std::io::Read + Send + 'static>(
    stream: R,
    sink: LineSink,
    force_level: Option<&'static str>,
) {
    thread::spawn(move || {
        for line in BufReader::new(stream).lines() {
            let Ok(raw) = line else { break };
            if raw.trim().is_empty() {
                continue;
            }
            let mut entry = to_log_line(raw);
            if let Some(level) = force_level {
                entry.level = level.to_string();
            }
            sink(entry);
        }
    });
}

/// Where the server binary may be, in the order worth trying.
///
/// A bundled app has it next to the executable (and, on macOS, inside the
/// resource directory). A development build has neither, which is why the second
/// candidate exists at all: a teacher running `pnpm dev:desktop` should be able
/// to point at a server they built themselves instead of being told it is
/// missing and nothing else.
pub fn candidates(resource_dir: Option<&PathBuf>, settings: &HostSettings) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if !settings.binary_path.trim().is_empty() {
        paths.push(PathBuf::from(settings.binary_path.trim()));
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(dir) = executable.parent() {
            paths.push(dir.join(binary_name()));
        }
    }
    if let Some(resources) = resource_dir {
        paths.push(resources.join(binary_name()));
    }
    if let Ok(from_env) = std::env::var("LANTERN_SERVER_BIN") {
        paths.push(PathBuf::from(from_env));
    }
    paths
}

fn status_of(state: &HostState) -> ServerStatus {
    let mut status = state.status.lock().unwrap().clone();
    if status.running {
        if let Some(started) = status.started_at {
            status.uptime_ms = Some(now_ms() - started);
        }
    }
    status
}

fn fail(state: &HostState, error: String) -> ServerStatus {
    let mut status = state.status.lock().unwrap();
    status.running = false;
    status.pid = None;
    status.error = Some(error);
    status.clone()
}

pub fn start(context: &SpawnContext, state: &HostState) -> ServerStatus {
    let settings = state.settings.lock().unwrap().clone();
    let paths = candidates(context.resource_dir.as_ref(), &settings);
    let searched: Vec<String> = paths.iter().map(|path| path.display().to_string()).collect();

    let binary = paths.into_iter().find(|path| path.is_file());
    let Some(binary) = binary else {
        let mut status = state.status.lock().unwrap();
        status.running = false;
        status.searched = searched;
        status.binary_path = None;
        status.error = Some(format!(
            "The server binary was not found. Looked in: {}",
            status.searched.join(", ")
        ));
        return status.clone();
    };

    let mut command = Command::new(&binary);
    command
        .arg("--port")
        .arg(settings.port.to_string())
        .arg("--data")
        .arg(&settings.data_dir)
        // The window is the console here: a second one would fight with the app
        // for the keyboard.
        .arg("--no-console")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if !settings.web_root.trim().is_empty() {
        command.arg("--webroot").arg(settings.web_root.trim());
    }
    if !settings.teacher_password.is_empty() {
        command.env("TEACHER_PASSWORD", settings.teacher_password.trim());
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return fail(
                state,
                format!("Could not start {}: {}", binary.display(), error),
            )
        }
    };

    let pid = child.id();
    if let Some(stdout) = child.stdout.take() {
        read_stream(stdout, Arc::clone(&context.lines), None);
    }
    if let Some(stderr) = child.stderr.take() {
        // Whatever the server writes to stderr is a failure of some kind, and
        // this window is where a teacher would look for it.
        read_stream(stderr, Arc::clone(&context.lines), Some("error"));
    }

    {
        let mut status = state.status.lock().unwrap();
        status.running = true;
        status.pid = Some(pid);
        status.port = settings.port;
        status.started_at = Some(now_ms());
        status.exit_code = None;
        status.error = None;
        status.managed = true;
        status.external_pid = None;
        status.binary_path = Some(binary.display().to_string());
        status.searched = searched;
    }
    *state.child.lock().unwrap() = Some(child);

    // Watches for an exit nobody asked for: a crash, a port already taken, a
    // panic. The exit code is the only clue a teacher would otherwise have.
    let child = Arc::clone(&state.child);
    let status = Arc::clone(&state.status);
    let report_exit = Arc::clone(&context.exit);
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(400));
        // Two values, not a nested Option: "exited with no code" (a signal) and
        // "still running" must not look alike.
        let (exited, code) = {
            let mut guard = child.lock().unwrap();
            let Some(process) = guard.as_mut() else { return };
            match process.try_wait() {
                Ok(Some(done)) => (true, done.code()),
                Ok(None) => (false, None),
                Err(_) => return,
            }
        };
        if exited {
            {
                let mut guard = child.lock().unwrap();
                *guard = None;
            }
            {
                let mut status = status.lock().unwrap();
                status.running = false;
                status.pid = None;
                status.exit_code = code;
            }
            report_exit(code);
            return;
        }
    });

    status_of(state)
}

pub fn stop(state: &HostState) -> ServerStatus {
    let child = state.child.lock().unwrap().take();
    if let Some(mut child) = child {
        // Kill, then reap: without the wait the process stays a zombie and the
        // port can linger in TIME_WAIT on some systems.
        let _ = child.kill();
        let _ = child.wait();
    }
    let mut status = state.status.lock().unwrap();
    // A run this app adopted is not a child, so there is nothing to kill here -
    // its pid was taken by a listener lookup and stopping it is `stop_foreign`.
    if !status.managed {
        if let Some(pid) = status.external_pid {
            if let Err(error) = probe::kill_pid(pid) {
                status.error = Some(error);
            }
        }
    }
    status.running = false;
    status.pid = None;
    status.managed = false;
    status.external_pid = None;
    status.error = None;
    status.clone()
}

pub fn restart(context: &SpawnContext, state: &HostState) -> ServerStatus {
    stop(state);
    // The port has to be free before the new process asks for it.
    thread::sleep(Duration::from_millis(200));
    start(context, state)
}

/**
 * Takes over a server that was already listening.
 *
 * The window calls this before offering to start anything: a machine where the
 * server is on autostart, or where a teacher ran it from a terminal, is an
 * ordinary way to find this app and an extraordinary way to lose a class. What
 * changes is only ownership - the port is in use, so the app reports the run it
 * found and keeps its hands off the process until the teacher says otherwise.
 */
pub fn adopt(state: &HostState, external: &ExternalServer) -> ServerStatus {
    let mut status = state.status.lock().unwrap();
    status.running = true;
    status.managed = false;
    status.port = external.port;
    status.pid = external.pid;
    status.external_pid = external.pid;
    // The app did not start it, so it cannot say when it did; the uptime readout
    // stays empty rather than inventing a number.
    status.started_at = None;
    status.uptime_ms = None;
    status.exit_code = None;
    status.error = None;
    status.clone()
}

/// Called when the window closes: a server left running would keep the port bound
/// and the teacher would find a port conflict on the next launch with no idea
/// why.
pub fn shutdown(state: &HostState) {
    stop(state);
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("settings.json"))
}

/// Parses a settings file, falling back for anything unusable.
///
/// Pure, so the rules are testable on their own: a hand-edited file with a zero
/// port would ask the OS for a random one, which the app could not then talk to,
/// and a corrupted file must not stop the app from starting at all.
pub fn parse_settings(raw: &str, fallback: HostSettings) -> HostSettings {
    let Ok(mut settings) = serde_json::from_str::<HostSettings>(raw) else {
        return fallback;
    };
    if settings.port == 0 {
        settings.port = fallback.port;
    }
    if settings.data_dir.trim().is_empty() {
        settings.data_dir = fallback.data_dir;
    }
    settings
}

pub fn load_settings(app: &AppHandle, data_dir: String) -> HostSettings {
    let fallback = HostSettings::with_defaults(data_dir);
    let Some(path) = settings_path(app) else {
        return fallback;
    };
    match std::fs::read_to_string(&path) {
        Ok(raw) => parse_settings(&raw, fallback),
        Err(_) => fallback,
    }
}

#[cfg(test)]
mod host_tests;

pub fn save_settings(app: &AppHandle, settings: HostSettings) -> Result<HostSettings, String> {
    let path = settings_path(app).ok_or_else(|| "no config directory".to_string())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }
    let json = serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?;
    std::fs::write(&path, json).map_err(|error| error.to_string())?;
    Ok(settings)
}