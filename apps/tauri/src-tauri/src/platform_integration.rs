//! Operating-system startup integration, isolated from application composition.

use tauri::Manager;

#[cfg(target_os = "linux")]
use tauri::Emitter;

pub(crate) fn prepare_process() {
    #[cfg(unix)]
    raise_fd_limit();
    #[cfg(target_os = "linux")]
    install_linux_log_filters();
}

pub(crate) fn is_flatpak() -> bool {
    std::path::Path::new("/.flatpak-info").exists()
}

pub(crate) fn configure_app(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(desktop)]
    if std::env::var("FUTO_NOTES_MULTI_INSTANCE").is_err() {
        app.plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _cwd| {
                if let Some(window) = app.get_webview_window("main") {
                    // The window starts hidden (window_reveal): a second launch
                    // during that gap must reveal it, not just focus a window
                    // nobody can see.
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            },
        ))?;
    }

    #[cfg(target_os = "linux")]
    {
        if let Some(window) = app.get_webview_window("main") {
            window.set_decorations(false)?;
        }
        let app = app.clone();
        crate::background_tasks::spawn("futo-linux-theme", move || watch_linux_theme(app))?;
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
// answer, and nothing this app does can overwrite it — so it is the signal a
// desktop light/dark change has to be read from.

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

/// The next single-quoted token in `text`, plus whatever follows it.
#[cfg(any(test, target_os = "linux"))]
fn next_quoted(text: &str) -> Option<(&str, &str)> {
    let after = &text[text.find('\'')? + 1..];
    let end = after.find('\'')?;
    Some((&after[..end], &after[end + 1..]))
}

/// The desktop light/dark preference a portal `SettingChanged` line announces,
/// or `None` for a line this app must not interpret as a theme.
///
/// One theme change is a BURST of signals, so a line may not be read loosely:
/// applying BreezeDark on KDE also emits `accent-color` (a colour triple) and
/// `('org.kde.kdeglobals.General', 'ColorScheme', <'BreezeDark'>)` — a scheme
/// NAME whose text contains "dark" while its light counterpart contains no
/// "light". Only the namespace/key pairs below carry the answer, and both
/// spellings of the value have to be read, or the string form is silently
/// misread as the opposite theme and the burst disagrees with itself.
#[cfg(any(test, target_os = "linux"))]
fn desktop_theme_from_setting_changed(line: &str) -> Option<&'static str> {
    if !line.contains("SettingChanged") {
        return None;
    }
    let (namespace, rest) = next_quoted(line.split_once("SettingChanged")?.1)?;
    if namespace != "org.freedesktop.appearance" && namespace != "org.gnome.desktop.interface" {
        return None;
    }
    let (key, value) = next_quoted(rest)?;
    if key != "color-scheme" {
        return None;
    }
    color_scheme_value_to_theme(variant_payload(value)?)
}

#[cfg(target_os = "linux")]
fn watch_linux_theme(app: tauri::AppHandle) {
    use std::io::BufRead;
    use std::process::{Command, Stdio};

    let Ok(mut child) = Command::new("gdbus")
        .args([
            "monitor",
            "--session",
            "--dest",
            "org.freedesktop.portal.Desktop",
            "--object-path",
            "/org/freedesktop/portal/desktop",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return;
    };
    let Some(stdout) = child.stdout.take() else {
        return;
    };

    for line in std::io::BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        if let Some(theme) = desktop_theme_from_setting_changed(&line) {
            let _ = app.emit("linux-theme-changed", theme);
        }
    }
    let _ = child.kill();
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

    // Every line below was captured verbatim from
    //   gdbus monitor --session --dest org.freedesktop.portal.Desktop \
    //     --object-path /org/freedesktop/portal/desktop
    // on Fedora 44 / KDE Plasma 6.7.4 (Wayland) while applying BreezeDark.
    // Those six lines are ONE user action, so every line this app interprets
    // has to agree — the app cannot depend on which of them arrives last.
    const KDE_DARK_BURST: &[&str] = &[
        "/org/freedesktop/portal/desktop: org.freedesktop.portal.Settings.SettingChanged ('org.freedesktop.appearance', 'color-scheme', <uint32 1>)",
        "/org/freedesktop/portal/desktop: org.freedesktop.portal.Settings.SettingChanged ('org.freedesktop.appearance', 'accent-color', <(0.23921568691730499, 0.68235296010971069, 0.91372549533843994)>)",
        "/org/freedesktop/portal/desktop: org.freedesktop.portal.Settings.SettingChanged ('org.kde.kdeglobals.General', 'ColorScheme', <'BreezeDark'>)",
        "/org/freedesktop/portal/desktop: org.freedesktop.portal.Settings.SettingChanged ('org.gnome.desktop.interface', 'color-scheme', <'prefer-dark'>)",
        "/org/freedesktop/portal/desktop: org.freedesktop.portal.Settings.SettingChanged ('org.freedesktop.appearance', 'color-scheme', <uint32 1>)",
    ];

    #[test]
    fn reads_the_standard_appearance_color_scheme() {
        assert_eq!(
            desktop_theme_from_setting_changed(KDE_DARK_BURST[0]),
            Some("dark")
        );
        assert_eq!(
            desktop_theme_from_setting_changed(
                "/org/freedesktop/portal/desktop: org.freedesktop.portal.Settings.SettingChanged ('org.freedesktop.appearance', 'color-scheme', <uint32 2>)"
            ),
            Some("light")
        );
        // 0 is "no preference", which every toolkit renders light.
        assert_eq!(
            desktop_theme_from_setting_changed(
                "/org/freedesktop/portal/desktop: org.freedesktop.portal.Settings.SettingChanged ('org.freedesktop.appearance', 'color-scheme', <uint32 0>)"
            ),
            Some("light")
        );
    }

    // The bug: `color-scheme` also arrives as a STRING with no `uint32` in it,
    // so keying on "uint32 1" read a dark desktop as light. The burst then
    // delivered dark, dark, light, dark and self-corrected only because a dark
    // line happened to be last.
    #[test]
    fn reads_the_string_form_of_color_scheme() {
        assert_eq!(
            desktop_theme_from_setting_changed(KDE_DARK_BURST[3]),
            Some("dark")
        );
        assert_eq!(
            desktop_theme_from_setting_changed(
                "/org/freedesktop/portal/desktop: org.freedesktop.portal.Settings.SettingChanged ('org.gnome.desktop.interface', 'color-scheme', <'prefer-light'>)"
            ),
            Some("light")
        );
        assert_eq!(
            desktop_theme_from_setting_changed(
                "/org/freedesktop/portal/desktop: org.freedesktop.portal.Settings.SettingChanged ('org.gnome.desktop.interface', 'color-scheme', <'default'>)"
            ),
            Some("light")
        );
    }

    #[test]
    fn ignores_settings_that_are_not_the_desktop_color_scheme() {
        // An accent colour says nothing about light vs dark.
        assert_eq!(desktop_theme_from_setting_changed(KDE_DARK_BURST[1]), None);
        // KDE's own scheme NAME is a trap in both directions: the key is
        // `ColorScheme`, not `color-scheme`, and the value "BreezeDark"
        // contains "dark" while "BreezeLight" does not contain "light".
        assert_eq!(desktop_theme_from_setting_changed(KDE_DARK_BURST[2]), None);
        assert_eq!(
            desktop_theme_from_setting_changed(
                "/org/freedesktop/portal/desktop: org.freedesktop.portal.Settings.SettingChanged ('org.kde.kdeglobals.General', 'ColorScheme', <'BreezeLight'>)"
            ),
            None
        );
        assert_eq!(
            desktop_theme_from_setting_changed("not a signal at all"),
            None
        );
    }

    // The regression that matters: one user action must not produce
    // disagreeing answers, whatever order the portal emits them in.
    #[test]
    fn the_whole_kde_dark_burst_agrees_on_dark() {
        let interpreted: Vec<&'static str> = KDE_DARK_BURST
            .iter()
            .filter_map(|line| desktop_theme_from_setting_changed(line))
            .collect();
        assert!(!interpreted.is_empty(), "the burst must be readable at all");
        assert!(
            interpreted.iter().all(|theme| *theme == "dark"),
            "a dark desktop produced {interpreted:?}"
        );
    }
}
