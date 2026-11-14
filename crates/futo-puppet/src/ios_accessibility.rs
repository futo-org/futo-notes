//! Preserve the claimed simulator's AX preference around AXe operations.
//!
//! AXe also queries accessibility to translate touch coordinates. On iOS 27
//! its short-lived automation session can leave AX disabled when invalidated.
//! Restore the original value before the CLI observes the resulting screen.

use super::*;

pub(crate) fn preserve<T>(
    device: &str,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    preserving(
        || enabled(device),
        operation,
        |value| set_enabled(device, value),
    )
}

pub(crate) fn enabled(device: &str) -> Result<bool, String> {
    let output = Command::new("xcrun")
        .args([
            "simctl",
            "spawn",
            device,
            "defaults",
            "read",
            "com.apple.Accessibility",
            "ApplicationAccessibilityEnabled",
        ])
        .output()
        .map_err(|error| format!("could not read simulator accessibility preference: {error}"))?;
    match String::from_utf8_lossy(&output.stdout).trim() {
        "1" if output.status.success() => Ok(true),
        "0" if output.status.success() => Ok(false),
        _ => Err("could not read simulator accessibility preference as a boolean".into()),
    }
}

fn set_enabled(device: &str, value: bool) -> Result<(), String> {
    let output = Command::new("xcrun")
        .args([
            "simctl",
            "spawn",
            device,
            "defaults",
            "write",
            "com.apple.Accessibility",
            "ApplicationAccessibilityEnabled",
            "-bool",
            if value { "true" } else { "false" },
        ])
        .output()
        .map_err(|error| {
            format!("could not restore simulator accessibility preference: {error}")
        })?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "could not restore simulator accessibility preference: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

fn preserving<T>(
    read: impl FnOnce() -> Result<bool, String>,
    operation: impl FnOnce() -> Result<T, String>,
    restore: impl FnOnce(bool) -> Result<(), String>,
) -> Result<T, String> {
    let original = read()?;
    let result = operation();
    match (result, restore(original)) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(operation), Err(restoration)) => Err(format!("{operation}; {restoration}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn an_axe_operation_that_disables_ax_restores_it_before_the_next_observation() {
        let ax = Cell::new(true);
        let answer = preserving(
            || Ok(ax.get()),
            || {
                ax.set(false);
                Ok(7)
            },
            |original| {
                ax.set(original);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(answer, 7);
        assert!(ax.get(), "AXe must not leave the next screen unreadable");
    }

    #[test]
    fn failed_input_also_restores_ax_without_hiding_the_input_error() {
        let ax = Cell::new(true);
        let error = preserving(
            || Ok(ax.get()),
            || {
                ax.set(false);
                Err::<(), _>("axe failed".into())
            },
            |original| {
                ax.set(original);
                Ok(())
            },
        )
        .unwrap_err();
        assert_eq!(error, "axe failed");
        assert!(ax.get());
    }

    #[test]
    fn a_disabled_preference_stays_disabled_and_an_unreadable_one_prevents_input() {
        let ax = Cell::new(false);
        preserving(
            || Ok(ax.get()),
            || {
                ax.set(true);
                Ok(())
            },
            |value| {
                ax.set(value);
                Ok(())
            },
        )
        .unwrap();
        assert!(!ax.get());
        let sent = Cell::new(false);
        let error = preserving(
            || Err("unreadable".into()),
            || {
                sent.set(true);
                Ok(())
            },
            |_| Ok(()),
        )
        .unwrap_err();
        assert_eq!(error, "unreadable");
        assert!(!sent.get());
    }

    #[test]
    fn a_restore_failure_is_reported_even_when_input_itself_failed() {
        let error = preserving(
            || Ok(true),
            || Err::<(), _>("input failed".into()),
            |_| Err("restore failed".into()),
        )
        .unwrap_err();
        assert_eq!(error, "input failed; restore failed");
    }
}
