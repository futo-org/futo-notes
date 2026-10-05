//! The one sanctioned way for shipped Rust code to print a diagnostic line.

use std::fmt;
use std::io::Write;

/// Writes one line to stderr, like `eprintln!`, but never panics.
///
/// `eprintln!`/`println!` panic when the write fails: EPIPE once the terminal that launched
/// the app is closed, EIO once its pty is gone. The desktop release profile aborts on panic,
/// so a diagnostic line killed the whole app. The write error is dropped because there is
/// nowhere left to report it. Clippy (`[workspace.lints]`) rejects the panicking macros in
/// shipped code.
///
/// `cfg!(test)` is evaluated in the calling crate: its unit tests get plain `eprintln!`, which
/// libtest captures, and a test run has no closed stderr to hit. Integration tests under
/// `tests/` build the library without `cfg(test)`, so library lines they trigger still print.
#[macro_export]
macro_rules! log_to_stderr {
    ($($argument:tt)*) => {
        $crate::write_stderr_line(cfg!(test), ::std::format_args!($($argument)*))
    };
}

/// The body of `log_to_stderr!`; call the macro instead.
#[doc(hidden)]
pub fn write_stderr_line(caller_is_unit_test: bool, line: fmt::Arguments<'_>) {
    if caller_is_unit_test {
        #[allow(clippy::print_stderr)] // Only unit-test builds get here.
        {
            eprintln!("{line}");
        }
    } else {
        let _ = writeln!(std::io::stderr(), "{line}");
    }
}

#[cfg(test)]
mod tests {
    use std::process::{Command, Stdio};

    /// The child half of `a_closed_stderr_does_not_panic`: the shipped (non-test) path.
    #[test]
    #[ignore = "run by a_closed_stderr_does_not_panic with a closed stderr"]
    fn child_logs_to_closed_stderr() {
        super::write_stderr_line(
            false,
            format_args!("a diagnostic line nobody is left to read"),
        );
    }

    #[test]
    fn a_closed_stderr_does_not_panic() {
        let (pipe_reader, pipe_writer) = std::io::pipe().expect("create a pipe");
        drop(pipe_reader);
        // `--nocapture` makes a regression to `eprintln!` hit the broken stderr instead of
        // libtest's buffer, where it would pass unnoticed.
        let child = Command::new(std::env::current_exe().expect("locate the test binary"))
            .args([
                "--ignored",
                "--exact",
                "stderr_log::tests::child_logs_to_closed_stderr",
                "--nocapture",
            ])
            .stdout(Stdio::piped())
            .stderr(pipe_writer)
            .output()
            .expect("run the child test");
        let child_report = String::from_utf8_lossy(&child.stdout);
        // A filter that matches nothing also exits 0, so require the child to have run.
        assert!(
            child.status.success() && child_report.contains("test result: ok. 1 passed"),
            "the child test did not log cleanly to a closed stderr ({}):\n{child_report}",
            child.status
        );
    }
}
