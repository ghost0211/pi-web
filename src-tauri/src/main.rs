// Pi Web Desktop: a thin Tauri shell around the local pi-web Next.js server.
//
// The web UI is served by a Node.js sidecar (the Next.js standalone build in
// `server/` plus a bundled Node runtime in `node/`). The first launch reserves
// a free loopback port and persists it; later launches reuse that port when it
// is available so WebView2 keeps a stable origin (and therefore localStorage).
// Closing the app kills the whole sidecar process tree because agent sessions
// (and any shells their tools spawned) live in it.
//
// The shell also owns the desktop-only behaviors: a system tray icon and the
// "what does closing the window mean" setting (minimize to tray vs. quit),
// persisted in `<app_config>/desktop-settings.json` and editable both from the
// tray menu and from the web settings UI via IPC commands.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, File};
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::menu::{CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;

/// Matches `npm run dev` (next dev -H 127.0.0.1 -p 30141).
const DEV_SERVER_URL: &str = "http://127.0.0.1:30141/";
const READY_TIMEOUT: Duration = Duration::from_secs(60);
const READY_POLL_INTERVAL: Duration = Duration::from_millis(150);
/// If the app UI never reports a finished page load, reveal the window anyway so
/// a broken navigation shows the bundled loading page instead of nothing.
const UI_SHOW_FALLBACK: Duration = Duration::from_secs(15);

const CLOSE_BEHAVIOR_TRAY: &str = "minimize-to-tray";
const CLOSE_BEHAVIOR_QUIT: &str = "quit";
const TRAY_ID: &str = "main-tray";
const TRAY_ITEM_SHOW: &str = "show";
const TRAY_ITEM_QUIT: &str = "quit";
const TRAY_ITEM_MINIMIZE_ON_CLOSE: &str = "minimize-on-close";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Handle to the sidecar so it can be terminated on exit.
struct DesktopServer {
    child: Option<Child>,
}

/// Close behavior preference. Default: minimize to tray — closing the window
/// must not kill the user's agent sessions unless they opt in.
struct DesktopSettings {
    close_behavior: Mutex<String>,
}

/// Handle to the tray check item so the IPC command can keep it in sync.
struct TrayHandles {
    minimize_on_close: CheckMenuItem<tauri::Wry>,
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("desktop-settings.json"))
}

fn load_settings_object(
    app: &AppHandle,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let path = settings_path(app).ok_or_else(|| "desktop settings path unavailable".to_string())?;
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Default::default()),
        Err(error) => return Err(format!("failed to read desktop settings: {error}")),
    };
    serde_json::from_str::<serde_json::Value>(&text)
        .map_err(|error| format!("invalid desktop settings JSON: {error}"))?
        .as_object()
        .cloned()
        .ok_or_else(|| "desktop settings must be a JSON object".to_string())
}

fn read_settings_object(app: &AppHandle) -> serde_json::Map<String, serde_json::Value> {
    load_settings_object(app).unwrap_or_default()
}

/// Fail closed on corrupt/unreadable settings instead of replacing the file
/// with one field and silently deleting preferences owned by other features.
fn update_setting(app: &AppHandle, key: &str, value: serde_json::Value) {
    let mut settings = match load_settings_object(app) {
        Ok(settings) => settings,
        Err(error) => {
            eprintln!("refusing to overwrite desktop settings: {error}");
            return;
        }
    };
    settings.insert(key.to_string(), value);
    let Some(path) = settings_path(app) else { return };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Err(error) = fs::write(path, serde_json::Value::Object(settings).to_string()) {
        eprintln!("failed to write desktop settings: {error}");
    }
}

fn read_close_behavior(app: &AppHandle) -> String {
    read_settings_object(app)
        .get("closeBehavior")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .filter(|behavior| behavior == CLOSE_BEHAVIOR_TRAY || behavior == CLOSE_BEHAVIOR_QUIT)
        .unwrap_or_else(|| CLOSE_BEHAVIOR_TRAY.to_string())
}

fn persist_close_behavior(app: &AppHandle) {
    let behavior = app
        .state::<DesktopSettings>()
        .close_behavior
        .lock()
        .map(|value| value.clone())
        .unwrap_or_else(|_| CLOSE_BEHAVIOR_TRAY.to_string());
    update_setting(app, "closeBehavior", serde_json::Value::String(behavior));
}

fn read_server_port(app: &AppHandle) -> Option<u16> {
    read_settings_object(app)
        .get("serverPort")
        .and_then(serde_json::Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port != 0)
}

fn persist_server_port(app: &AppHandle, port: u16) {
    update_setting(app, "serverPort", serde_json::Value::from(port));
}

fn current_close_behavior(app: &AppHandle) -> String {
    app.state::<DesktopSettings>()
        .close_behavior
        .lock()
        .map(|value| value.clone())
        .unwrap_or_else(|_| CLOSE_BEHAVIOR_TRAY.to_string())
}

/// Single writer used by the tray menu, the IPC command, and startup: keeps
/// state, the tray check item, and the persisted file in sync.
fn apply_close_behavior(app: &AppHandle, behavior: &str) {
    if behavior != CLOSE_BEHAVIOR_TRAY && behavior != CLOSE_BEHAVIOR_QUIT {
        return;
    }
    if let Ok(mut value) = app.state::<DesktopSettings>().close_behavior.lock() {
        *value = behavior.to_string();
    }
    if let Some(handles) = app.try_state::<TrayHandles>() {
        let _ = handles
            .minimize_on_close
            .set_checked(behavior == CLOSE_BEHAVIOR_TRAY);
    }
    persist_close_behavior(app);
}

#[tauri::command]
fn pick_attachment_paths(app: AppHandle) -> Vec<String> {
    app.dialog()
        .file()
        .blocking_pick_files()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|file| file.into_path().ok())
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

/// Resolve a web-UI-supplied path into a native absolute path that exists.
///
/// The web UI always sends forward slashes, while Explorer and the shell
/// association APIs want the platform separator. Rejecting relative and
/// missing paths keeps the desktop-only open/reveal commands from being used
/// as a blind filesystem probe by a broken or hostile page.
fn native_existing_path(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("no path provided".to_string());
    }
    let candidate = if cfg!(windows) {
        PathBuf::from(trimmed.replace('/', "\\"))
    } else {
        PathBuf::from(trimmed)
    };
    if !candidate.is_absolute() {
        return Err(format!("path must be absolute: {trimmed}"));
    }
    if !candidate.exists() {
        return Err(format!("path does not exist: {}", candidate.display()));
    }
    Ok(candidate)
}

/// Open a workspace file with the OS default application. Desktop only: the
/// web build keeps its download link because the server may run elsewhere.
#[tauri::command]
fn open_local_path(path: String) -> Result<(), String> {
    let target = native_existing_path(&path)?;
    open::that_detached(target.as_os_str())
        .map_err(|error| format!("failed to open {}: {error}", target.display()))
}

/// Ask the OS for an application chooser (Windows: "How do you want to open
/// this file?") instead of the remembered default association.
#[tauri::command]
fn open_local_path_with(path: String) -> Result<(), String> {
    let target = native_existing_path(&path)?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        return Command::new("rundll32.exe")
            .arg("shell32.dll,OpenAs_RunDLL")
            .arg(target.as_os_str())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("failed to open the application chooser: {error}"));
    }
    #[cfg(not(windows))]
    {
        let _ = target;
        Err("choosing an application is only supported on Windows".to_string())
    }
}

/// Show the file in the platform file manager with the item selected.
#[tauri::command]
fn reveal_local_path(path: String) -> Result<(), String> {
    let target = native_existing_path(&path)?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // `/select,<path>` must be one argument; Explorer strips the quotes.
        return Command::new("explorer.exe")
            .arg(format!("/select,{}", target.display()))
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("failed to reveal {}: {error}", target.display()));
    }
    #[cfg(target_os = "macos")]
    {
        return Command::new("open")
            .arg("-R")
            .arg(target.as_os_str())
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("failed to reveal {}: {error}", target.display()));
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        let directory = target.parent().unwrap_or(target.as_path()).to_path_buf();
        Command::new("xdg-open")
            .arg(directory.as_os_str())
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("failed to reveal {}: {error}", directory.display()))
    }
}

#[tauri::command]
fn get_close_behavior(app: AppHandle) -> String {
    current_close_behavior(&app)
}

#[tauri::command]
fn set_close_behavior(app: AppHandle, behavior: String) -> Result<(), String> {
    if behavior != CLOSE_BEHAVIOR_TRAY && behavior != CLOSE_BEHAVIOR_QUIT {
        return Err(format!("unknown close behavior: {behavior}"));
    }
    apply_close_behavior(&app, &behavior);
    Ok(())
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItemBuilder::with_id(TRAY_ITEM_SHOW, "Show Pi Web Desktop").build(app)?;
    let minimize_on_close =
        CheckMenuItemBuilder::with_id(TRAY_ITEM_MINIMIZE_ON_CLOSE, "Minimize to tray on close")
            .checked(current_close_behavior(app) == CLOSE_BEHAVIOR_TRAY)
            .build(app)?;
    let quit = MenuItemBuilder::with_id(TRAY_ITEM_QUIT, "Quit").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&show, &minimize_on_close, &quit])
        .build()?;

    let minimize_item_for_events = minimize_on_close.clone();
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(app.default_window_icon().expect("no window icon").clone())
        .tooltip("Pi Web Desktop")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            TRAY_ITEM_SHOW => show_main_window(app),
            TRAY_ITEM_QUIT => app.exit(0),
            TRAY_ITEM_MINIMIZE_ON_CLOSE => {
                // CheckMenuItem has already toggled itself at this point.
                let checked = minimize_item_for_events.is_checked().unwrap_or(true);
                apply_close_behavior(
                    app,
                    if checked { CLOSE_BEHAVIOR_TRAY } else { CLOSE_BEHAVIOR_QUIT },
                );
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    app.manage(TrayHandles { minimize_on_close });
    Ok(())
}

/// Closing the window hides it instead of exiting when the user prefers the
/// tray; "Quit" from the tray menu calls `app.exit(0)` which never reaches
/// this handler, so it always performs a real exit.
fn install_close_handler(window: &WebviewWindow) {
    let window_ref = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            let app = window_ref.app_handle();
            if current_close_behavior(&app) == CLOSE_BEHAVIOR_TRAY {
                api.prevent_close();
                let _ = window_ref.hide();
            }
        }
    });
}

fn free_loopback_port() -> u16 {
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr().map(|addr| addr.port()))
        .expect("failed to reserve an ephemeral loopback port")
}

fn loopback_port_available(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

struct ServerPortSelection {
    port: u16,
    /// The first successful launch establishes the canonical WebView origin.
    /// A one-off fallback caused by a temporary collision must not replace it.
    persist_on_ready: bool,
}

/// Reusing the same loopback port keeps the desktop WebView on a stable origin,
/// so browser-local preferences (including hidden projects/sessions) survive
/// app restarts. If the saved port is temporarily occupied, use an unpersisted
/// fallback for this launch and retry the canonical port next time.
fn desktop_server_port(app: &AppHandle) -> ServerPortSelection {
    match read_server_port(app) {
        Some(port) if loopback_port_available(port) => ServerPortSelection {
            port,
            persist_on_ready: false,
        },
        Some(_) => ServerPortSelection {
            port: free_loopback_port(),
            persist_on_ready: false,
        },
        None => ServerPortSelection {
            port: free_loopback_port(),
            persist_on_ready: true,
        },
    }
}

fn new_health_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{}-{nanos}", std::process::id())
}

/// Only the bundled sidecar knows this per-launch nonce. Checking it prevents a
/// loopback bind race from navigating WebView2 to an unrelated local service.
fn http_ready(port: u16, health_token: &str) -> bool {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    if stream
        .write_all(b"GET /api/desktop-health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = Vec::with_capacity(1024);
    let _ = stream.take(4096).read_to_end(&mut response);
    String::from_utf8_lossy(&response).contains(health_token)
}

/// `<install>/node`, containing the bundled Node.js runtime.
fn node_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .resource_dir()
        .expect("failed to resolve the resource directory")
        .join("node")
}

/// `<install>/server`, containing the Next.js standalone build.
fn server_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .resource_dir()
        .expect("failed to resolve the resource directory")
        .join("server")
}

/// Prepend the bundled Node runtime to PATH so server features that shell out
/// to npm/npx (skill install, plugin management) work on machines without a
/// system-wide Node.js install.
fn path_with_bundled_node(node_dir: &std::path::Path) -> Option<std::ffi::OsString> {
    let existing = std::env::var_os("PATH");
    let mut paths = vec![node_dir.to_path_buf()];
    if let Some(existing) = &existing {
        paths.extend(std::env::split_paths(existing));
    }
    std::env::join_paths(paths).ok().or(existing)
}

fn spawn_server(app: &AppHandle) -> std::io::Result<(Child, ServerPortSelection, String)> {
    let node_dir = node_dir(app);
    let server_dir = server_dir(app);
    let node_bin = node_dir.join(if cfg!(windows) { "node.exe" } else { "node" });
    let port_selection = desktop_server_port(app);
    let port = port_selection.port;
    let health_token = new_health_token();

    // Persist server logs so startup failures on user machines are debuggable.
    let log_dir = app.path().app_log_dir().unwrap_or_else(|_| server_dir.clone());
    let _ = fs::create_dir_all(&log_dir);
    let (stdout, stderr) = match File::create(log_dir.join("pi-web-server.log")) {
        Ok(file) => match file.try_clone() {
            Ok(clone) => (Stdio::from(file), Stdio::from(clone)),
            Err(_) => (Stdio::from(file), Stdio::null()),
        },
        Err(_) => (Stdio::null(), Stdio::null()),
    };

    let mut command = Command::new(node_bin);
    command
        .arg("server.js")
        .current_dir(&server_dir)
        .env("HOSTNAME", "127.0.0.1")
        .env("PORT", port.to_string())
        // Marker for future desktop-only server behavior.
        .env("PI_WEB_DESKTOP", "1")
        .env("PI_WEB_DESKTOP_HEALTH_TOKEN", &health_token)
        // Desktop updates ship through the installer, not the npm self-check.
        .env("PI_WEB_SKIP_VERSION_CHECK", "1")
        .stdout(stdout)
        .stderr(stderr);
    if let Some(path) = path_with_bundled_node(&node_dir) {
        command.env("PATH", path);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command
        .spawn()
        .map(|child| (child, port_selection, health_token))
}

fn kill_server(app: &AppHandle) {
    let Some(mut child) = app
        .state::<Mutex<DesktopServer>>()
        .lock()
        .ok()
        .and_then(|mut server| server.child.take())
    else {
        return;
    };
    if cfg!(windows) {
        // /T kills the whole tree: agent tools may have spawned shells.
        let mut command = Command::new("taskkill");
        command.args(["/PID", child.id().to_string().as_str(), "/T", "/F"]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let _ = command.stdout(Stdio::null()).stderr(Stdio::null()).status();
    } else {
        let _ = child.kill();
    }
    let _ = child.wait();
}

fn normalize_host(host: Option<&str>) -> String {
    host.unwrap_or_default()
        .trim_matches(|c| c == '[' || c == ']')
        .to_ascii_lowercase()
}

/// Hosts that belong to this machine: the loopback sidecar and Tauri's bundled
/// custom-protocol origin (`tauri.localhost`; RFC 6761 reserves the whole
/// `.localhost` TLD for loopback).
fn is_local_host(host: Option<&str>) -> bool {
    let host = normalize_host(host);
    host == "localhost" || host.ends_with(".localhost") || host == "127.0.0.1" || host == "::1"
}

/// The sidecar origin specifically. The bundled loading page lives on
/// `tauri.localhost`, so it must never reveal the window.
fn is_loopback_browser_url(url: &Url) -> bool {
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    let host = normalize_host(url.host_str());
    host == "localhost" || host == "127.0.0.1" || host == "::1"
}

/// Only real web pages are handed to the system browser. Treating the app's own
/// origin as external pushes `http://tauri.localhost/` into the user's browser
/// and cancels the bundled page it belongs to.
fn is_external_browser_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https") && !is_local_host(url.host_str())
}

fn open_in_system_browser(url: &Url) {
    if let Err(error) = open::that_detached(url.as_str()) {
        eprintln!("failed to open external URL in the system browser: {error}");
    }
}

fn build_main_window(app: &AppHandle, url: WebviewUrl, visible: bool) -> WebviewWindow {
    WebviewWindowBuilder::new(app, "main", url)
        .title("Pi Web Desktop")
        .inner_size(1440.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .visible(visible)
        // The window starts hidden on the bundled loading page; reveal it once
        // the real UI has loaded, so that page is never what the user sees when
        // launching the app.
        .on_page_load(|window, payload| {
            if payload.event() == PageLoadEvent::Finished && is_loopback_browser_url(payload.url())
            {
                let _ = window.show();
                let _ = window.set_focus();
            }
        })
        .on_navigation(|url| {
            if is_external_browser_url(url) {
                open_in_system_browser(url);
                return false;
            }
            true
        })
        .on_new_window(|url, _features| {
            if matches!(url.scheme(), "http" | "https") {
                open_in_system_browser(&url);
            }
            NewWindowResponse::Deny
        })
        .build()
        .expect("failed to create the main window")
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second launch acts as "restore from tray": focus the window.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(Mutex::new(DesktopServer { child: None }))
        .invoke_handler(tauri::generate_handler![
            get_close_behavior,
            set_close_behavior,
            pick_attachment_paths,
            open_local_path,
            open_local_path_with,
            reveal_local_path,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            handle.manage(DesktopSettings {
                close_behavior: Mutex::new(read_close_behavior(&handle)),
            });
            if let Err(error) = setup_tray(&handle) {
                eprintln!("failed to set up the system tray: {error}");
            }
            // Runtime branch (instead of #[cfg]) so both paths typecheck under
            // a single `cargo check`.
            if cfg!(debug_assertions) {
                // `tauri dev`: attach to the separately-started Next.js dev
                // server (see desktop/README.md); no sidecar is spawned.
                let url = Url::parse(DEV_SERVER_URL).expect("invalid dev server URL");
                let window = build_main_window(&handle, WebviewUrl::External(url), true);
                install_close_handler(&window);
            } else {
                // Show a local loading page while the sidecar boots.
                let window = build_main_window(&handle, WebviewUrl::App("index.html".into()), false);
                install_close_handler(&window);
                match spawn_server(&handle) {
                    Ok((child, port_selection, health_token)) => {
                        handle
                            .state::<Mutex<DesktopServer>>()
                            .lock()
                            .expect("desktop server state poisoned")
                            .child = Some(child);
                        let ready_handle = handle.clone();
                        std::thread::spawn(move || {
                            let port = port_selection.port;
                            let deadline = Instant::now() + READY_TIMEOUT;
                            let mut ready = false;
                            while Instant::now() < deadline {
                                if http_ready(port, &health_token) {
                                    ready = true;
                                    break;
                                }
                                std::thread::sleep(READY_POLL_INTERVAL);
                            }
                            if ready {
                                if port_selection.persist_on_ready {
                                    persist_server_port(&ready_handle, port);
                                }
                                let url = Url::parse(&format!("http://127.0.0.1:{port}/"))
                                    .expect("invalid loopback URL");
                                let _ = window.navigate(url);
                                // `on_page_load` reveals the window once the app UI
                                // is up; this fallback keeps a page that never
                                // finishes loading from leaving the app invisible.
                                let fallback = window.clone();
                                std::thread::spawn(move || {
                                    std::thread::sleep(UI_SHOW_FALLBACK);
                                    if !fallback.is_visible().unwrap_or(false) {
                                        let _ = fallback.show();
                                        let _ = fallback.set_focus();
                                    }
                                });
                            } else {
                                eprintln!("pi-web sidecar readiness check timed out");
                                // On timeout keep the trusted bundled loading page
                                // visible; never navigate to an unverified service.
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        });
                    }
                    Err(error) => {
                        eprintln!("failed to start the pi-web server: {error}");
                        let _ = window.show();
                    }
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the pi-web desktop app")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                kill_server(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{is_external_browser_url, is_loopback_browser_url};

    fn parse(url: &str) -> tauri::Url {
        tauri::Url::parse(url).expect("test URL must parse")
    }

    #[test]
    fn the_app_origin_is_never_handed_to_the_system_browser() {
        // Tauri serves the bundled pages (including the startup loading page)
        // from its custom-protocol origin, which must stay in the WebView.
        for url in [
            "http://tauri.localhost/",
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/index.html",
            "http://localhost:30141/",
            "http://127.0.0.1:30141/?session=abc",
            "http://[::1]:30141/",
        ] {
            assert!(
                !is_external_browser_url(&parse(url)),
                "{url} stays in the WebView"
            );
        }
    }

    #[test]
    fn real_web_pages_still_open_in_the_system_browser() {
        for url in [
            "https://github.com/ghost0211/pi-web",
            "http://10.0.0.5:30141/",
            "https://login.tailscale.com/admin",
        ] {
            assert!(
                is_external_browser_url(&parse(url)),
                "{url} opens in the browser"
            );
        }
        // Custom schemes are neither page loads we manage nor external sites.
        assert!(!is_external_browser_url(&parse(
            "tauri://localhost/index.html"
        )));
    }

    #[test]
    fn only_the_sidecar_origin_reveals_the_window() {
        for url in [
            "http://127.0.0.1:3029/",
            "http://localhost:30141/?session=x",
            "http://127.0.0.1:3029/index.html",
        ] {
            assert!(
                is_loopback_browser_url(&parse(url)),
                "{url} reveals the window"
            );
        }
        // The bundled loading page must not reveal the window.
        for url in [
            "http://tauri.localhost/index.html",
            "https://github.com/",
            "tauri://localhost/index.html",
        ] {
            assert!(!is_loopback_browser_url(&parse(url)), "{url} stays hidden");
        }
    }
}
