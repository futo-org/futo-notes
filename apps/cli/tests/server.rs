//! Sign-in and sync against the pinned sync server in password mode. Each test
//! starts its own server, so no two share an account.
//!
//! They need the pinned server binary, so a plain `cargo test` skips them;
//! `just test-cli` resolves the pin and runs them.

mod common;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

use common::{Env, Run, Server, SERVER_PASSWORD};

fn assert_no_password(env: &Env, runs: &[&Run]) {
    for run in runs {
        assert!(
            !run.stdout.contains(SERVER_PASSWORD),
            "stdout: {}",
            run.stdout
        );
        assert!(
            !run.stderr.contains(SERVER_PASSWORD),
            "stderr: {}",
            run.stderr
        );
    }
    let config = fs::read_to_string(env.config_file()).unwrap();
    assert!(!config.contains(SERVER_PASSWORD), "config: {config}");
    for entry in walk(&env.vault()) {
        let bytes = fs::read(&entry).unwrap();
        assert!(
            !String::from_utf8_lossy(&bytes).contains(SERVER_PASSWORD),
            "password in {}",
            entry.display()
        );
    }
}

fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut files = Vec::new();
    for entry in fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            files.extend(walk(&path));
        } else {
            files.push(path);
        }
    }
    files
}

/// Every file in the vault with its bytes, for "nothing changed" checks.
fn snapshot(dir: &std::path::Path) -> Vec<(std::path::PathBuf, Vec<u8>)> {
    let mut files = walk(dir)
        .into_iter()
        .map(|path| {
            let bytes = fs::read(&path).unwrap();
            (path, bytes)
        })
        .collect::<Vec<_>>();
    files.sort();
    files
}

#[test]
#[ignore = "needs the pinned sync server; run `just test-cli`"]
fn login_syncs_and_a_second_client_receives_exact_bytes() {
    let server = Server::start();
    let a = Env::new("a");
    let root_a = a.init();
    let body = "Remember the Windows build\n\nwith ünïcode ✓ and [[other]]\n";
    a.run_stdin(&["create", "release reminder", "--stdin"], body.as_bytes())
        .assert_ok();
    let image = (0..=255u8).cycle().take(5000).collect::<Vec<_>>();
    fs::write(root_a.join("diagram.png"), &image).unwrap();

    let first = a.login(&server);
    first.assert_ok();
    assert!(first.json()["data"]["uploaded"].as_u64().unwrap() >= 2);
    assert_no_password(&a, &[&first]);

    let b = Env::new("b");
    let root_b = b.init();
    b.login(&server).assert_ok();
    assert_eq!(b.run(&["read", "release reminder"]).stdout, body);
    assert_eq!(fs::read(root_b.join("diagram.png")).unwrap(), image);

    b.run(&["append", "release reminder", "--body", "edited on B"])
        .assert_ok();
    b.run(&["create", "from b", "--body", "new"]).assert_ok();
    b.run(&["sync"]).assert_ok();
    a.run(&["--json", "sync"]).assert_ok();
    assert_eq!(
        fs::read(a.note("release reminder")).unwrap(),
        format!("{body}edited on B").into_bytes()
    );
    assert_eq!(a.run(&["read", "from b"]).stdout, "new");

    let again = a.run(&["--json", "sync"]).json();
    assert_eq!(again["data"]["uploaded"], 0, "a rerun duplicates nothing");
    assert_eq!(a.ids(), b.ids());
}

#[test]
#[ignore = "needs the pinned sync server; run `just test-cli`"]
fn a_configured_password_command_syncs_unattended() {
    let server = Server::start();
    let env = Env::new("unattended");
    env.init();
    env.login(&server).assert_ok();
    env.run(&["create", "later", "--body", "x"]).assert_ok();

    // A new process with closed stdin and no terminal, as under a timer.
    let run = env.run(&["--json", "sync"]);
    run.assert_ok();
    assert_eq!(run.json()["data"]["uploaded"], 1);
    let human = env.run(&["sync"]);
    human.assert_ok();
    assert_no_password(&env, &[&run, &human]);
    let status = env.run(&["--json", "status"]).json();
    assert_eq!(status["data"]["server"], server.url.as_str());
    assert_eq!(status["data"]["passwordCommand"], true);
}

#[test]
#[ignore = "needs the pinned sync server; run `just test-cli`"]
fn sign_in_failures_have_distinct_codes_and_change_nothing() {
    let server = Server::start();
    let env = Env::new("failures");
    let root = env.init();
    env.run(&["create", "local", "--body", "x"]).assert_ok();
    let before = snapshot(&root);
    let login = |server_url: &str, command: &str| {
        env.run(&[
            "--json",
            "auth",
            "login",
            "--server",
            server_url,
            "--password-command",
            command,
        ])
    };

    let wrong = env.password_command("not the password");
    let run = login(&server.url, &wrong);
    assert_eq!(run.error_code(), "auth_failed");
    assert!(!run.stdout.contains("not the password"));

    let run = login(&server.url, "false");
    assert_eq!(run.error_code(), "auth_failed");

    let slow = env.path("slow");
    fs::write(&slow, "#!/bin/sh\nexec sleep 30\n").unwrap();
    fs::set_permissions(&slow, fs::Permissions::from_mode(0o755)).unwrap();
    let run = Run::timed(
        env.command()
            .env("FUTO_NOTES_CLI_TEST_PASSWORD_DEADLINE_MS", "300")
            .args([
                "--json",
                "auth",
                "login",
                "--server",
                &server.url,
                "--password-command",
                slow.to_str().unwrap(),
            ]),
    );
    assert_eq!(run.error_code(), "auth_failed");
    assert!(run.elapsed < Duration::from_secs(10));

    let unreachable = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        format!("http://127.0.0.1:{port}")
    };
    let good = env.password_command(SERVER_PASSWORD);
    let run = login(&unreachable, &good);
    assert_eq!(run.error_code(), "network_error");

    let run = login("ftp://example.net", &good);
    run.assert_status(2);

    assert_eq!(snapshot(&root), before, "no local change");
    let config = fs::read_to_string(env.config_file()).unwrap();
    assert!(!config.contains("server"), "{config}");
}

#[test]
#[ignore = "needs the pinned sync server; run `just test-cli`"]
fn a_vault_connected_to_one_server_refuses_another() {
    let first = Server::start();
    let second = Server::start();
    let env = Env::new("other-server");
    env.init();
    env.login(&first).assert_ok();
    let run = env.login(&second);
    run.assert_status(2);
    assert!(run.json()["error"]["message"]
        .as_str()
        .unwrap()
        .contains("auth logout"));
    env.login(&first).assert_ok();
}

#[test]
#[ignore = "needs the pinned sync server; run `just test-cli`"]
fn a_failed_first_sync_keeps_the_configuration_for_a_retry() {
    let server = Server::start();
    let env = Env::new("first-sync");
    let root = env.init();
    env.run(&["create", "pending", "--body", "x"]).assert_ok();
    // A note that cannot be read makes the first cycle incomplete.
    let blocked = env.note("blocked");
    fs::write(&blocked, "b").unwrap();
    fs::set_permissions(&blocked, fs::Permissions::from_mode(0o000)).unwrap();
    let run = env.login(&server);
    fs::set_permissions(&blocked, fs::Permissions::from_mode(0o644)).unwrap();
    run.assert_status(1);
    assert_eq!(run.error_code(), "sync_incomplete");
    assert!(run.json()["error"]["message"]
        .as_str()
        .unwrap()
        .starts_with("Signed in"));
    assert!(fs::read_to_string(env.config_file())
        .unwrap()
        .contains(&server.url));
    env.run(&["sync"]).assert_ok();
}

#[test]
#[ignore = "needs the pinned sync server; run `just test-cli`"]
fn a_checkpoint_that_cannot_be_written_fails_and_recovers() {
    let server = Server::start();
    let env = Env::new("checkpoint");
    let root = env.init();
    env.login(&server).assert_ok();
    env.run(&["create", "pending", "--body", "x"]).assert_ok();
    // A directory where the checkpoint file belongs makes every save fail.
    let state = root.join(".e2ee-state.json");
    fs::remove_file(&state).unwrap();
    fs::create_dir(&state).unwrap();
    let run = env.run(&["--json", "sync"]);
    run.assert_status(1);
    assert_eq!(run.error_code(), "sync_incomplete");
    assert_eq!(env.run(&["read", "pending"]).stdout, "x", "local edit kept");

    fs::remove_dir(&state).unwrap();
    env.run(&["--json", "sync"]).assert_ok();
    let peer = Env::new("checkpoint-peer");
    peer.init();
    peer.login(&server).assert_ok();
    assert_eq!(peer.ids(), ["pending"], "the note landed exactly once");
}

#[test]
#[ignore = "needs the pinned sync server; run `just test-cli`"]
fn a_killed_sync_resumes_without_loss_or_duplicates() {
    let server = Server::start();
    let env = Env::new("killed");
    let root = env.init();
    env.login(&server).assert_ok();
    for index in 0..150 {
        fs::write(
            root.join(format!("note {index:03}.md")),
            format!("body {index}"),
        )
        .unwrap();
    }
    for (delay, signal) in [
        (40, libc::SIGKILL),
        (120, libc::SIGKILL),
        (80, libc::SIGINT),
    ] {
        let mut child = env.command().args(["sync"]).spawn().unwrap();
        std::thread::sleep(Duration::from_millis(delay));
        // SAFETY: signalling a child this test spawned and still owns.
        unsafe {
            libc::kill(child.id() as i32, signal);
        }
        let status = child.wait().unwrap();
        assert_ne!(
            status.code(),
            Some(0),
            "an interrupted sync never claims success"
        );
    }
    env.run(&["sync"]).assert_ok();
    let peer = Env::new("killed-peer");
    peer.init();
    peer.login(&server).assert_ok();
    let received = peer.ids();
    assert_eq!(received.len(), 150, "{received:?}");
    assert_eq!(peer.run(&["read", "note 077"]).stdout, "body 77");
}

#[test]
#[ignore = "needs the pinned sync server; run `just test-cli`"]
fn logout_keeps_notes_and_a_new_login_honors_history() {
    let server = Server::start();
    let a = Env::new("logout-a");
    let root = a.init();
    a.run(&["create", "doomed", "--body", "d"]).assert_ok();
    a.run(&["create", "kept", "--body", "k"]).assert_ok();
    a.login(&server).assert_ok();
    let b = Env::new("logout-b");
    b.init();
    b.login(&server).assert_ok();

    let before = snapshot(&root)
        .into_iter()
        .filter(|(path, _)| path.extension().is_some_and(|ext| ext == "md"))
        .collect::<Vec<_>>();
    a.run(&["--json", "auth", "logout"]).assert_ok();
    let after = snapshot(&root)
        .into_iter()
        .filter(|(path, _)| path.extension().is_some_and(|ext| ext == "md"))
        .collect::<Vec<_>>();
    assert_eq!(after, before, "logout leaves note bytes untouched");
    assert_eq!(
        a.run(&["--json", "status"]).json()["data"]["server"],
        serde_json::Value::Null
    );

    // While A is signed out: B deletes a note, A edits another.
    fs::remove_file(b.note("doomed")).unwrap();
    b.run(&["sync"]).assert_ok();
    a.run(&["append", "kept", "--body", " edited offline"])
        .assert_ok();

    a.login(&server).assert_ok();
    assert!(!a.note("doomed").exists(), "the deletion is not undone");
    b.run(&["sync"]).assert_ok();
    assert_eq!(b.run(&["read", "kept"]).stdout, "k edited offline");
}

#[test]
#[ignore = "needs the pinned sync server; run `just test-cli`"]
fn conflicts_are_reported_but_do_not_fail_the_sync() {
    let server = Server::start();
    let a = Env::new("conflict-a");
    a.init();
    a.run(&["create", "shared", "--body", "base"]).assert_ok();
    a.login(&server).assert_ok();
    let b = Env::new("conflict-b");
    b.init();
    b.login(&server).assert_ok();

    fs::write(a.note("shared"), "base and a different line from A\n").unwrap();
    fs::write(b.note("shared"), "B rewrote everything\n").unwrap();
    a.run(&["sync"]).assert_ok();
    let run = b.run(&["--json", "sync"]);
    run.assert_ok();
    assert_eq!(run.json()["data"]["conflicts"], 1);
    assert_eq!(b.ids().len(), 2, "the note and its conflict copy");
}
