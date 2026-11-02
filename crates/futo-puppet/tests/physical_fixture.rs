//! Public CLI refusals. These calls cannot load a manifest or reach a device.
use std::process::Command;

#[test]
fn physical_fixture_refuses_extra_commands_before_pooled_resolution() {
    let output = Command::new(env!("CARGO_BIN_EXE_futo-puppet"))
        .args(["physical-fixture", "capture", "--test", "arbitrary"])
        .env(
            "FUTO_PUPPET_TARGET",
            "invalid-target-that-must-never-resolve",
        )
        .output()
        .expect("CLI starts");
    assert!(!output.status.success());
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(
        error.contains("physical-fixture capture --manifest"),
        "{error}"
    );
    assert!(!error.contains("FUTO_PUPPET_TARGET"), "{error}");
}

#[test]
fn physical_fixture_refuses_traversal_run_before_pooled_resolution() {
    let output = Command::new(env!("CARGO_BIN_EXE_futo-puppet"))
        .args(["physical-fixture", "read", "--run", "../foreign"])
        .env(
            "FUTO_PUPPET_TARGET",
            "invalid-target-that-must-never-resolve",
        )
        .output()
        .expect("CLI starts");
    assert!(!output.status.success());
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(error.contains("physical-fixture"), "{error}");
    assert!(!error.contains("FUTO_PUPPET_TARGET"), "{error}");
}
