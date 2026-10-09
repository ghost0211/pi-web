// Pi Web Desktop: a thin Tauri shell around the local pi-web Next.js server.
//
// The web UI is served by a Node.js sidecar (the Next.js standalone build in
// `server/` plus a bundled Node runtime in `node/`). The first launch reserves
// a free loopback port and persists it; later launches reuse that port when it
// is available so WebView2 keeps a stable origin (and therefore localStorage).
// Closing the app kills the whole sidecar process tree because agent sessions
// (and any shells their tools spawned) live in it.
//
// The shell also owns the desktop-only behaviors: a system tray icon, the
// "what does closing the window mean" setting (minimize to tray vs. quit),
// persisted in `<app_config>/desktop-settings.json` and editable both from the
// tray menu and from the web settings UI via IPC commands, and native Windows
// toasts for session completion / attention events.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, File};
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::menu::{
    CheckMenuItem, CheckMenuItemBuilder, Menu, MenuBuilder, MenuItem, MenuItemBuilder,
    PredefinedMenuItem, SubmenuBuilder,
};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri_plugin_window_state::StateFlags;
use tauri::{
    AppHandle, Emitter, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;

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
const TRAY_ITEM_NEW_SESSION: &str = "new-session";
const TRAY_ITEM_RECENT_SESSIONS: &str = "recent-sessions";
const TRAY_ITEM_RECENT_PREFIX: &str = "recent:";
const TRAY_ITEM_RECENT_EMPTY: &str = "recent-empty";
const TRAY_ITEM_QUIT: &str = "quit";
const TRAY_ITEM_MINIMIZE_ON_CLOSE: &str = "minimize-on-close";
const TRAY_ACTION_EVENT: &str = "pi-web:tray-action";
const TRAY_LOCALE_SETTING: &str = "trayLocale";
const TRAY_LABELS_SETTING: &str = "trayLabels";
const MAX_TRAY_LABEL_CHARS: usize = 120;
const MAX_TRAY_TITLE_CHARS: usize = 80;
const MAX_TRAY_ID_CHARS: usize = 128;
const MAX_TRAY_LOCALE_CHARS: usize = 64;
const MAX_TRAY_PAYLOAD_CHARS: usize = 1408;

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

/// Active tray icon and the *current* checkbox handle. The handle is replaced
/// together with a rebuilt menu so checkbox events never inspect a stale item.
struct TrayHandles {
    tray: TrayIcon<tauri::Wry>,
    minimize_on_close: Mutex<CheckMenuItem<tauri::Wry>>,
}

/// Serializes menu syncs without being acquired by menu callbacks. Never hold a
/// UI-state mutex while making a synchronous Tauri main-thread call.
#[derive(Default)]
struct TraySyncLock(Mutex<()>);

/// Serializes settings-file read/modify/write updates to preserve other owners'
/// keys when unrelated preferences are changed concurrently.
#[derive(Default)]
struct SettingsWriteLock(Mutex<()>);

#[derive(Default)]
struct PendingTrayActionState(Mutex<Option<PendingTrayAction>>);

#[derive(Clone, Debug, PartialEq, Eq)]
enum PendingTrayAction {
    NewSession,
    OpenSession { session_id: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct TrayRecentSession {
    id: String,
    title: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct TrayMenuPayload {
    locale: String,
    labels: TrayLabels,
    recent_sessions: Vec<TrayRecentSession>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct TrayLabels {
    show: String,
    new_session: String,
    recent_sessions: String,
    empty_recent: String,
    minimize_on_close: String,
    quit: String,
}

/// In-app desktop display name. The installer productName intentionally stays
/// "Pi Web Desktop" so upgrades keep the existing install location and entry.
const DESKTOP_DISPLAY_NAME: &str = "Pi Desktop";

/// Bounds for notification text. The web page is trusted only as far as any
/// other page on the loopback origin; keeping the payload small stops a broken
/// or hostile caller from filling the Windows Action Center.
const MAX_NOTIFICATION_TITLE_CHARS: usize = 120;
const MAX_NOTIFICATION_BODY_CHARS: usize = 400;
/// Opaque identifiers (session id / dedup tag) are bounded and character-checked
/// so they can never be interpreted as a path or URL.
const MAX_NOTIFICATION_ID_CHARS: usize = 128;
/// Toasts sharing a dedup tag inside this window are dropped: a re-render or a
/// retried SSE event must not stack duplicate notifications.
const NOTIFICATION_DEDUP_WINDOW: Duration = Duration::from_millis(1500);

/// Native-notification bookkeeping: duplicate suppression for repeated tags.
///
/// Click activation is NOT available through tauri-plugin-notification on
/// Windows desktop (its desktop backend forwards only title/body/icon/sound to
/// notify-rust, which has no activation callback outside XDG), so toasts are
/// informational only; see desktop/README.md.
struct NotificationState {
    last_shown: Mutex<Option<(String, Instant)>>,
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
    load_settings_from_path(&path)
}

fn load_settings_from_path(path: &std::path::Path) -> Result<serde_json::Map<String, serde_json::Value>, String> {
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
    let write_lock = app.state::<SettingsWriteLock>();
    let _write_guard = match write_lock.0.lock() {
        Ok(guard) => guard,
        Err(_) => {
            eprintln!("refusing to update desktop settings: settings write lock poisoned");
            return;
        }
    };
    let mut settings = match load_settings_object(app) {
        Ok(settings) => settings,
        Err(error) => {
            eprintln!("refusing to overwrite desktop settings: {error}");
            return;
        }
    };
    settings.insert(key.to_string(), value);
    let Some(path) = settings_path(app) else { return };
    if let Err(error) = write_settings_atomic(&path, &settings) {
        eprintln!("failed to write desktop settings: {error}");
    }
}

/// Same-directory atomic replacement keeps existing preferences recoverable if
/// a write fails. Never follow/replace a user-supplied settings-file symlink.
fn write_settings_atomic(path: &std::path::Path, settings: &serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
    if fs::symlink_metadata(path).map(|meta| meta.file_type().is_symlink()).unwrap_or(false) {
        return Err("refusing to replace symlinked desktop settings".to_string());
    }
    let parent = path.parent().ok_or_else(|| "settings directory unavailable".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_nanos()).unwrap_or_default();
    let temporary = parent.join(format!(".desktop-settings-{}-{nanos}.tmp", std::process::id()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut file = options.open(&temporary).map_err(|error| error.to_string())?;
        file.write_all(serde_json::Value::Object(settings.clone()).to_string().as_bytes()).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        fs::rename(&temporary, path).map_err(|error| error.to_string())
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result
}

fn merged_tray_settings(mut settings: serde_json::Map<String, serde_json::Value>, locale: &str, labels: &TrayLabels) -> serde_json::Map<String, serde_json::Value> {
    settings.insert(TRAY_LOCALE_SETTING.to_string(), serde_json::Value::String(locale.to_string()));
    settings.insert(TRAY_LABELS_SETTING.to_string(), tray_labels_to_value(labels));
    settings
}

fn persist_tray_settings(
    app: &AppHandle,
    locale: &str,
    labels: &TrayLabels,
) -> Result<(), String> {
    let write_lock = app.state::<SettingsWriteLock>();
    let _write_guard = write_lock
        .0
        .lock()
        .map_err(|_| "desktop settings write lock poisoned".to_string())?;
    let settings = load_settings_object(app)?;
    let next = merged_tray_settings(settings.clone(), locale, labels);
    if next == settings { return Ok(()); }
    let path = settings_path(app).ok_or_else(|| "desktop settings path unavailable".to_string())?;
    write_settings_atomic(&path, &next)
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
fn refresh_tray_check_item(app: &AppHandle) {
    let app_for_main_thread = app.clone();
    let _ = app.run_on_main_thread(move || {
        let checked = current_close_behavior(&app_for_main_thread) == CLOSE_BEHAVIOR_TRAY;
        let item = app_for_main_thread.try_state::<TrayHandles>().and_then(|handles| {
            handles
                .minimize_on_close
                .lock()
                .ok()
                .map(|item| item.clone())
        });
        if let Some(item) = item {
            let _ = item.set_checked(checked);
        }
    });
}

fn apply_close_behavior(app: &AppHandle, behavior: &str) {
    if behavior != CLOSE_BEHAVIOR_TRAY && behavior != CLOSE_BEHAVIOR_QUIT {
        return;
    }
    if let Ok(mut value) = app.state::<DesktopSettings>().close_behavior.lock() {
        *value = behavior.to_string();
    }
    persist_close_behavior(app);
    refresh_tray_check_item(app);
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

/// Collapse whitespace/control characters and truncate on a UTF-8 char
/// boundary. Windows toast XML is picky about control characters, and the page
/// must not be able to smuggle formatting or oversized payloads into it.
fn sanitize_notification_text(raw: &str, max_chars: usize) -> String {
    let flattened: String = raw
        .chars()
        .map(|character| if character.is_control() { ' ' } else { character })
        .collect();
    let collapsed = flattened.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= max_chars {
        return collapsed;
    }
    collapsed.chars().take(max_chars).collect()
}

/// Opaque id/tag check: ASCII, bounded, and no path or URL syntax at all.
fn is_safe_notification_identifier(raw: &str) -> bool {
    !raw.is_empty()
        && raw.len() <= MAX_NOTIFICATION_ID_CHARS
        && raw
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ':'))
}

fn sanitize_notification_identifier(raw: Option<&str>) -> Result<Option<String>, String> {
    match raw.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) if is_safe_notification_identifier(value) => Ok(Some(value.to_string())),
        Some(_) => Err("notification identifier must be a bounded opaque id".to_string()),
        None => Ok(None),
    }
}

/// Show a native Windows toast for a finished agent session or an extension
/// attention request.
///
/// Returns `true` when a toast was handed to the OS and `false` when an
/// identical `tag` was already shown inside [`NOTIFICATION_DEDUP_WINDOW`].
/// `session_id` is an opaque deep-link target (never a URL or path) used only
/// as the dedup-tag fallback.
#[tauri::command]
fn send_desktop_notification(
    app: AppHandle,
    title: String,
    body: String,
    session_id: Option<String>,
    tag: Option<String>,
) -> Result<bool, String> {
    let title = sanitize_notification_text(&title, MAX_NOTIFICATION_TITLE_CHARS);
    if title.is_empty() {
        return Err("notification title is empty".to_string());
    }
    let body = sanitize_notification_text(&body, MAX_NOTIFICATION_BODY_CHARS);
    let session_id = sanitize_notification_identifier(session_id.as_deref())?;
    // Fall back to the session id so repeated completions of one session replace
    // each other instead of stacking up.
    let tag = sanitize_notification_identifier(tag.as_deref())?
        .or_else(|| session_id.clone())
        .unwrap_or_else(|| "pi-web".to_string());

    let state = app.state::<NotificationState>();
    {
        let mut last_shown = state
            .last_shown
            .lock()
            .map_err(|_| "notification state poisoned".to_string())?;
        if let Some((previous_tag, shown_at)) = last_shown.as_ref() {
            if previous_tag == &tag && shown_at.elapsed() < NOTIFICATION_DEDUP_WINDOW {
                return Ok(false);
            }
        }
        *last_shown = Some((tag, Instant::now()));
    }

    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| format!("failed to show the desktop notification: {error}"))?;
    Ok(true)
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

/// Whether the sidecar binds all interfaces (LAN-reachable) instead of
/// loopback only. Default false: an unauthenticated agent server must not be
/// exposed to the network unless the user explicitly opts in. Applied at
/// process spawn, so toggling requires an app restart.
fn read_lan_access(app: &AppHandle) -> bool {
    read_settings_object(app)
        .get("lanAccess")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

#[tauri::command]
fn get_lan_access(app: AppHandle) -> bool {
    read_lan_access(&app)
}

/// Replace the native tray menu with the current web-provided translations and
/// bounded recent-session list. IDs stay in the native menu item IDs so delayed
/// clicks cannot resolve to a different session after a list reorder.
#[tauri::command]
fn sync_tray_menu(app: AppHandle, menu: serde_json::Value) -> Result<(), String> {
    let payload = parse_tray_menu_payload(menu)?;
    let sync_lock = app.state::<TraySyncLock>();
    let _sync_guard = sync_lock
        .0
        .lock()
        .map_err(|_| "tray synchronization lock poisoned".to_string())?;

    // Fail closed if settings are corrupted/unreadable; do not overwrite other
    // preferences or report success while startup labels could not be saved.
    persist_tray_settings(&app, &payload.locale, &payload.labels)?;
    let close_behavior = current_close_behavior(&app);
    let (native_menu, check_item) = build_tray_menu(
        &app,
        &payload.labels,
        &payload.recent_sessions,
        &close_behavior,
    )
    .map_err(|error| format!("failed to build tray menu: {error}"))?;
    replace_tray_menu(&app, native_menu, check_item)
}

/// Return and consume the latest explicit tray action. This is intentionally
/// independent of focus/notification events so early clicks survive hydration.
#[tauri::command]
fn take_tray_action(app: AppHandle) -> Option<serde_json::Value> {
    app.state::<PendingTrayActionState>()
        .0
        .lock()
        .ok()?
        .take()
        .map(|action| action.to_value())
}

#[tauri::command]
fn set_lan_access(app: AppHandle, enabled: bool) -> bool {
    update_setting(&app, "lanAccess", serde_json::Value::Bool(enabled));
    enabled
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn built_in_tray_labels(locale: &str) -> TrayLabels {
    match locale {
        "zh-CN" => TrayLabels {
            show: format!("显示 {DESKTOP_DISPLAY_NAME}"),
            new_session: "新建会话".to_string(),
            recent_sessions: "最近会话".to_string(),
            empty_recent: "暂无最近会话".to_string(),
            minimize_on_close: "关闭时最小化到托盘".to_string(),
            quit: "退出".to_string(),
        },
        "zh-TW" => TrayLabels {
            show: format!("顯示 {DESKTOP_DISPLAY_NAME}"),
            new_session: "新增工作階段".to_string(),
            recent_sessions: "最近工作階段".to_string(),
            empty_recent: "沒有最近工作階段".to_string(),
            minimize_on_close: "關閉時最小化至系統匣".to_string(),
            quit: "結束".to_string(),
        },
        _ => TrayLabels {
            show: format!("Show {DESKTOP_DISPLAY_NAME}"),
            new_session: "New session".to_string(),
            recent_sessions: "Recent sessions".to_string(),
            empty_recent: "No recent sessions".to_string(),
            minimize_on_close: "Minimize to tray on close".to_string(),
            quit: "Quit".to_string(),
        },
    }
}

fn sanitize_bounded_text(raw: &str, max_chars: usize, allow_empty: bool) -> Result<String, String> {
    if raw.chars().count() > max_chars {
        return Err(format!("text exceeds the {max_chars}-character limit"));
    }
    let flattened: String = raw
        .chars()
        .map(|character| if character.is_control() { ' ' } else { character })
        .collect();
    let sanitized = flattened.split_whitespace().collect::<Vec<_>>().join(" ");
    if !allow_empty && sanitized.is_empty() {
        return Err("text must not be empty".to_string());
    }
    Ok(sanitized)
}

fn is_safe_tray_identifier(raw: &str) -> bool {
    !raw.is_empty()
        && raw != "."
        && raw != ".."
        && raw.len() <= MAX_TRAY_ID_CHARS
        && raw.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ':')
        })
}

fn tray_labels_from_value(value: &serde_json::Value) -> Option<TrayLabels> {
    let object = value.as_object()?;
    const LABEL_KEYS: [&str; 6] = [
        "show",
        "newSession",
        "recentSessions",
        "emptyRecent",
        "minimizeOnClose",
        "quit",
    ];
    if object.len() != LABEL_KEYS.len() || object.keys().any(|key| !LABEL_KEYS.contains(&key.as_str())) {
        return None;
    }
    let label = |key: &str| {
        sanitize_bounded_text(object.get(key)?.as_str()?, MAX_TRAY_LABEL_CHARS, false).ok()
    };
    Some(TrayLabels {
        show: label("show")?,
        new_session: label("newSession")?,
        recent_sessions: label("recentSessions")?,
        empty_recent: label("emptyRecent")?,
        minimize_on_close: label("minimizeOnClose")?,
        quit: label("quit")?,
    })
}

fn tray_labels_to_value(labels: &TrayLabels) -> serde_json::Value {
    serde_json::json!({
        "show": labels.show,
        "newSession": labels.new_session,
        "recentSessions": labels.recent_sessions,
        "emptyRecent": labels.empty_recent,
        "minimizeOnClose": labels.minimize_on_close,
        "quit": labels.quit,
    })
}

fn parse_tray_menu_payload(value: serde_json::Value) -> Result<TrayMenuPayload, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "tray menu payload must be an object".to_string())?;
    const ROOT_KEYS: [&str; 3] = ["locale", "labels", "recentSessions"];
    if object.len() != ROOT_KEYS.len() || object.keys().any(|key| !ROOT_KEYS.contains(&key.as_str())) {
        return Err("tray menu payload has missing or unknown fields".to_string());
    }
    let locale_raw = object
        .get("locale")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "tray menu locale must be a string".to_string())?;
    let locale = sanitize_bounded_text(locale_raw, MAX_TRAY_LOCALE_CHARS, false)
        .map_err(|_| "tray menu locale is invalid or oversized".to_string())?;
    let labels = tray_labels_from_value(
        object
            .get("labels")
            .ok_or_else(|| "tray menu labels are required".to_string())?,
    )
    .ok_or_else(|| "tray menu labels are invalid or oversized".to_string())?;
    let recent_value = object
        .get("recentSessions")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "recentSessions must be an array".to_string())?;
    if recent_value.len() > 3 {
        return Err("at most three recent sessions are allowed".to_string());
    }

    let mut recent_sessions = Vec::with_capacity(recent_value.len());
    let mut seen_ids = std::collections::HashSet::new();
    let mut total_chars = locale.chars().count()
        + labels.show.chars().count()
        + labels.new_session.chars().count()
        + labels.recent_sessions.chars().count()
        + labels.empty_recent.chars().count()
        + labels.minimize_on_close.chars().count()
        + labels.quit.chars().count();
    for value in recent_value {
        let session = value
            .as_object()
            .ok_or_else(|| "recent session must be an object".to_string())?;
        if session.len() != 2 || session.keys().any(|key| key != "id" && key != "title") {
            return Err("recent session has missing or unknown fields".to_string());
        }
        let id = session
            .get("id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "recent session id must be a string".to_string())?;
        if !is_safe_tray_identifier(id) {
            return Err("recent session id must be a bounded opaque id".to_string());
        }
        if !seen_ids.insert(id.to_string()) {
            return Err("recent session ids must be unique".to_string());
        }
        let title_raw = session
            .get("title")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "recent session title must be a string".to_string())?;
        let title = sanitize_bounded_text(title_raw, MAX_TRAY_TITLE_CHARS, false)
            .map_err(|_| "recent session title is oversized".to_string())?;
        total_chars += id.chars().count() + title.chars().count();
        if total_chars > MAX_TRAY_PAYLOAD_CHARS {
            return Err("tray menu payload is oversized".to_string());
        }
        recent_sessions.push(TrayRecentSession {
            id: id.to_string(),
            title,
        });
    }
    if total_chars > MAX_TRAY_PAYLOAD_CHARS {
        return Err("tray menu payload is oversized".to_string());
    }
    Ok(TrayMenuPayload {
        locale,
        labels,
        recent_sessions,
    })
}

fn read_startup_tray_labels(app: &AppHandle) -> TrayLabels {
    let settings = match load_settings_object(app) {
        Ok(settings) => settings,
        Err(error) => {
            eprintln!("using default tray labels: {error}");
            return built_in_tray_labels("en");
        }
    };
    startup_tray_labels(&settings)
}

fn startup_tray_labels(settings: &serde_json::Map<String, serde_json::Value>) -> TrayLabels {
    let locale = settings
        .get(TRAY_LOCALE_SETTING)
        .and_then(serde_json::Value::as_str)
        .and_then(|raw| sanitize_bounded_text(raw, MAX_TRAY_LOCALE_CHARS, false).ok())
        .unwrap_or_else(|| "en".to_string());
    settings
        .get(TRAY_LABELS_SETTING)
        .and_then(tray_labels_from_value)
        .unwrap_or_else(|| built_in_tray_labels(&locale))
}

#[cfg(windows)]
fn native_menu_label(raw: &str) -> String {
    // Tauri/muda treats '&' as a Windows mnemonic marker. Double it so web
    // supplied literal labels and session titles display as text.
    raw.replace('&', "&&")
}

#[cfg(not(windows))]
fn native_menu_label(raw: &str) -> String {
    raw.to_string()
}

fn build_tray_menu(
    app: &AppHandle,
    labels: &TrayLabels,
    recent_sessions: &[TrayRecentSession],
    close_behavior: &str,
) -> tauri::Result<(Menu<tauri::Wry>, CheckMenuItem<tauri::Wry>)> {
    let show = MenuItemBuilder::with_id(TRAY_ITEM_SHOW, native_menu_label(&labels.show)).build(app)?;
    let new_session = MenuItemBuilder::with_id(
        TRAY_ITEM_NEW_SESSION,
        native_menu_label(&labels.new_session),
    )
    .build(app)?;
    let mut recent_items = Vec::<MenuItem<tauri::Wry>>::new();
    if recent_sessions.is_empty() {
        recent_items.push(
            MenuItemBuilder::with_id(
                TRAY_ITEM_RECENT_EMPTY,
                native_menu_label(&labels.empty_recent),
            )
            .enabled(false)
            .build(app)?,
        );
    } else {
        for session in recent_sessions {
            let item_id = format!("{TRAY_ITEM_RECENT_PREFIX}{}", session.id);
            recent_items.push(
                MenuItemBuilder::with_id(item_id, native_menu_label(&session.title)).build(app)?,
            );
        }
    }
    let recent_item_refs = recent_items
        .iter()
        .map(|item| item as &dyn tauri::menu::IsMenuItem<tauri::Wry>)
        .collect::<Vec<_>>();
    let recent_submenu = SubmenuBuilder::with_id(
        app,
        TRAY_ITEM_RECENT_SESSIONS,
        native_menu_label(&labels.recent_sessions),
    )
    .items(&recent_item_refs)
    .build()?;
    let separator = PredefinedMenuItem::separator(app)?;
    let minimize_on_close = CheckMenuItemBuilder::with_id(
        TRAY_ITEM_MINIMIZE_ON_CLOSE,
        native_menu_label(&labels.minimize_on_close),
    )
    .checked(close_behavior == CLOSE_BEHAVIOR_TRAY)
    .build(app)?;
    let quit = MenuItemBuilder::with_id(TRAY_ITEM_QUIT, native_menu_label(&labels.quit)).build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[
            &show,
            &new_session,
            &recent_submenu,
            &separator,
            &minimize_on_close,
            &quit,
        ])
        .build()?;
    Ok((menu, minimize_on_close))
}

fn replace_tray_menu(
    app: &AppHandle,
    menu: Menu<tauri::Wry>,
    minimize_on_close: CheckMenuItem<tauri::Wry>,
) -> Result<(), String> {
    let app_for_main_thread = app.clone();
    let (sender, receiver) = mpsc::channel();
    app.run_on_main_thread(move || {
        let result = (|| {
            let tray = app_for_main_thread
                .try_state::<TrayHandles>()
                .map(|handles| handles.tray.clone())
                .ok_or_else(|| "system tray is unavailable".to_string())?;
            // Re-read the preference at the moment the new menu becomes active.
            // A concurrent settings change queues its own main-thread refresh.
            let checked = current_close_behavior(&app_for_main_thread) == CLOSE_BEHAVIOR_TRAY;
            minimize_on_close
                .set_checked(checked)
                .map_err(|error| format!("failed to update tray checkbox: {error}"))?;
            tray.set_menu(Some(menu))
                .map_err(|error| format!("failed to replace tray menu: {error}"))?;
            if let Some(handles) = app_for_main_thread.try_state::<TrayHandles>() {
                let mut current = handles
                    .minimize_on_close
                    .lock()
                    .map_err(|_| "tray checkbox handle lock poisoned".to_string())?;
                *current = minimize_on_close;
            }
            Ok(())
        })();
        let _ = sender.send(result);
    })
    .map_err(|error| format!("failed to schedule tray menu update: {error}"))?;
    receiver
        .recv()
        .map_err(|_| "tray menu update did not complete".to_string())?
}

fn action_for_menu_id(id: &str) -> Option<PendingTrayAction> {
    if id == TRAY_ITEM_NEW_SESSION {
        return Some(PendingTrayAction::NewSession);
    }
    let session_id = id.strip_prefix(TRAY_ITEM_RECENT_PREFIX)?;
    if !is_safe_tray_identifier(session_id) {
        return None;
    }
    Some(PendingTrayAction::OpenSession {
        session_id: session_id.to_string(),
    })
}

impl PendingTrayAction {
    fn to_value(&self) -> serde_json::Value {
        match self {
            Self::NewSession => serde_json::json!({ "type": "new-session" }),
            Self::OpenSession { session_id } => serde_json::json!({
                "type": "open-session",
                "sessionId": session_id,
            }),
        }
    }
}

fn queue_tray_action(app: &AppHandle, action: PendingTrayAction) {
    if let Ok(mut pending) = app.state::<PendingTrayActionState>().0.lock() {
        *pending = Some(action);
    }
    show_main_window(app);
    // This is only a wake-up signal; the action remains in memory until the UI
    // explicitly consumes it, including clicks that happen before hydration.
    let _ = app.emit(TRAY_ACTION_EVENT, ());
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let initial_labels = read_startup_tray_labels(app);
    let (menu, minimize_on_close) = build_tray_menu(
        app,
        &initial_labels,
        &[],
        &current_close_behavior(app),
    )?;
    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(app.default_window_icon().expect("no window icon").clone())
        .tooltip(DESKTOP_DISPLAY_NAME)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            match id {
                TRAY_ITEM_SHOW => show_main_window(app),
                TRAY_ITEM_QUIT => app.exit(0),
                TRAY_ITEM_NEW_SESSION => {
                    queue_tray_action(app, PendingTrayAction::NewSession);
                }
                TRAY_ITEM_MINIMIZE_ON_CLOSE => {
                    // The OS already toggled the item. Read the current item
                    // handle because menu rebuilds replace it.
                    let current_item = app.try_state::<TrayHandles>().and_then(|handles| {
                        handles
                            .minimize_on_close
                            .lock()
                            .ok()
                            .map(|item| item.clone())
                    });
                    let checked = current_item
                        .and_then(|item| item.is_checked().ok())
                        .unwrap_or(true);
                    apply_close_behavior(
                        app,
                        if checked { CLOSE_BEHAVIOR_TRAY } else { CLOSE_BEHAVIOR_QUIT },
                    );
                }
                _ => {
                    if let Some(action) = action_for_menu_id(id) {
                        queue_tray_action(app, action);
                    }
                }
            }
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

    app.manage(TrayHandles {
        tray,
        minimize_on_close: Mutex::new(minimize_on_close),
    });
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
    let installation_dir = std::env::current_exe()?
        .parent()
        .map(PathBuf::from)
        .ok_or_else(|| {
            std::io::Error::new(
                ErrorKind::NotFound,
                "current executable has no installation directory",
            )
        })?;
    let node_dir = node_dir(app);
    let server_dir = server_dir(app);
    let node_bin = node_dir.join(if cfg!(windows) { "node.exe" } else { "node" });
    let port_selection = desktop_server_port(app);
    let port = port_selection.port;
    let health_token = new_health_token();
    // Loopback-only by default; LAN opt-in binds all interfaces. The WebView
    // and the readiness probe keep using 127.0.0.1 either way.
    let bind_host: &str = if read_lan_access(app) { "0.0.0.0" } else { "127.0.0.1" };

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
        .env("HOSTNAME", bind_host)
        .env("PORT", port.to_string())
        // Marker for future desktop-only server behavior.
        .env("PI_WEB_DESKTOP", "1")
        .env("PI_WEB_DESKTOP_INSTALL_DIR", &installation_dir)
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

/// Stop the sidecar before the updater replaces bundled files. The NSIS
/// installer force-quits the app process, which can leave the bundled
/// node.exe orphaned and locking the install directory (updates fail with
/// "file in use" until the user kills it manually). Killing it here, before
/// `downloadAndInstall` launches the installer, makes that impossible.
#[tauri::command]
fn prepare_desktop_update(app: AppHandle) -> bool {
    kill_server(&app);
    true
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
        .title(DESKTOP_DISPLAY_NAME)
        .inner_size(1440.0, 900.0)
        .min_inner_size(900.0, 600.0)
        // Undecorated: the web UI draws its own titlebar controls (see
        // components/DesktopWindowControls.tsx). Keep the native shadow so the
        // window still reads as a window on the desktop.
        .decorations(false)
        .shadow(true)
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
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second launch acts as "restore from tray": focus the window.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // Never persist/restore decorations: the window is undecorated
                // by design (custom titlebar), and a state file written by an
                // older decorated build would otherwise restore the native
                // titlebar on top of it.
                .with_state_flags(StateFlags::all() & !StateFlags::DECORATIONS)
                .build(),
        )
        .manage(Mutex::new(DesktopServer { child: None }))
        .manage(NotificationState {
            last_shown: Mutex::new(None),
        })
        .manage(SettingsWriteLock::default())
        .manage(TraySyncLock::default())
        .manage(PendingTrayActionState::default())
        .invoke_handler(tauri::generate_handler![
            get_close_behavior,
            set_close_behavior,
            pick_attachment_paths,
            open_local_path,
            open_local_path_with,
            reveal_local_path,
            send_desktop_notification,
            prepare_desktop_update,
            get_lan_access,
            set_lan_access,
            sync_tray_menu,
            take_tray_action,
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
    use super::{
        is_external_browser_url, is_loopback_browser_url, is_safe_notification_identifier,
        sanitize_notification_identifier, sanitize_notification_text, MAX_NOTIFICATION_BODY_CHARS,
        MAX_NOTIFICATION_ID_CHARS, MAX_NOTIFICATION_TITLE_CHARS,
    };

    #[test]
    fn notification_text_strips_control_characters_and_is_bounded() {
        // Newlines/tabs and NUL are flattened so toast XML cannot be injected.
        assert_eq!(
            sanitize_notification_text("Task\nfinished\t\u{0}now", MAX_NOTIFICATION_BODY_CHARS),
            "Task finished now"
        );
        let long = "é".repeat(MAX_NOTIFICATION_TITLE_CHARS + 40);
        let bounded = sanitize_notification_text(&long, MAX_NOTIFICATION_TITLE_CHARS);
        assert_eq!(bounded.chars().count(), MAX_NOTIFICATION_TITLE_CHARS);
        // Truncation must not split a multi-byte character.
        assert!(bounded.chars().all(|character| character == 'é'));
    }

    #[test]
    fn notification_identifiers_reject_paths_and_urls() {
        assert!(is_safe_notification_identifier("pi-session-complete:0a1b2c3d"));
        assert!(is_safe_notification_identifier("a.b_c-d:e"));
        for rejected in [
            "",
            "../etc/passwd",
            "C:\\Users\\me",
            "https://example.com/",
            "has space",
            "sla/sh",
            "semi;colon",
        ] {
            assert!(
                !is_safe_notification_identifier(rejected),
                "{rejected} must be rejected"
            );
        }
        // Whitespace-only input is treated as "no id" instead of an error.
        assert_eq!(sanitize_notification_identifier(Some("  ")), Ok(None));
        assert_eq!(sanitize_notification_identifier(None), Ok(None));
        assert!(sanitize_notification_identifier(Some("../escape")).is_err());
        // Oversized ids are rejected outright rather than truncated.
        let oversized = "a".repeat(MAX_NOTIFICATION_ID_CHARS + 1);
        assert!(sanitize_notification_identifier(Some(&oversized)).is_err());
    }

    fn tray_payload(locale: &str) -> serde_json::Value {
        serde_json::json!({"locale": locale, "labels": super::tray_labels_to_value(&super::built_in_tray_labels(locale)), "recentSessions": [{"id":"fixture-id", "title":"Fixture only"}]})
    }

    #[test]
    fn tray_payload_is_bounded_and_rejects_unknown_fields() {
        assert!(super::parse_tray_menu_payload(tray_payload("zh-CN")).is_ok());
        let mut bad = tray_payload("en"); bad["extra"] = serde_json::json!(true);
        assert!(super::parse_tray_menu_payload(bad).is_err());
        for id in ["../file", ".", "..", "C:\\fake", "https://example.com", "", "a b"] {
            let mut bad = tray_payload("en"); bad["recentSessions"][0]["id"] = serde_json::json!(id);
            assert!(super::parse_tray_menu_payload(bad).is_err());
        }
        let mut bad = tray_payload("en"); bad["labels"]["show"] = serde_json::json!("x".repeat(121));
        assert!(super::parse_tray_menu_payload(bad).is_err());
        let mut bad = tray_payload("en"); bad["recentSessions"][0]["title"] = serde_json::json!("你".repeat(81));
        assert!(super::parse_tray_menu_payload(bad).is_err());
        let mut bad = tray_payload("en"); bad["recentSessions"][0]["title"] = serde_json::json!("\n\t");
        assert!(super::parse_tray_menu_payload(bad).is_err());
        let mut bad = tray_payload("en"); bad["recentSessions"] = serde_json::json!([{"id":"same","title":"a"},{"id":"same","title":"b"}]);
        assert!(super::parse_tray_menu_payload(bad).is_err());
        let mut bad = tray_payload("en"); bad["recentSessions"] = serde_json::json!([{"id":"1","title":"a"},{"id":"2","title":"b"},{"id":"3","title":"c"},{"id":"4","title":"d"}]);
        assert!(super::parse_tray_menu_payload(bad).is_err());
        let mut bad = tray_payload("en"); bad["labels"]["extra"] = serde_json::json!("ignored?");
        assert!(super::parse_tray_menu_payload(bad).is_err());
    }

    #[test]
    fn tray_text_is_unicode_safe_and_mnemonics_are_literal() {
        assert_eq!(super::sanitize_bounded_text(" 显示\n\t\u{0}窗口 ", 120, false).unwrap(), "显示 窗口");
        assert!(super::sanitize_bounded_text("你".repeat(121).as_str(), 120, false).is_err());
        assert!(super::sanitize_bounded_text("\n\t", 120, false).is_err());
        #[cfg(windows)] assert_eq!(super::native_menu_label("R&D"), "R&&D");
        #[cfg(not(windows))] assert_eq!(super::native_menu_label("R&D"), "R&D");
    }

    #[test]
    fn tray_startup_uses_saved_translation_without_persisting_recent_conversations() {
        let old = serde_json::json!({"closeBehavior":"quit","serverPort":3029,"lanAccess":true,"custom":{"keep":7}}).as_object().unwrap().clone();
        let labels = super::built_in_tray_labels("zh-CN");
        let merged = super::merged_tray_settings(old.clone(), "zh-CN", &labels);
        for (key,value) in old { assert_eq!(merged.get(&key), Some(&value)); }
        assert!(!merged.contains_key("recentSessions"));
        assert_eq!(super::startup_tray_labels(&merged), labels);
        assert_eq!(super::built_in_tray_labels("en").show, "Show Pi Desktop");
        assert_eq!(super::built_in_tray_labels("zh-CN").show, "显示 Pi Desktop");
        assert_eq!(super::built_in_tray_labels("zh-TW").show, "顯示 Pi Desktop");
        assert_eq!(super::built_in_tray_labels("zh-TW").quit, "結束");
        assert_eq!(super::built_in_tray_labels("unknown"), super::built_in_tray_labels("en"));
        let mut fallback = serde_json::Map::new(); fallback.insert("trayLocale".into(), serde_json::json!("zh-TW"));
        assert_eq!(super::startup_tray_labels(&fallback), super::built_in_tray_labels("zh-TW"));
        fallback.insert("trayLabels".into(), serde_json::json!({"show":"broken"}));
        assert_eq!(super::startup_tray_labels(&fallback), super::built_in_tray_labels("zh-TW"));
    }

    #[test]
    fn tray_actions_use_actual_ids_and_consume_only_explicit_latest_requests() {
        assert_eq!(super::action_for_menu_id("new-session"), Some(super::PendingTrayAction::NewSession));
        assert!(super::action_for_menu_id("recent:../escape").is_none());
        assert!(super::action_for_menu_id("show").is_none());
        let first = super::action_for_menu_id("recent:actual-session-id").unwrap();
        assert_eq!(first.to_value(), serde_json::json!({"type":"open-session","sessionId":"actual-session-id"}));
        let state = super::PendingTrayActionState::default();
        assert!(state.0.lock().unwrap().take().is_none());
        *state.0.lock().unwrap() = Some(first);
        *state.0.lock().unwrap() = Some(super::PendingTrayAction::NewSession);
        assert_eq!(state.0.lock().unwrap().take().unwrap().to_value(), serde_json::json!({"type":"new-session"}));
        assert!(state.0.lock().unwrap().take().is_none());
    }

    #[test]
    fn desktop_settings_atomic_write_preserves_unknown_fields_and_corruption() {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("pi-tray-test-{}-{stamp}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("desktop-settings.json");
        let fields = serde_json::json!({"closeBehavior":"quit","unknown":{"keep":true}}).as_object().unwrap().clone();
        super::write_settings_atomic(&path, &fields).unwrap();
        assert_eq!(super::load_settings_from_path(&path).unwrap(), fields);
        let updated = super::merged_tray_settings(fields, "en", &super::built_in_tray_labels("en"));
        super::write_settings_atomic(&path, &updated).unwrap();
        assert_eq!(super::load_settings_from_path(&path).unwrap()["unknown"], serde_json::json!({"keep":true}));
        std::fs::write(&path, b"{corrupt").unwrap();
        assert!(super::load_settings_from_path(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"{corrupt");
        let blocked = dir.join("blocked"); std::fs::create_dir(&blocked).unwrap();
        std::fs::write(blocked.join("keep"), b"untouched").unwrap();
        assert!(super::write_settings_atomic(&blocked, &updated).is_err());
        assert_eq!(std::fs::read(blocked.join("keep")).unwrap(), b"untouched");
        assert!(!std::fs::read_dir(&dir).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
        std::fs::remove_dir_all(dir).unwrap();
    }

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
