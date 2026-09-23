//! Operating-system startup integration, isolated from application composition.

use tauri::Manager;

pub(crate) fn prepare_process() {
    #[cfg(unix)]
    raise_fd_limit();
    #[cfg(target_os = "linux")]
    {
        configure_linux_renderer();
        install_linux_log_filters();
    }
}

pub(crate) fn is_flatpak() -> bool {
    std::path::Path::new("/.flatpak-info").exists()
}

pub(crate) fn configure_app(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(desktop)]
    if std::env::var("FUTO_NOTES_MULTI_INSTANCE").is_err() {
        app.plugin(tauri_plugin_single_instance::init(|app, arguments, cwd| {
            // On Linux and Windows a `futonotes://` link launches a second
            // process whose only argument is the URL; single-instance hands
            // that argv here, and it is the only place the link appears.
            crate::license::handle_single_instance_arguments(app, &arguments);
            crate::external_file_open::emit_arguments(app, arguments, cwd);
            if let Some(window) = app.get_webview_window("main") {
                // The window starts hidden (window_reveal): a second launch
                // during that gap must reveal it, not just focus a window
                // nobody can see.
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))?;
    }

    #[cfg(target_os = "linux")]
    {
        if let Some(window) = app.get_webview_window("main") {
            window.set_decorations(false)?;
        }
        let app = app.clone();
        crate::background_tasks::spawn("futo-linux-desktop-settings", move || {
            if let Err(error) = crate::desktop_settings::watch(app) {
                eprintln!("Linux desktop settings watcher stopped: {error}");
            }
        })?;
    }

    Ok(())
}

#[cfg(any(test, target_os = "linux"))]
fn should_suppress_libsoup_warning(domain: Option<&str>, message: &str) -> bool {
    domain == Some("libsoup-http2")
        && message.contains("Unexpected state changed WRITE_DATA -> READ_DATA_START")
        && message.contains("expected to be from READ_HEADERS")
}

#[cfg(target_os = "linux")]
fn install_linux_log_filters() {
    glib::log_set_handler(
        Some("libsoup-http2"),
        glib::LogLevels::LEVEL_WARNING,
        false,
        false,
        |domain, level, message| {
            if !should_suppress_libsoup_warning(domain, message) {
                glib::log_default_handler(domain, level, Some(message));
            }
        },
    );
}

// ── The desktop's own light/dark preference ───────────────────────────────
//
// On Linux the page's `prefers-color-scheme` is NOT a reading of the desktop:
// tao's `set_theme` writes `gtk-application-prefer-dark-theme` and WebKitGTK
// derives the media query from that same property, so once the window carries a
// pinned appearance the query only echoes the app's own choice. The xdg desktop
// portal's `org.freedesktop.appearance` / `color-scheme` is the desktop's
// answer, and nothing this app does can overwrite it — so it is what `auto`
// resolves from on a one-shot read. Live changes are the desktop_settings
// module's portal watcher.

/// The innermost D-Bus variant payload in a `gdbus` line: the text between the
/// last `<` and the `>` that closes it. `<uint32 1>` and the doubly-wrapped
/// `(<<uint32 1>>,)` a `Settings.Read` reply arrives in both yield `uint32 1`.
#[cfg(any(test, target_os = "linux"))]
fn variant_payload(text: &str) -> Option<&str> {
    let after = &text[text.rfind('<')? + 1..];
    Some(after[..after.find('>')?].trim())
}

/// A portal `color-scheme` value as light or dark. The standard key is a
/// `uint32` (0 no preference, 1 prefer dark, 2 prefer light); the
/// `org.gnome.desktop.interface` mirror of it is a string. "No preference" is
/// light, which is what every toolkit renders for it.
#[cfg(any(test, target_os = "linux"))]
fn color_scheme_value_to_theme(payload: &str) -> Option<&'static str> {
    match payload {
        "uint32 1" | "'prefer-dark'" => Some("dark"),
        "uint32 2" | "uint32 0" | "'prefer-light'" | "'default'" => Some("light"),
        _ => None,
    }
}

/// The desktop light/dark preference in a `Settings.Read` reply, or `None` when
/// the portal answered nothing usable (no portal, an error, an unknown value) —
/// in which case `auto` falls back rather than inventing a theme.
#[cfg(any(test, target_os = "linux"))]
fn desktop_theme_from_portal_read(reply: &str) -> Option<&'static str> {
    color_scheme_value_to_theme(variant_payload(reply)?)
}

/// Read the desktop's current light/dark preference.
///
/// `None` off Linux: macOS and Windows report the system appearance through the
/// window itself, and their `auto` leaves the window following the OS, so their
/// `prefers-color-scheme` is a signal they never overwrite. Only Linux needs a
/// channel the app cannot poison.
///
/// `async` + `blocking` because a sync command runs on the main thread, and the
/// Linux read spawns `gdbus` and waits for it — a D-Bus round trip per `auto`
/// resolve, five of them on one KDE theme flip, each of which would otherwise
/// stall the UI.
#[tauri::command]
pub(crate) async fn read_desktop_color_scheme() -> Option<String> {
    crate::background_tasks::blocking(|| Ok(read_desktop_color_scheme_blocking()))
        .await
        .unwrap_or_default()
}

#[cfg(target_os = "linux")]
fn read_desktop_color_scheme_blocking() -> Option<String> {
    let output = std::process::Command::new("gdbus")
        .args([
            "call",
            "--session",
            "--dest",
            "org.freedesktop.portal.Desktop",
            "--object-path",
            "/org/freedesktop/portal/desktop",
            "--method",
            "org.freedesktop.portal.Settings.Read",
            "org.freedesktop.appearance",
            "color-scheme",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let reply = String::from_utf8_lossy(&output.stdout);
    desktop_theme_from_portal_read(&reply).map(str::to_owned)
}

#[cfg(not(target_os = "linux"))]
fn read_desktop_color_scheme_blocking() -> Option<String> {
    None
}

#[cfg(target_os = "linux")]
pub(crate) fn linux_has_nvidia_gpu() -> bool {
    let drm_vendor_is_nvidia = std::fs::read_dir("/sys/class/drm")
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("card"))
        .filter_map(|entry| std::fs::read_to_string(entry.path().join("device/vendor")).ok())
        .any(|vendor| is_nvidia_drm_vendor(&vendor));

    if drm_vendor_is_nvidia {
        return true;
    }

    std::fs::read_to_string("/proc/modules")
        .map(|modules| has_nvidia_kernel_module(&modules))
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn configure_linux_renderer() {
    const WEBKIT_SOFTWARE_RENDER: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

    // Preserve an explicit WebKit setting. Otherwise retain the blank-window
    // workaround only for NVIDIA, with a distro/user escape hatch for machines
    // whose GPU cannot be identified reliably.
    if linux_should_set_software_render(
        std::env::var_os(WEBKIT_SOFTWARE_RENDER).is_some(),
        std::env::var_os("FUTO_NOTES_SOFTWARE_RENDER").as_deref(),
        linux_has_nvidia_gpu(),
    ) {
        std::env::set_var(WEBKIT_SOFTWARE_RENDER, "1");
    }
}

#[cfg(any(test, target_os = "linux"))]
pub(crate) fn linux_should_set_software_render(
    webkit_override_exists: bool,
    futo_override: Option<&std::ffi::OsStr>,
    has_nvidia_gpu: bool,
) -> bool {
    if webkit_override_exists {
        return false;
    }
    match futo_override.and_then(std::ffi::OsStr::to_str) {
        Some("1") => true,
        Some("0") => false,
        _ => has_nvidia_gpu,
    }
}

#[cfg(any(test, target_os = "linux"))]
fn is_nvidia_drm_vendor(vendor: &str) -> bool {
    vendor.trim().eq_ignore_ascii_case("0x10de")
}

#[cfg(any(test, target_os = "linux"))]
fn has_nvidia_kernel_module(modules: &str) -> bool {
    modules.lines().any(|line| {
        line.split_ascii_whitespace()
            .next()
            .is_some_and(|module| module == "nvidia")
    })
}

#[cfg(unix)]
fn raise_fd_limit() {
    unsafe {
        let mut limit: libc::rlimit = std::mem::zeroed();
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) == 0 {
            let target = limit.rlim_max.min(10_240);
            if limit.rlim_cur < target {
                limit.rlim_cur = target;
                libc::setrlimit(libc::RLIMIT_NOFILE, &limit);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    //! Tests for operating-system integration policy.
    use super::*;

    #[test]
    fn warning_filter_is_narrow() {
        let warning =
            "Unexpected state changed WRITE_DATA -> READ_DATA_START, expected to be from READ_HEADERS";
        assert!(should_suppress_libsoup_warning(
            Some("libsoup-http2"),
            warning
        ));
        assert!(!should_suppress_libsoup_warning(
            Some("webkit2gtk"),
            warning
        ));
        assert!(!should_suppress_libsoup_warning(
            Some("libsoup-http2"),
            "different warning"
        ));
    }

    #[test]
    fn reads_the_settings_read_reply() {
        assert_eq!(
            desktop_theme_from_portal_read("(<<uint32 1>>,)\n"),
            Some("dark")
        );
        assert_eq!(
            desktop_theme_from_portal_read("(<<uint32 2>>,)\n"),
            Some("light")
        );
        assert_eq!(
            desktop_theme_from_portal_read("(<<uint32 0>>,)\n"),
            Some("light")
        );
        assert_eq!(
            desktop_theme_from_portal_read("(<<'prefer-dark'>>,)\n"),
            Some("dark")
        );
        // A desktop with no portal answers nothing usable; `auto` must fall
        // back rather than invent a theme.
        assert_eq!(desktop_theme_from_portal_read(""), None);
        assert_eq!(
            desktop_theme_from_portal_read(
                "Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown"
            ),
            None
        );
    }

    #[test]
    fn recognizes_nvidia_drm_vendor_case_and_whitespace() {
        assert!(is_nvidia_drm_vendor("0x10de\n"));
        assert!(is_nvidia_drm_vendor("  0X10DE  "));
        assert!(!is_nvidia_drm_vendor("0x1002\n"));
        assert!(!is_nvidia_drm_vendor("0x8086\n"));
    }

    #[test]
    fn recognizes_only_the_base_nvidia_kernel_module() {
        assert!(has_nvidia_kernel_module(
            "nvidia_uvm 1 0 - Live 0x0\nnvidia 2 1 nvidia_uvm, Live 0x0\n"
        ));
        assert!(!has_nvidia_kernel_module(
            "nvidia_uvm 1 0 - Live 0x0\nnouveau 2 1 - Live 0x0\n"
        ));
    }

    #[test]
    fn renderer_policy_preserves_webkit_and_honors_both_explicit_overrides() {
        use std::ffi::OsStr;

        assert!(!linux_should_set_software_render(
            true,
            Some(OsStr::new("1")),
            true
        ));
        assert!(linux_should_set_software_render(
            false,
            Some(OsStr::new("1")),
            false
        ));
        assert!(!linux_should_set_software_render(
            false,
            Some(OsStr::new("0")),
            true
        ));
        assert!(linux_should_set_software_render(false, None, true));
        assert!(!linux_should_set_software_render(false, None, false));
    }
}
