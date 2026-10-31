//! Public CLI safety using fake host tools only; no phone or server is contacted.
#![cfg(unix)]
use std::{fs, os::unix::fs::PermissionsExt, process::Command};

#[test]
fn a_cached_physical_forward_still_validates_the_claim_before_relaunch() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .unwrap();
    let scratch = std::env::temp_dir().join(format!("puppet-physical-{}", std::process::id()));
    fs::create_dir(&scratch).unwrap();
    let bin = scratch.join("bin");
    fs::create_dir(&bin).unwrap();
    let owners = scratch.join(".futo-notes-qa/devices");
    fs::create_dir_all(&owners).unwrap();
    fs::write(
        owners.join("android-physical-PHONE123.json"),
        serde_json::json!({"worktree":root,"id":"PHONE123","physical":true}).to_string(),
    )
    .unwrap();
    let adb = bin.join("adb");
    fs::write(&adb, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$HOME/adb.log\"\nif [ \"$*\" = 'forward --list' ]; then echo 'PHONE123 tcp:19480 localabstract:futo-puppet'; exit 0; fi\necho MUTATION_REFUSED >&2; exit 1\n").unwrap();
    fs::set_permissions(&adb, fs::Permissions::from_mode(0o755)).unwrap();
    let node = bin.join("node");
    fs::write(&node, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$HOME/node.log\"\necho IDENTITY_REFUSED >&2; exit 1\n").unwrap();
    fs::set_permissions(&node, fs::Permissions::from_mode(0o755)).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_futo-puppet"))
        .arg("relaunch")
        .current_dir(root)
        .env("HOME", &scratch)
        .env(
            "PATH",
            format!("{}:{}", bin.display(), std::env::var("PATH").unwrap()),
        )
        .env("FUTO_PUPPET_TARGET", "android")
        .env("FUTO_PUPPET_PORT", "19480")
        .output()
        .unwrap();
    let calls = fs::read_to_string(scratch.join("adb.log")).unwrap_or_default();
    let error = String::from_utf8_lossy(&output.stderr).into_owned();
    let validation = fs::read_to_string(scratch.join("node.log")).unwrap_or_default();
    fs::remove_dir_all(&scratch).unwrap();
    assert!(!output.status.success());
    assert!(
        validation.contains("qa.mjs device android"),
        "{validation}; {error}; {calls}"
    );
    assert!(!calls.contains("force-stop"), "{calls}");
}
