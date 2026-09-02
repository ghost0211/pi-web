// Pi Web Desktop: a thin Tauri shell around the local pi-web Next.js server.
//
// The web UI is served by a Node.js sidecar (the Next.js standalone build in
// `server/` plus a bundled Node runtime in `node/`). This process reserves a free
// loopback port, spawns the sidecar, waits for it to answer HTTP, then points
// the WebView2 window at it. Closing the app kills the whole sidecar process
// tree because agent sessions (and any shells they spawned) live in it.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Matches `npm run dev` (next dev -H 127.0.0.1 -p 30141).
const DEV_SERVER_URL: &str = "http://127.0.0.1:30141/";
const READY_TIMEOUT: Duration = Duration::from_secs(60);
const READY_POLL_INTERVAL: Duration = Duration::from_millis(150);

/// Handle to the sidecar so it can be terminated on exit.
struct DesktopServer {
    child: Option<Child>,
}

fn free_loopback_port() -> u16 {
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr().map(|addr| addr.port()))
        .expect("failed to reserve an ephemeral loopback port")
}

/// Any complete HTTP response (even an error status) proves the server is up.
fn http_ready(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    if stream
        .write_all(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut buf = [0u8; 16];
    matches!(stream.read(&mut buf), Ok(n) if n > 0)
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

fn spawn_server(app: &AppHandle) -> std::io::Result<(Child, u16)> {
    let node_dir = node_dir(app);
    let server_dir = server_dir(app);
    let node_bin = node_dir.join(if cfg!(windows) { "node.exe" } else { "node" });
    let port = free_loopback_port();

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

    command.spawn().map(|child| (child, port))
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

fn build_main_window(app: &AppHandle, url: WebviewUrl, visible: bool) -> WebviewWindow {
    WebviewWindowBuilder::new(app, "main", url)
        .title("Pi Web Desktop")
        .inner_size(1440.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .visible(visible)
        .build()
        .expect("failed to create the main window")
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Focus the existing window when a second instance is launched.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(Mutex::new(DesktopServer { child: None }))
        .setup(|app| {
            let handle = app.handle().clone();
            // Runtime branch (instead of #[cfg]) so both paths typecheck under
            // a single `cargo check`.
            if cfg!(debug_assertions) {
                // `tauri dev`: attach to the separately-started Next.js dev
                // server (see desktop/README.md); no sidecar is spawned.
                let url = Url::parse(DEV_SERVER_URL).expect("invalid dev server URL");
                build_main_window(&handle, WebviewUrl::External(url), true);
            } else {
                // Show a local loading page while the sidecar boots.
                let window = build_main_window(&handle, WebviewUrl::App("index.html".into()), false);
                match spawn_server(&handle) {
                    Ok((child, port)) => {
                        handle
                            .state::<Mutex<DesktopServer>>()
                            .lock()
                            .expect("desktop server state poisoned")
                            .child = Some(child);
                        std::thread::spawn(move || {
                            let deadline = Instant::now() + READY_TIMEOUT;
                            while Instant::now() < deadline && !http_ready(port) {
                                std::thread::sleep(READY_POLL_INTERVAL);
                            }
                            // Navigate even after a timeout: the WebView error
                            // page beats a silent hang, and the loading page
                            // tells the user where the server log lives.
                            let url = Url::parse(&format!("http://127.0.0.1:{port}/"))
                                .expect("invalid loopback URL");
                            let _ = window.navigate(url);
                            let _ = window.show();
                            let _ = window.set_focus();
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
