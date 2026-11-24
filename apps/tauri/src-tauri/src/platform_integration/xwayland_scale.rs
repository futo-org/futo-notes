//! The app's scale under XWayland, taken from the compositor rather than from the X11 DPI.
//!
//! An X11 app on a Wayland session draws at the scale the desktop publishes to X11 apps
//! (XSETTINGS: a whole-number window scale times the font DPI over 96). KDE with "apply scaling
//! themselves" is meant to publish its display scale there, but can publish 96 DPI on a 1.6x
//! display, and then the window and its text are drawn at 1x: tiny. So before GTK draws
//! anything, the scale X11 would give is compared with the one the compositor reports for its
//! displays, and when they differ the process is started again with `GDK_DPI_SCALE` making up
//! the difference. GTK reads that variable only as it starts, which is why it is a restart.

use wayland_client::globals::{registry_queue_init, GlobalListContents};
use wayland_client::protocol::{wl_output, wl_registry};
use wayland_client::{Connection, Dispatch, QueueHandle, WEnum};
use wayland_protocols::xdg::xdg_output::zv1::client::{zxdg_output_manager_v1, zxdg_output_v1};

/// Starts the process again with a corrected `GDK_DPI_SCALE` when X11 would draw at a scale
/// the compositor does not use. Does nothing off XWayland, when the user set `GDK_SCALE` or
/// `GDK_DPI_SCALE` (or an earlier pass of this did), or when either scale cannot be read.
pub(crate) fn correct_xwayland_scale() {
    if std::env::var_os("WAYLAND_DISPLAY").is_none()
        || std::env::var_os("GDK_SCALE").is_some()
        || std::env::var_os("GDK_DPI_SCALE").is_some()
        || !tries_x11_first(std::env::var("GDK_BACKEND").ok().as_deref())
    {
        return;
    }
    let Some(compositor) = compositor_scale() else {
        return;
    };
    let Some(x11) = x11_scale() else {
        return;
    };
    let Some(correction) = dpi_scale_correction(compositor, x11) else {
        return;
    };
    std::env::set_var("GDK_DPI_SCALE", format!("{correction:.4}"));
    restart();
}

fn tries_x11_first(gdk_backend: Option<&str>) -> bool {
    gdk_backend.is_some_and(|value| value.split(',').next().map(str::trim) == Some("x11"))
}

/// The `GDK_DPI_SCALE` that turns the scale X11 gives into the compositor's, or `None` when
/// they already agree (within 2%, the rounding the desktop's own DPI value carries).
fn dpi_scale_correction(compositor: f64, x11: f64) -> Option<f64> {
    if !(compositor.is_finite() && x11.is_finite() && compositor > 0.0 && x11 > 0.0) {
        return None;
    }
    let ratio = compositor / x11;
    ((ratio - 1.0).abs() >= 0.02).then_some(ratio)
}

/// One display's scale: its current mode in pixels over its size in the compositor's logical
/// units. Longer side over longer side, so a rotated display reads the same.
fn output_scale(mode: (i32, i32), logical: (i32, i32)) -> Option<f64> {
    let pixels = mode.0.max(mode.1);
    let units = logical.0.max(logical.1);
    (pixels > 0 && units > 0).then(|| f64::from(pixels) / f64::from(units))
}

/// The scale X11 gives a GTK window: the window scale times the font DPI over 96, as GTK
/// itself reads them. GTK is started here; the app's own start then finds it running.
fn x11_scale() -> Option<f64> {
    use gtk::gdk::prelude::MonitorExt;
    let display = x11_display()?;
    let monitor = display.primary_monitor().or_else(|| display.monitor(0))?;
    Some(f64::from(monitor.scale_factor()) * x11_dpi()? / 96.0)
}

/// GTK's display once GTK is started, when it is an X11 one.
fn x11_display() -> Option<gtk::gdk::Display> {
    use gtk::glib::object::ObjectExt;
    gtk::init().ok()?;
    let display = gtk::gdk::Display::default()?;
    (display.type_().name() == "GdkX11Display").then_some(display)
}

/// The font DPI GTK uses, 96 when the desktop sets none.
fn x11_dpi() -> Option<f64> {
    let resolution = gtk::gdk::Screen::default()?.resolution();
    Some(if resolution > 0.0 { resolution } else { 96.0 })
}

/// How many screen pixels one CSS pixel takes under X11: the font DPI over 96, the part of the
/// page's scale that GTK's screen-pixel window sizes do not already carry. `None` on Wayland
/// or when it is 1.
pub(crate) fn x11_css_scale() -> Option<f64> {
    x11_display()?;
    let factor = x11_dpi()? / 96.0;
    ((factor - 1.0).abs() >= 0.02).then_some(factor)
}

#[derive(Default)]
struct Outputs {
    modes: Vec<Option<(i32, i32)>>,
    logical: Vec<Option<(i32, i32)>>,
}

/// The largest scale among the compositor's displays: X11 has one scale for every display, and
/// the largest is the one KDE's XWayland is drawn for.
fn compositor_scale() -> Option<f64> {
    let connection = Connection::connect_to_env().ok()?;
    let (globals, mut queue) = registry_queue_init::<Outputs>(&connection).ok()?;
    let handle = queue.handle();
    let manager: zxdg_output_manager_v1::ZxdgOutputManagerV1 =
        globals.bind(&handle, 1..=3, ()).ok()?;
    let outputs: Vec<(u32, u32)> = globals.contents().with_list(|list| {
        list.iter()
            .filter(|global| global.interface == "wl_output")
            .map(|global| (global.name, global.version))
            .collect()
    });
    let mut state = Outputs {
        modes: vec![None; outputs.len()],
        logical: vec![None; outputs.len()],
    };
    for (index, (name, version)) in outputs.into_iter().enumerate() {
        let output: wl_output::WlOutput =
            globals
                .registry()
                .bind(name, version.min(4), &handle, index);
        manager.get_xdg_output(&output, &handle, index);
    }
    queue.roundtrip(&mut state).ok()?;
    queue.roundtrip(&mut state).ok()?;
    state
        .modes
        .iter()
        .zip(&state.logical)
        .filter_map(|(mode, logical)| output_scale((*mode)?, (*logical)?))
        .reduce(f64::max)
}

fn restart() {
    use std::os::unix::process::CommandExt;
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    // `exec` returns only on failure; the app then starts at the scale X11 gives.
    let _ = std::process::Command::new(exe)
        .args(std::env::args_os().skip(1))
        .exec();
}

impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for Outputs {
    fn event(
        _: &mut Self,
        _: &wl_registry::WlRegistry,
        _: wl_registry::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<wl_output::WlOutput, usize> for Outputs {
    fn event(
        state: &mut Self,
        _: &wl_output::WlOutput,
        event: wl_output::Event,
        index: &usize,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wl_output::Event::Mode {
            flags: WEnum::Value(flags),
            width,
            height,
            ..
        } = event
        {
            if flags.contains(wl_output::Mode::Current) {
                state.modes[*index] = Some((width, height));
            }
        }
    }
}

impl Dispatch<zxdg_output_manager_v1::ZxdgOutputManagerV1, ()> for Outputs {
    fn event(
        _: &mut Self,
        _: &zxdg_output_manager_v1::ZxdgOutputManagerV1,
        _: zxdg_output_manager_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<zxdg_output_v1::ZxdgOutputV1, usize> for Outputs {
    fn event(
        state: &mut Self,
        _: &zxdg_output_v1::ZxdgOutputV1,
        event: zxdg_output_v1::Event,
        index: &usize,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let zxdg_output_v1::Event::LogicalSize { width, height } = event {
            state.logical[*index] = Some((width, height));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_96_dpi_x11_on_a_1_6x_display_is_corrected_to_1_6() {
        let correction =
            dpi_scale_correction(output_scale((3840, 2160), (2400, 1350)).unwrap(), 1.0);
        assert!((correction.unwrap() - 1.6).abs() < 1e-9);
    }

    #[test]
    fn a_published_dpi_that_matches_the_display_is_left_alone() {
        // KDE's 1.6x as GTK reads it: 157286 / 1024 DPI.
        assert_eq!(dpi_scale_correction(1.6, 157_286.0 / 1024.0 / 96.0), None);
        assert_eq!(dpi_scale_correction(2.0, 2.0), None);
    }

    #[test]
    fn a_rotated_display_reads_its_scale_the_same() {
        assert_eq!(output_scale((2160, 3840), (1350, 2400)), Some(1.6));
    }

    #[test]
    fn only_an_x11_first_backend_is_corrected() {
        assert!(tries_x11_first(Some("x11")));
        assert!(tries_x11_first(Some("x11,wayland")));
        assert!(!tries_x11_first(Some("wayland,x11")));
        assert!(!tries_x11_first(Some("wayland")));
        assert!(!tries_x11_first(None));
    }
}
