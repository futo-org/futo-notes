//! Linux desktop appearance settings from the xdg-desktop-portal D-Bus API.

use serde::Serialize;

#[cfg(target_os = "linux")]
use tauri::Emitter;
#[cfg(target_os = "linux")]
use zbus::zvariant::{OwnedValue, Value};

#[cfg(target_os = "linux")]
const PORTAL_DESTINATION: &str = "org.freedesktop.portal.Desktop";
#[cfg(target_os = "linux")]
const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";
#[cfg(target_os = "linux")]
const SETTINGS_INTERFACE: &str = "org.freedesktop.portal.Settings";
#[cfg(target_os = "linux")]
const APPEARANCE_NAMESPACE: &str = "org.freedesktop.appearance";
#[cfg(target_os = "linux")]
const COLOR_SCHEME_KEY: &str = "color-scheme";
#[cfg(target_os = "linux")]
const ACCENT_COLOR_KEY: &str = "accent-color";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ColorScheme {
    Light,
    Dark,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Accent {
    None,
    Rgb(f64, f64, f64),
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccentColor {
    r: f64,
    g: f64,
    b: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopSettingsSnapshot {
    theme: &'static str,
    accent: Option<AccentColor>,
    interface_font: &'static str,
}

fn interface_font_for(current_desktop: Option<&str>) -> &'static str {
    let is_plasma = current_desktop.is_some_and(|desktop| {
        desktop.split([':', ';']).any(|name| {
            let name = name.trim().to_ascii_lowercase();
            name.contains("kde") || name.contains("plasma")
        })
    });
    if is_plasma {
        // WebKitGTK 2.52 on Plasma resolves `system-ui` to GTK's Cantarell,
        // while the generic sans face resolves through Fontconfig to Plasma's
        // configured Noto Sans. GNOME's system-ui correctly follows GTK.
        "sansSerif"
    } else {
        "systemUi"
    }
}

#[cfg(target_os = "linux")]
fn parse_color_scheme(value: &Value<'_>) -> Option<ColorScheme> {
    match unwrap_variant(value) {
        Value::U32(1) => Some(ColorScheme::Dark),
        Value::U32(0 | 2) => Some(ColorScheme::Light),
        _ => None,
    }
}

#[cfg(target_os = "linux")]
fn parse_accent(value: &Value<'_>) -> Accent {
    let Ok((r, g, b)) = <(f64, f64, f64)>::try_from(unwrap_variant(value)) else {
        return Accent::None;
    };
    if [r, g, b]
        .into_iter()
        .all(|channel| (0.0..=1.0).contains(&channel))
    {
        Accent::Rgb(r, g, b)
    } else {
        Accent::None
    }
}

#[cfg(target_os = "linux")]
fn unwrap_variant<'a>(mut value: &'a Value<'a>) -> &'a Value<'a> {
    while let Value::Value(inner) = value {
        value = inner;
    }
    value
}

#[cfg(target_os = "linux")]
fn settings_proxy(
    connection: &zbus::blocking::Connection,
) -> Result<zbus::blocking::Proxy<'_>, zbus::Error> {
    zbus::blocking::Proxy::new(
        connection,
        PORTAL_DESTINATION,
        PORTAL_PATH,
        SETTINGS_INTERFACE,
    )
}

#[cfg(target_os = "linux")]
fn read_setting(proxy: &zbus::blocking::Proxy<'_>, key: &str) -> Result<OwnedValue, zbus::Error> {
    proxy
        .call("ReadOne", &(APPEARANCE_NAMESPACE, key))
        .or_else(|_| proxy.call("Read", &(APPEARANCE_NAMESPACE, key)))
}

#[cfg(target_os = "linux")]
fn read_snapshot(proxy: &zbus::blocking::Proxy<'_>) -> DesktopSettingsSnapshot {
    let theme = read_setting(proxy, COLOR_SCHEME_KEY)
        .ok()
        .as_deref()
        .and_then(parse_color_scheme)
        .unwrap_or(ColorScheme::Light);
    let accent = read_setting(proxy, ACCENT_COLOR_KEY)
        .ok()
        .as_deref()
        .map(parse_accent)
        .unwrap_or(Accent::None);

    DesktopSettingsSnapshot {
        theme: match theme {
            ColorScheme::Light => "light",
            ColorScheme::Dark => "dark",
        },
        accent: match accent {
            Accent::None => None,
            Accent::Rgb(r, g, b) => Some(AccentColor { r, g, b }),
        },
        interface_font: interface_font_for(std::env::var("XDG_CURRENT_DESKTOP").ok().as_deref()),
    }
}

#[cfg(target_os = "linux")]
fn connect_and_read() -> Result<DesktopSettingsSnapshot, String> {
    let connection = zbus::blocking::Connection::session().map_err(|error| error.to_string())?;
    let proxy = settings_proxy(&connection).map_err(|error| error.to_string())?;
    Ok(read_snapshot(&proxy))
}

#[tauri::command]
pub(crate) async fn linux_desktop_settings() -> Result<DesktopSettingsSnapshot, String> {
    #[cfg(target_os = "linux")]
    {
        return crate::background_tasks::blocking(connect_and_read).await;
    }

    #[cfg(not(target_os = "linux"))]
    Err("Linux desktop settings are unavailable on this platform".to_owned())
}

#[cfg(target_os = "linux")]
fn emit_snapshot(app: &tauri::AppHandle, snapshot: &DesktopSettingsSnapshot) {
    let _ = app.emit("linux-theme-changed", snapshot.theme);
    let _ = app.emit("linux-accent-changed", snapshot.accent);
}

#[cfg(target_os = "linux")]
pub(crate) fn watch(app: tauri::AppHandle) -> Result<(), String> {
    let connection = zbus::blocking::Connection::session().map_err(|error| error.to_string())?;
    let proxy = settings_proxy(&connection).map_err(|error| error.to_string())?;
    let mut changes = proxy
        .receive_signal("SettingChanged")
        .map_err(|error| error.to_string())?;

    emit_snapshot(&app, &read_snapshot(&proxy));

    for message in &mut changes {
        let body = message.body();
        let Ok((namespace, key, _value)) = body.deserialize::<(&str, &str, OwnedValue)>() else {
            continue;
        };
        if namespace == APPEARANCE_NAMESPACE && matches!(key, COLOR_SCHEME_KEY | ACCENT_COLOR_KEY) {
            emit_snapshot(&app, &read_snapshot(&proxy));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn parses_color_scheme_from_direct_and_read_wrapped_values() {
        assert_eq!(parse_color_scheme(&Value::U32(1)), Some(ColorScheme::Dark));
        assert_eq!(parse_color_scheme(&Value::U32(0)), Some(ColorScheme::Light));
        assert_eq!(parse_color_scheme(&Value::U32(2)), Some(ColorScheme::Light));
        assert_eq!(
            parse_color_scheme(&Value::Value(Box::new(Value::U32(1)))),
            Some(ColorScheme::Dark)
        );
        assert_eq!(parse_color_scheme(&Value::U32(3)), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn parses_accent_and_rejects_out_of_range_channels() {
        let direct = Value::from((0.25, 0.5, 0.75));
        assert_eq!(parse_accent(&direct), Accent::Rgb(0.25, 0.5, 0.75));

        let wrapped = Value::Value(Box::new(Value::from((0.1, 0.2, 0.3))));
        assert_eq!(parse_accent(&wrapped), Accent::Rgb(0.1, 0.2, 0.3));

        assert_eq!(parse_accent(&Value::from((-0.1, 0.2, 0.3))), Accent::None);
        assert_eq!(parse_accent(&Value::from((0.1, 1.2, 0.3))), Accent::None);
        assert_eq!(parse_accent(&Value::U32(1)), Accent::None);
    }

    #[test]
    fn chooses_the_native_generic_font_for_gnome_and_plasma() {
        assert_eq!(interface_font_for(Some("GNOME")), "systemUi");
        assert_eq!(interface_font_for(Some("ubuntu:GNOME")), "systemUi");
        assert_eq!(interface_font_for(Some("KDE")), "sansSerif");
        assert_eq!(interface_font_for(Some("X-KDE-Plasma")), "sansSerif");
        assert_eq!(interface_font_for(Some("KDE:wayland")), "sansSerif");
        assert_eq!(interface_font_for(None), "systemUi");
    }
}
