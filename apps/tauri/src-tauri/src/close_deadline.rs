//! Rust-side backstop for the desktop close (RC-37).
//!
//! Closing the window is JS-mediated: `startNativeShell.ts` `onCloseRequested`
//! prevents the default, drains the pending save (a 3 s race) and then calls
//! `exit(0)`. That handler runs on the webview's JS thread, which a giant-note
//! open can block for a minute or more, so the window used to ignore every
//! close request until the parse finished. The first close request now arms
//! this deadline; if the app is still alive `CLOSE_DEADLINE` later AND the page
//! holds no unsaved edit, Rust exits it without the JS thread.
//!
//! The "no unsaved edit" half matters as much as the exit. A stall that is not
//! a note open (a multi-megabyte paste, a long task) blocks the same thread with
//! an edit still waiting in it, and cutting that loses the edit the JS handler
//! would have saved (R10 FB-9: 8 s busy loop, 2.5 MB paste). So the page tells
//! Rust on every clean/dirty transition (`close_deadline_set_dirty`,
//! `closeDeadlineDirty.ts`), and a dirty page is never cut: Rust keeps waiting
//! for the JS handler exactly as it did before this module existed. A giant
//! OPEN is not dirty (a note switch awaits the outgoing save before the new note
//! is read, and the user cannot type while the parse runs), so RC-37 stays fixed.
//! There is deliberately no hard cap on a dirty wait: a cap could only ever
//! discard an edit, and the alternative it would rescue the user from (a renderer
//! hung for good with an unsaved edit) is one Force Quit, which loses the same edit.
//!
//! `CLOSE_DEADLINE` is the JS handler's own 3 s flush race plus a 2 s margin
//! for the exit IPC, so a responsive page with nothing dirty never reaches it.
//!
//! The exit first takes the process-wide vault mutation guard, which every store
//! mutation, image paste and sync write to the vault holds for its whole
//! check-and-write span. An in-flight write therefore finishes before the process
//! goes; a write that is stuck for `WRITE_GRACE` is abandoned (writes are atomic
//! tmp-and-rename, so a killed write leaves the old file, never a partial one).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use futo_notes_core::files::vault_mutation_guard;
use tauri::{Manager, WindowEvent};

pub(crate) const CLOSE_DEADLINE: Duration = Duration::from_secs(5);
const WRITE_GRACE: Duration = Duration::from_secs(5);
/// How long `app.exit` gets before the process is ended outright: it is
/// delivered through the event loop, which is the one thing this path cannot
/// assume is healthy.
const EXIT_FALLBACK: Duration = Duration::from_secs(3);
/// How often a dirty page is re-checked once the deadline has passed.
const DIRTY_POLL: Duration = Duration::from_millis(100);

#[derive(Clone, Copy)]
struct Timing {
    deadline: Duration,
    write_grace: Duration,
}

struct CloseDeadline {
    armed: AtomicBool,
    /// The open note has edits not yet on disk, as last reported by the page.
    dirty: AtomicBool,
}

impl CloseDeadline {
    const fn new() -> Self {
        Self {
            armed: AtomicBool::new(false),
            dirty: AtomicBool::new(false),
        }
    }

    fn set_dirty(&self, dirty: bool) {
        self.dirty.store(dirty, Ordering::SeqCst);
    }

    fn is_dirty(&self) -> bool {
        self.dirty.load(Ordering::SeqCst)
    }

    /// Starts the deadline on the first close request; later requests are
    /// ignored so the clock is never pushed out. Returns whether it armed.
    fn arm<F>(&'static self, timing: Timing, exit: F) -> bool
    where
        F: FnOnce() + Send + 'static,
    {
        if self.armed.swap(true, Ordering::SeqCst) {
            return false;
        }
        let spawned = std::thread::Builder::new()
            .name("close-deadline".to_owned())
            .spawn(move || {
                std::thread::sleep(timing.deadline);
                // A dirty page is the JS handler's to save; it is never cut.
                while self.is_dirty() {
                    std::thread::sleep(DIRTY_POLL);
                }
                exit_after_in_flight_writes(timing.write_grace, exit);
            });
        if spawned.is_err() {
            // No thread, no backstop: let a later request try again.
            self.armed.store(false, Ordering::SeqCst);
            return false;
        }
        true
    }
}

fn exit_after_in_flight_writes<F: FnOnce()>(write_grace: Duration, exit: F) {
    let (locked_tx, locked_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    // The guard is taken on its own thread so a stuck writer cannot stall the
    // grace timeout, and it is held until `exit` returns so no new mutation can
    // start between the wait and the exit.
    let holder = std::thread::Builder::new()
        .name("close-deadline-writes".to_owned())
        .spawn(move || {
            let guard = vault_mutation_guard();
            let _ = locked_tx.send(());
            let _ = release_rx.recv();
            drop(guard);
        });
    if holder.is_ok() {
        // Err = grace elapsed with a write still running: exit anyway.
        let _ = locked_rx.recv_timeout(write_grace);
    }
    exit();
    let _ = release_tx.send(());
}

static CLOSE_DEADLINE_STATE: CloseDeadline = CloseDeadline::new();

/// The page reports whether the open note holds edits not yet on disk.
#[tauri::command]
pub async fn close_deadline_set_dirty(dirty: bool) {
    CLOSE_DEADLINE_STATE.set_dirty(dirty);
}

/// Window-event hook: the first `CloseRequested` starts the deadline.
pub(crate) fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    if !matches!(event, WindowEvent::CloseRequested { .. }) {
        return;
    }
    let app = window.app_handle().clone();
    CLOSE_DEADLINE_STATE.arm(
        Timing {
            deadline: CLOSE_DEADLINE,
            write_grace: WRITE_GRACE,
        },
        move || {
            app.exit(0);
            std::thread::sleep(EXIT_FALLBACK);
            std::process::exit(0);
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn timing(deadline_ms: u64, grace_ms: u64) -> Timing {
        Timing {
            deadline: Duration::from_millis(deadline_ms),
            write_grace: Duration::from_millis(grace_ms),
        }
    }

    /// One per test: the thread that waits out the deadline borrows it for good.
    fn state() -> &'static CloseDeadline {
        Box::leak(Box::new(CloseDeadline::new()))
    }

    fn exit_signal() -> (impl FnOnce() + Send + 'static, mpsc::Receiver<Instant>) {
        let (tx, rx) = mpsc::channel();
        (
            move || {
                let _ = tx.send(Instant::now());
            },
            rx,
        )
    }

    /// The deadline is the JS handler's flush race plus a margin. Raising the race
    /// past the deadline would make the backstop cut a flush that is still allowed
    /// to finish, so the two numbers are pinned against each other.
    #[test]
    fn the_deadline_outlasts_the_js_flush_race() {
        let shell = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../src/app/startNativeShell.ts"
        ))
        .expect("the close handler is readable from the crate");
        let race_ms: u64 = shell
            .split("const FLUSH_RACE_MS = ")
            .nth(1)
            .and_then(|rest| rest.split(';').next())
            .and_then(|digits| digits.trim().parse().ok())
            .expect("startNativeShell.ts declares FLUSH_RACE_MS");
        assert!(
            CLOSE_DEADLINE >= Duration::from_millis(race_ms) + Duration::from_secs(1),
            "CLOSE_DEADLINE must leave at least 1s past the {race_ms} ms JS flush race"
        );
    }

    #[test]
    fn exits_once_the_deadline_passes() {
        let state = state();
        let (exit, exited) = exit_signal();
        let started = Instant::now();
        assert!(state.arm(timing(150, 1000), exit));
        let at = exited
            .recv_timeout(Duration::from_secs(5))
            .expect("exit ran");
        assert!(at - started >= Duration::from_millis(150));
    }

    #[test]
    fn a_second_close_request_does_not_restart_the_clock() {
        let state = state();
        let (exit, exited) = exit_signal();
        assert!(state.arm(timing(100, 1000), exit));
        let (second, second_exited) = exit_signal();
        assert!(!state.arm(timing(100, 1000), second));
        exited
            .recv_timeout(Duration::from_secs(5))
            .expect("first exit ran");
        assert!(second_exited
            .recv_timeout(Duration::from_millis(300))
            .is_err());
    }

    #[test]
    fn waits_for_an_in_flight_vault_write() {
        let state = state();
        let (exit, exited) = exit_signal();
        let write = vault_mutation_guard().expect("vault lock");
        assert!(state.arm(timing(20, 5000), exit));
        // The deadline has long passed, but a write is mid-flight.
        assert!(exited.recv_timeout(Duration::from_millis(500)).is_err());
        let released = Instant::now();
        drop(write);
        let at = exited
            .recv_timeout(Duration::from_secs(5))
            .expect("exit ran");
        assert!(at >= released);
    }

    #[test]
    fn a_dirty_page_is_not_cut_at_the_deadline() {
        let state = state();
        let (exit, exited) = exit_signal();
        state.set_dirty(true);
        assert!(state.arm(timing(20, 1000), exit));
        // Well past the deadline, but the page still holds an edit.
        assert!(exited.recv_timeout(Duration::from_millis(600)).is_err());
        state.set_dirty(false);
        exited
            .recv_timeout(Duration::from_secs(5))
            .expect("exit ran once the page was clean");
    }

    #[test]
    fn a_page_that_turns_dirty_before_the_deadline_is_waited_for() {
        let state = state();
        let (exit, exited) = exit_signal();
        assert!(state.arm(timing(300, 1000), exit));
        state.set_dirty(true);
        assert!(exited.recv_timeout(Duration::from_millis(900)).is_err());
        state.set_dirty(false);
        exited
            .recv_timeout(Duration::from_secs(5))
            .expect("exit ran once the page was clean");
    }

    #[test]
    fn a_stuck_write_does_not_hold_the_exit_past_the_grace() {
        let state = state();
        let (exit, exited) = exit_signal();
        let _stuck = vault_mutation_guard().expect("vault lock");
        let started = Instant::now();
        assert!(state.arm(timing(20, 300), exit));
        let at = exited
            .recv_timeout(Duration::from_secs(5))
            .expect("exit ran");
        assert!(at - started >= Duration::from_millis(300));
    }
}
