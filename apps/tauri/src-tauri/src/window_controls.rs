//! Linux custom window-control placement and GNOME layout parsing.

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum WindowControl {
    Minimize,
    Maximize,
    Close,
}

impl WindowControl {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "minimize" => Some(Self::Minimize),
            "maximize" => Some(Self::Maximize),
            "close" => Some(Self::Close),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowControlsLayout {
    left: Vec<WindowControl>,
    right: Vec<WindowControl>,
}

fn default_layout() -> WindowControlsLayout {
    WindowControlsLayout {
        left: Vec::new(),
        right: vec![
            WindowControl::Minimize,
            WindowControl::Maximize,
            WindowControl::Close,
        ],
    }
}

fn parse_group(group: &str) -> Vec<WindowControl> {
    group
        .split(',')
        .map(str::trim)
        .filter_map(WindowControl::parse)
        .collect()
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

    let layout = WindowControlsLayout {
        left: parse_group(left),
        right: parse_group(right),
    };
    if layout
        .left
        .iter()
        .chain(&layout.right)
        .any(|button| *button == WindowControl::Close)
    {
        return layout;
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
                left: vec![],
                right: vec![
                    WindowControl::Minimize,
                    WindowControl::Maximize,
                    WindowControl::Close,
                ],
            }
        );
    }

    #[test]
    fn parses_leading_gnome_buttons_in_order() {
        assert_eq!(
            parse_button_layout("close,minimize,maximize:appmenu"),
            WindowControlsLayout {
                left: vec![
                    WindowControl::Close,
                    WindowControl::Minimize,
                    WindowControl::Maximize,
                ],
                right: vec![],
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

    #[test]
    fn split_layout_keeps_every_supported_button() {
        let layout = parse_button_layout("close,appmenu:minimize,maximize");

        assert_eq!(layout.left, vec![WindowControl::Close]);
        assert_eq!(
            layout.right,
            vec![WindowControl::Minimize, WindowControl::Maximize]
        );
    }
}
