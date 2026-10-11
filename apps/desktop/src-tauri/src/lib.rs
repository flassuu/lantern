mod host;

use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, RunEvent};
use tauri_plugin_opener::init;

use host::{HostSettings, HostState, ServerStatus, SpawnContext};

/// Bridges the host's output to the webview.
///
/// The host itself knows nothing about Tauri: it is handed two closures and a
/// resource directory. That is what lets `host.rs` be tested by spawning a real
/// server, which is the only way to be sure the pipe handling works.
fn spawn_context(app: AppHandle) -> SpawnContext {
    // Taken by value: the closures live in threads, and a borrow of the handle
    // would not outlive this function.
    // Two handles, one per closure: each moves into its own thread.
    let for_lines = app.clone();
    let for_exit = app.clone();
    SpawnContext {
        lines: Arc::new(move |line| {
            let _ = for_lines.emit("server-log", line);
        }),
        exit: Arc::new(move |code| {
            let _ = for_exit.emit("server-exit", code);
        }),
        resource_dir: app.path().resource_dir().ok(),
    }
}

/// Everything the app owns: the settings it starts the server with, and the
/// process it started. One `State`, so a start from the window and a start from a
/// signal cannot end up with two servers.
fn state(app: &AppHandle) -> tauri::State<'_, HostState> {
    app.state::<HostState>()
}

#[tauri::command]
fn host_settings(app: AppHandle) -> HostSettings {
    let data_dir = default_data_dir(&app);
    host::load_settings(&app, data_dir)
}

#[tauri::command]
fn save_host_settings(app: AppHandle, settings: HostSettings) -> Result<HostSettings, String> {
    let cleaned = HostSettings {
        // A port of 0 would ask the OS for a random one, which the app could not
        // then talk to: the port is where the API base points.
        port: if settings.port == 0 {
            host::DEFAULT_PORT
        } else {
            settings.port
        },
        teacher_password: settings.teacher_password.trim().to_string(),
        ..settings
    };
    host::save_settings(&app, cleaned.clone())?;
    *state(&app).settings.lock().unwrap() = cleaned.clone();
    Ok(cleaned)
}

#[tauri::command]
fn server_status(app: AppHandle) -> ServerStatus {
    state(&app).status.lock().unwrap().clone()
}

#[tauri::command]
fn start_server(app: AppHandle) -> ServerStatus {
    host::start(&spawn_context(app.clone()), &state(&app))
}

#[tauri::command]
fn stop_server(app: AppHandle) -> ServerStatus {
    host::stop(&state(&app))
}

#[tauri::command]
fn restart_server(app: AppHandle) -> ServerStatus {
    host::restart(&spawn_context(app.clone()), &state(&app))
}

/// Where the database goes unless the teacher says otherwise.
///
/// An app's data directory, not the working directory: a double-clicked app has
/// no working directory worth the name, and a database that lands next to the
/// binary is one uninstall removes by accident.
fn default_data_dir(app: &AppHandle) -> String {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("data").display().to_string())
        .unwrap_or_else(|_| "data".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(init())
        // The save dialog and the write that follows it. The dialog hands back a
        // path and Tauri adds it to the filesystem scope itself, so a teacher can
        // save a report anywhere they like without a path being allowed up front.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let data_dir = default_data_dir(&handle);
            let settings = host::load_settings(&handle, data_dir);
            let mut status = ServerStatus {
                port: settings.port,
                ..ServerStatus::default()
            };
            status.searched = Vec::new();
            app.manage(HostState::new(settings));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            host_settings,
            save_host_settings,
            server_status,
            start_server,
            stop_server,
            restart_server
        ])
        .build(tauri::generate_context!())
        .expect("error while building the application")
        .run(|app, event| {
            // Closing the window has to take the server with it: a process left
            // behind keeps the port and the next launch fails with no clue why.
            if let RunEvent::Exit = event {
                host::shutdown(&state(app));
            }
        });
}