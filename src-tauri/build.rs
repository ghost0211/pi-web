fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            // Generates allow-/deny- permissions for the shell commands so the
            // loopback-hosted web UI can be granted access via a remote
            // capability (remote origins are always ACL-checked).
            tauri_build::AppManifest::new()
                .commands(&["get_close_behavior", "set_close_behavior"]),
        ),
    )
    .expect("error while running tauri-build");
}
