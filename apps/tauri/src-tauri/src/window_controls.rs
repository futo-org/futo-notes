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

    // macOS and Windows draw their own window buttons; an empty layout keeps
    // any caller from painting Linux controls over them.
    #[cfg(not(target_os = "linux"))]
    Ok(WindowControlsLayout {
        left: Vec::new(),
        right: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_button_layout_cases() {
        use WindowControl::{Close, Maximize, Minimize};
        let layout = |left: Vec<WindowControl>, right: Vec<WindowControl>| WindowControlsLayout {
            left,
            right,
        };

        for (setting, expected) in [
            (
                "'appmenu:minimize,maximize,close'\n",
                layout(vec![], vec![Minimize, Maximize, Close]),
            ),
            (
                "close,minimize,maximize:appmenu",
                layout(vec![Close, Minimize, Maximize], vec![]),
            ),
            (
                "close,appmenu:minimize,maximize",
                layout(vec![Close], vec![Minimize, Maximize]),
            ),
            // No close button, or no setting at all, falls back to the default.
            ("", default_layout()),
            ("minimize,maximize:appmenu", default_layout()),
        ] {
            assert_eq!(parse_button_layout(setting), expected, "{setting:?}");
        }
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn non_linux_command_reports_no_custom_controls() {
        let layout = tauri::async_runtime::block_on(window_controls_layout()).unwrap();

        assert!(layout.left.is_empty());
        assert!(layout.right.is_empty());
    }
}
