//! Linux custom window-control placement and GNOME layout parsing.

use serde::Serialize;

const DEFAULT_BUTTONS: [&str; 3] = ["minimize", "maximize", "close"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum WindowControlsSide {
    Left,
    Right,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowControlsLayout {
    side: WindowControlsSide,
    buttons: Vec<String>,
}

fn default_layout() -> WindowControlsLayout {
    WindowControlsLayout {
        side: WindowControlsSide::Right,
        buttons: DEFAULT_BUTTONS.iter().map(ToString::to_string).collect(),
    }
}

fn parse_button_layout(raw: &str) -> WindowControlsLayout {
    let unquoted = raw
        .trim()
        .strip_prefix('\'')
        .and_then(|value| value.strip_suffix('\''))
        .unwrap_or_else(|| raw.trim());
    let Some((left, right)) = unquoted.split_once(':') else {
        return default_layout();
    };

    for (side, group) in [
        (WindowControlsSide::Left, left),
        (WindowControlsSide::Right, right),
    ] {
        let buttons: Vec<String> = group
            .split(',')
            .map(str::trim)
            .filter(|button| DEFAULT_BUTTONS.contains(button))
            .map(ToString::to_string)
            .collect();
        if buttons.iter().any(|button| button == "close") {
            return WindowControlsLayout { side, buttons };
        }
    }

    default_layout()
}

#[cfg(target_os = "linux")]
fn is_gnome_desktop() -> bool {
    std::env::var("XDG_CURRENT_DESKTOP")
        .map(|desktop| {
            desktop
                .split(':')
                .any(|name| name.trim().eq_ignore_ascii_case("gnome"))
        })
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn read_layout() -> WindowControlsLayout {
    if !is_gnome_desktop() {
        return default_layout();
    }

    std::process::Command::new("gsettings")
        .args(["get", "org.gnome.desktop.wm.preferences", "button-layout"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|raw| parse_button_layout(&raw))
        .unwrap_or_else(default_layout)
}

#[tauri::command]
pub(crate) async fn window_controls_layout() -> Result<WindowControlsLayout, String> {
    #[cfg(target_os = "linux")]
    {
        return crate::background_tasks::blocking(|| Ok(read_layout())).await;
    }

    #[cfg(not(target_os = "linux"))]
    Ok(default_layout())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_trailing_gnome_buttons_in_order() {
        assert_eq!(
            parse_button_layout("'appmenu:minimize,maximize,close'\n"),
            WindowControlsLayout {
                side: WindowControlsSide::Right,
                buttons: vec!["minimize".into(), "maximize".into(), "close".into()],
            }
        );
    }

    #[test]
    fn parses_leading_gnome_buttons_in_order() {
        assert_eq!(
            parse_button_layout("close,minimize,maximize:appmenu"),
            WindowControlsLayout {
                side: WindowControlsSide::Left,
                buttons: vec!["close".into(), "minimize".into(), "maximize".into()],
            }
        );
    }

    #[test]
    fn empty_layout_uses_the_trailing_default() {
        assert_eq!(parse_button_layout(""), default_layout());
    }

    #[test]
    fn layout_without_close_uses_the_trailing_default() {
        assert_eq!(
            parse_button_layout("minimize,maximize:appmenu"),
            default_layout()
        );
    }
}
