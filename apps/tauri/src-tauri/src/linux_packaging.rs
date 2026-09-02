#[cfg(target_os = "linux")]
#[test]
fn packages_a_desktop_alias_matching_the_wayland_app_id() {
    use std::{fs, path::Path};

    const WAYLAND_APP_ID: &str = "futo-notes-tauri";
    const DESKTOP_DESTINATION: &str = "/usr/share/applications/futo-notes-tauri.desktop";
    const DESKTOP_SOURCE: &str = "linux/futo-notes-tauri.desktop";

    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let desktop_entry = fs::read_to_string(manifest_dir.join(DESKTOP_SOURCE))
        .expect("the Wayland desktop identity alias must exist");
    let field = |name: &str| {
        desktop_entry.lines().find_map(|line| {
            line.strip_prefix(name)
                .and_then(|value| value.strip_prefix('='))
        })
    };

    assert_eq!(field("StartupWMClass"), Some(WAYLAND_APP_ID));
    assert_eq!(field("Icon"), Some(WAYLAND_APP_ID));
    assert_eq!(field("NoDisplay"), Some("true"));

    let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
        .expect("tauri.conf.json must be valid JSON");
    for package in ["deb", "rpm"] {
        assert_eq!(
            config["bundle"]["linux"][package]["files"][DESKTOP_DESTINATION], DESKTOP_SOURCE,
            "{package} must install an alias whose filename matches the Wayland app ID",
        );
    }
}
