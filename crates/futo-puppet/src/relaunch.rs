//! `relaunch`: close the phone app and open it again, then `look`.

use super::*;

/// The debug app on the phones, as `apps/ios/run.sh` and `apps/android/run.sh` install it.
const PHONE_BUNDLE: &str = "com.futo.notes.dev";

const ANDROID_ACTIVITY: &str = "com.futo.notes.dev/com.futo.notes.MainActivity";

/// How long a relaunched app has to answer again.
const RELAUNCH_CEILING: Duration = Duration::from_secs(30);

/// `relaunch`: close the app and open it again, as a person does, on this worktree's device,
/// and answer once the new process has drawn its first screen, with `look`. A launch is a fresh
/// state, so nothing is compared with the app that was closed.
pub(crate) fn relaunch(target: &Target) -> Result<String, String> {
    let Target::Native(platform, port, device) = target else {
        return Err(
            "relaunch is the phones' for now: on desktop, stop `just tauri-dev` and start it again"
                .into(),
        );
    };
    let started = Instant::now();
    let run = |command: &mut Command| -> Result<(), String> {
        let output = command.output().map_err(|e| e.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    };
    match platform {
        NativePlatform::Android => {
            run(Command::new("adb").args([
                "-s",
                device,
                "shell",
                "am",
                "force-stop",
                PHONE_BUNDLE,
            ]))
            .map_err(|e| format!("adb am force-stop: {e}"))?;
            run(Command::new("adb").args([
                "-s",
                device,
                "shell",
                "am",
                "start",
                "-W",
                "-n",
                ANDROID_ACTIVITY,
            ]))
            .map_err(|e| format!("adb am start: {e}"))?;
        }
        NativePlatform::Ios => {
            // An app that is not running has nothing to close.
            let _ = run(Command::new("xcrun").args(["simctl", "terminate", device, PHONE_BUNDLE]));
            // The app reads this at launch and the screen reader needs it; XCUITest leaves it
            // off. `apps/ios/run.sh` sets it before every launch too.
            run(Command::new("xcrun").args([
                "simctl",
                "spawn",
                device,
                "defaults",
                "write",
                "com.apple.Accessibility",
                "ApplicationAccessibilityEnabled",
                "-bool",
                "true",
            ]))
            .map_err(|e| format!("simctl spawn defaults write: {e}"))?;
            // A simulator app inherits no environment but SIMCTL_CHILD_*: without its port the
            // listener does not start (apps/ios/run.sh).
            run(Command::new("xcrun")
                .args(["simctl", "launch", device, PHONE_BUNDLE])
                .env("SIMCTL_CHILD_FUTO_PUPPET_PORT", port.to_string()))
            .map_err(|e| format!("simctl launch: {e}"))?;
        }
    }
    // The listener comes up with the new process; its first screen is the one it settles on.
    while !matches!(call(target, "state", &json!({})), Ok(reply) if reply.status == 200) {
        if started.elapsed() > RELAUNCH_CEILING {
            return Err(format!(
                "the app did not answer within {}s of relaunching",
                RELAUNCH_CEILING.as_secs()
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    screen::settle(target, &screen::view(target)?, false)?;
    Ok(format!(
        "OK relaunch · {:.1} s\n{}",
        started.elapsed().as_secs_f64(),
        look(target)?
    ))
}
