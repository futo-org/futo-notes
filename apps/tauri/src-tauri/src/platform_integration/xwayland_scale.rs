//! The app's scale under XWayland, taken from the compositor rather than from the X11 DPI.
//!
//! An X11 app on a Wayland session draws at the scale the desktop publishes to X11 apps
//! (XSETTINGS: a whole-number window scale times the font DPI over 96). KDE with "apply scaling
//! themselves" is meant to publish its display scale there, but can publish 96 DPI on a 1.6x
//! display, and then the window and its text are drawn at 1x: tiny. So before GTK draws
//! anything, the scale X11 would give is compared with the scale XWayland expects of its apps,
//! and when it falls short the process is started again with `GDK_DPI_SCALE` making up the
//! difference. GTK reads that variable only as it starts, which is why it is a restart.
//!
//! The expected scale is XWayland's own: each X11 monitor's width in pixels over the same
//! display's width in the compositor's logical units, matched by output name (or, for an older
//! XWayland that names its one output `XWAYLAND0`, the only display on each side). When the
//! compositor scales X11 windows itself (KDE "scaled by the system", GNOME by default) that is
//! 1 and nothing is corrected, whatever DPI the user chose. Only an X server that reports the
//! XWAYLAND extension is checked. A larger X11 scale (a user's text scaling) is never turned
//! down.

use std::sync::mpsc;
use std::time::Duration;

use wayland_client::globals::{registry_queue_init, GlobalListContents};
use wayland_client::protocol::{wl_output, wl_registry};
use wayland_client::{Connection, Dispatch, QueueHandle};
use wayland_protocols::xdg::xdg_output::zv1::client::{zxdg_output_manager_v1, zxdg_output_v1};

/// How long the compositor gets to list its displays before the check is dropped.
const COMPOSITOR_TIMEOUT: Duration = Duration::from_millis(500);

/// Starts the process again with a corrected `GDK_DPI_SCALE` when X11 would draw below the scale
/// XWayland expects. Does nothing off XWayland, when the user set `GDK_SCALE` or
/// `GDK_DPI_SCALE` (or an earlier pass of this did), when a launcher handed over a Wayland
/// socket GTK may need, or when either scale cannot be read.
pub(crate) fn correct_xwayland_scale() {
    if std::env::var_os("WAYLAND_DISPLAY").is_none()
        || std::env::var_os("WAYLAND_SOCKET").is_some()
        || std::env::var_os("GDK_SCALE").is_some()
        || std::env::var_os("GDK_DPI_SCALE").is_some()
        || !tries_x11_first(std::env::var("GDK_BACKEND").ok().as_deref())
    {
        return;
    }
    if !x_server_is_xwayland() {
        return;
    }
    let Some(logical) = compositor_outputs_within(COMPOSITOR_TIMEOUT) else {
        return;
    };
    // GTK takes the launcher's startup id out of the environment as it starts; the restart
    // hands it on so the launcher's busy cursor ends on the new window.
    let startup_id = std::env::var_os("DESKTOP_STARTUP_ID");
    let Some((x11, monitors)) = x11_scale_and_monitors() else {
        return;
    };
    let Some(expected) = xwayland_scale(&monitors, &logical) else {
        return;
    };
    let Some(correction) = dpi_scale_correction(expected, x11) else {
        return;
    };
    std::env::set_var("GDK_DPI_SCALE", format!("{correction:.4}"));
    if let Some(startup_id) = startup_id {
        std::env::set_var("DESKTOP_STARTUP_ID", startup_id);
    }
    restart();
}

fn tries_x11_first(gdk_backend: Option<&str>) -> bool {
    gdk_backend.is_some_and(|value| value.split(',').next().map(str::trim) == Some("x11"))
}

/// The `GDK_DPI_SCALE` that raises the scale X11 gives to the one XWayland expects, or `None`
/// when X11 already reaches it (within 2%, the rounding the desktop's own DPI value carries) or
/// XWayland expects 1x, where the compositor scales X11 windows and the DPI is the user's.
fn dpi_scale_correction(expected: f64, x11: f64) -> Option<f64> {
    if !(expected.is_finite() && x11.is_finite() && expected >= 1.02 && x11 > 0.0) {
        return None;
    }
    let ratio = expected / x11;
    (ratio >= 1.02).then_some(ratio)
}

/// A display as one side reports it: its output name and size (pixels for X11, logical units
/// for the compositor).
#[derive(Clone, Debug, PartialEq)]
struct Display {
    name: String,
    size: (i32, i32),
}

/// XWayland's scale: the largest, over displays both sides name, of the X11 pixels over the
/// compositor's logical units. Longer side over longer side, so a rotated display reads the
/// same. `None` when no display matches.
fn xwayland_scale(x11: &[Display], compositor: &[Display]) -> Option<f64> {
    let scale = |monitor: &Display, output: &Display| {
        let pixels = monitor.size.0.max(monitor.size.1);
        let units = output.size.0.max(output.size.1);
        (pixels > 0 && units > 0).then(|| f64::from(pixels) / f64::from(units))
    };
    if let ([monitor], [output]) = (x11, compositor) {
        if monitor.name.starts_with("XWAYLAND") {
            return scale(monitor, output);
        }
    }
    x11.iter()
        .filter_map(|monitor| {
            let output = compositor
                .iter()
                .find(|output| output.name == monitor.name)?;
            scale(monitor, output)
        })
        .reduce(f64::max)
}

/// Whether the X server `DISPLAY` names is an XWayland, which reports the XWAYLAND extension;
/// another X server reached from a Wayland session is left as it is.
fn x_server_is_xwayland() -> bool {
    use x11rb::protocol::xproto::ConnectionExt;
    let Ok((connection, _)) = x11rb::connect(None) else {
        return false;
    };
    connection
        .query_extension(b"XWAYLAND")
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .is_some_and(|reply| reply.present)
}

/// The scale X11 gives a GTK window (the window scale times the font DPI over 96, as GTK itself
/// reads them) and its monitors in pixels, named by their RandR outputs. GTK is started here;
/// the app's own start then finds it running.
fn x11_scale_and_monitors() -> Option<(f64, Vec<Display>)> {
    use gtk::gdk::prelude::MonitorExt;
    let display = x11_display()?;
    let monitors: Vec<_> = (0..display.n_monitors())
        .filter_map(|index| display.monitor(index))
        .collect();
    let window_scale = monitors.first()?.scale_factor();
    let named = monitors
        .iter()
        .filter_map(|monitor| {
            let geometry = monitor.geometry();
            let scale = monitor.scale_factor();
            Some(Display {
                name: monitor.model()?.to_string(),
                size: (geometry.width() * scale, geometry.height() * scale),
            })
        })
        .collect();
    Some((f64::from(window_scale) * x11_dpi()? / 96.0, named))
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
    names: Vec<Option<String>>,
    logical: Vec<Option<(i32, i32)>>,
}

/// The compositor's displays, asked on a thread so a compositor that never answers costs
/// `timeout`, not the launch.
fn compositor_outputs_within(timeout: Duration) -> Option<Vec<Display>> {
    let (sender, receiver) = mpsc::channel();
    std::thread::Builder::new()
        .name("xwayland-scale".into())
        .spawn(move || {
            let _ = sender.send(compositor_outputs());
        })
        .ok()?;
    receiver.recv_timeout(timeout).ok().flatten()
}

/// Each display's xdg-output name and logical size.
fn compositor_outputs() -> Option<Vec<Display>> {
    let connection = Connection::connect_to_env().ok()?;
    let (globals, mut queue) = registry_queue_init::<Outputs>(&connection).ok()?;
    let handle = queue.handle();
    // Version 2 is the first that names a display.
    let manager: zxdg_output_manager_v1::ZxdgOutputManagerV1 =
        globals.bind(&handle, 2..=3, ()).ok()?;
    let outputs: Vec<(u32, u32)> = globals.contents().with_list(|list| {
        list.iter()
            .filter(|global| global.interface == "wl_output")
            .map(|global| (global.name, global.version))
            .collect()
    });
    let mut state = Outputs {
        names: vec![None; outputs.len()],
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
    Some(
        state
            .names
            .into_iter()
            .zip(state.logical)
            .filter_map(|(name, size)| {
                Some(Display {
                    name: name?,
                    size: size?,
                })
            })
            .collect(),
    )
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
        _: &mut Self,
        _: &wl_output::WlOutput,
        _: wl_output::Event,
        _: &usize,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
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
        match event {
            zxdg_output_v1::Event::LogicalSize { width, height } => {
                state.logical[*index] = Some((width, height));
            }
            zxdg_output_v1::Event::Name { name } => state.names[*index] = Some(name),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display(name: &str, size: (i32, i32)) -> Display {
        Display {
            name: name.into(),
            size,
        }
    }

    #[test]
    fn a_96_dpi_x11_where_xwayland_expects_1_6x_is_raised_to_1_6() {
        let expected = xwayland_scale(
            &[display("HDMI-A-1", (3840, 2160))],
            &[display("HDMI-A-1", (2400, 1350))],
        )
        .unwrap();
        assert!((dpi_scale_correction(expected, 1.0).unwrap() - 1.6).abs() < 1e-9);
    }

    #[test]
    fn a_compositor_that_scales_x11_itself_expects_1x_and_nothing_is_corrected() {
        // KDE "scaled by the system": XWayland's monitor is the logical size.
        let expected = xwayland_scale(
            &[display("HDMI-A-1", (2400, 1350))],
            &[display("HDMI-A-1", (2400, 1350))],
        )
        .unwrap();
        assert_eq!(dpi_scale_correction(expected, 1.0), None);
    }

    #[test]
    fn a_published_dpi_that_matches_is_left_alone() {
        // KDE's 1.6x as GTK reads it: 157286 / 1024 DPI.
        assert_eq!(dpi_scale_correction(1.6, 157_286.0 / 1024.0 / 96.0), None);
    }

    #[test]
    fn a_larger_x11_scale_from_text_scaling_is_never_turned_down() {
        assert_eq!(dpi_scale_correction(1.0, 1.25), None);
    }

    #[test]
    fn an_x_server_that_shares_no_display_names_is_not_xwayland() {
        assert_eq!(
            xwayland_scale(
                &[display("default", (1920, 1080))],
                &[display("HDMI-A-1", (2400, 1350))]
            ),
            None
        );
    }

    #[test]
    fn a_rotated_display_and_the_largest_of_several_are_read() {
        let expected = xwayland_scale(
            &[display("DP-1", (2160, 3840)), display("DP-2", (1920, 1080))],
            &[display("DP-1", (1350, 2400)), display("DP-2", (1920, 1080))],
        );
        assert_eq!(expected, Some(1.6));
    }

    #[test]
    fn where_xwayland_expects_1x_a_smaller_dpi_the_user_chose_stays() {
        assert_eq!(dpi_scale_correction(1.0, 90.0 / 96.0), None);
    }

    #[test]
    fn an_older_xwayland_s_one_unnamed_output_pairs_with_the_one_display() {
        assert_eq!(
            xwayland_scale(
                &[display("XWAYLAND0", (3840, 2160))],
                &[display("DP-1", (2400, 1350))]
            ),
            Some(1.6)
        );
        assert_eq!(
            xwayland_scale(
                &[
                    display("XWAYLAND0", (3840, 2160)),
                    display("XWAYLAND1", (1920, 1080))
                ],
                &[display("DP-1", (2400, 1350)), display("DP-2", (1920, 1080))]
            ),
            None
        );
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
