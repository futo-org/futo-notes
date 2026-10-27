//! Hold the window to its configured minimum size after a restored resize.
//!
//! `minWidth`/`minHeight` (tauri.conf.json) are applied when the window is
//! created, but tauri-plugin-window-state then restores the saved size with
//! `set_size`, and neither macOS (its `setContentSize:` landed at 640×420
//! with `minSize` and `contentMinSize` both set larger) nor Windows (tao answers
//! `WM_WINDOWPOSCHANGING` without the default min-size check) holds that to
//! the minimum. So a size saved before the minimum existed reopened below it
//! on every launch. Grow it back once that resize lands. GTK applies the
//! minimum itself, so on Linux this finds nothing to grow.

use tauri::{LogicalSize, Manager, WindowEvent};

pub(crate) fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    let WindowEvent::Resized(size) = event else {
        return;
    };
    // The OS owns the size of a minimized (0×0 on Windows), maximized or
    // fullscreen window; growing it would fight the OS.
    let os_sized = window.is_minimized().unwrap_or(true)
        || window.is_maximized().unwrap_or(true)
        || window.is_fullscreen().unwrap_or(true);
    if os_sized {
        return;
    }
    let app = window.app_handle();
    let Some(config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == window.label())
    else {
        return;
    };
    let Ok(scale_factor) = window.scale_factor() else {
        return;
    };
    if let Some(grown) = grown_to_minimum(
        size.to_logical(scale_factor),
        config.min_width,
        config.min_height,
    ) {
        let _ = window.set_size(grown);
    }
}

/// The size to grow to, or `None` when `size` already meets the minimum.
/// Within a pixel counts as meeting it: a fractional scale factor rounds the
/// grown size back a hair under the minimum, and treating that as too small
/// would resize forever.
fn grown_to_minimum(
    size: LogicalSize<f64>,
    min_width: Option<f64>,
    min_height: Option<f64>,
) -> Option<LogicalSize<f64>> {
    let too_narrow = min_width.filter(|&min| size.width < min - 1.0);
    let too_short = min_height.filter(|&min| size.height < min - 1.0);
    if too_narrow.is_none() && too_short.is_none() {
        return None;
    }
    Some(LogicalSize::new(
        too_narrow.unwrap_or(size.width),
        too_short.unwrap_or(size.height),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn size(width: f64, height: f64) -> LogicalSize<f64> {
        LogicalSize::new(width, height)
    }

    #[test]
    fn a_size_saved_below_the_minimum_grows_to_it() {
        assert_eq!(
            grown_to_minimum(size(640.0, 420.0), Some(800.0), Some(600.0)),
            Some(size(800.0, 600.0))
        );
    }

    #[test]
    fn only_the_short_side_grows() {
        assert_eq!(
            grown_to_minimum(size(1200.0, 420.0), Some(800.0), Some(600.0)),
            Some(size(1200.0, 600.0))
        );
        assert_eq!(
            grown_to_minimum(size(640.0, 900.0), Some(800.0), Some(600.0)),
            Some(size(800.0, 900.0))
        );
    }

    #[test]
    fn a_size_at_or_above_the_minimum_is_left_alone() {
        assert_eq!(
            grown_to_minimum(size(800.0, 600.0), Some(800.0), Some(600.0)),
            None
        );
        assert_eq!(
            grown_to_minimum(size(1200.0, 800.0), Some(800.0), Some(600.0)),
            None
        );
    }

    #[test]
    fn a_fractional_scale_rounding_under_the_minimum_does_not_resize_again() {
        assert_eq!(
            grown_to_minimum(size(799.43, 599.43), Some(800.0), Some(600.0)),
            None
        );
    }

    #[test]
    fn no_configured_minimum_never_resizes() {
        assert_eq!(grown_to_minimum(size(100.0, 100.0), None, None), None);
    }
}
