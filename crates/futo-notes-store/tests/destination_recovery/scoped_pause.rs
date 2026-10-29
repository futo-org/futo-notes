use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const ABORT_SCOPE: &str = "FUTO_DESTINATION_ABORT_SCOPE";
const ABORT_MESSAGE: &str = "fixture aborted after install paused";

pub(super) fn abort_if_requested() {
    if std::env::var_os(ABORT_SCOPE).is_some() {
        panic!("{ABORT_MESSAGE}");
    }
}

#[test]
fn failed_directory_race_assertion_releases_paused_workflow() {
    assert_scope_aborts(
        "destination_identity::first_append_waits_for_directory_install_that_started_without_recovery_metadata",
    );
}

#[test]
fn failed_bootstrap_race_assertion_releases_paused_workflow() {
    assert_scope_aborts(
        "destination_failures::bootstrap_serializes_txt_install_against_other_store_writers",
    );
}

fn assert_scope_aborts(test: &str) {
    // The child drives the public workflow and aborts its observing scope only
    // after BeforeWrite confirms installation is paused. A failed assertion
    // must finish red, rather than joining a child still waiting for release.
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", test, "--nocapture"])
        .env(ABORT_SCOPE, "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let completed = loop {
        if child.try_wait().unwrap().is_some() {
            break true;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            break false;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let output = child.wait_with_output().unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains(ABORT_MESSAGE), "{stderr}");
    assert!(
        completed,
        "failed assertion left a paused workflow running: {stderr}"
    );
    assert!(
        !output.status.success(),
        "the intentional assertion must fail red"
    );
}
