//! Local commands against scratch vaults: no account, no network, no server.

mod common;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

use common::Env;

#[test]
fn local_commands_work_with_no_account() {
    let env = Env::new("local");
    let root = env.init();

    env.run(&["create", "release checklist", "--body", "ship it"])
        .assert_ok();
    let created = env.run(&["create", "work/plan", "--body", "draft"]);
    assert_eq!(created.assert_ok().line(), "work/plan");
    assert_eq!(env.run(&["read", "work/plan"]).stdout, "draft");
    assert_eq!(env.ids(), ["release checklist", "work/plan"]);
    assert_eq!(
        env.run(&["list", "--folder", "work"]).assert_ok().line(),
        "work/plan"
    );
    assert_eq!(
        env.run(&["list", "--folder", ""]).assert_ok().line(),
        "release checklist"
    );
    assert_eq!(
        env.run(&["search", "checklist"]).assert_ok().line(),
        "release checklist"
    );
    assert_eq!(
        env.run(&["search", "nothing-matches-this"])
            .assert_ok()
            .stdout,
        ""
    );
    assert!(root.join("work/plan.md").is_file());

    // `status` needs no network and says so.
    let status = env.run(&["--json", "status"]).json();
    assert_eq!(status["data"]["server"], serde_json::Value::Null);
    assert_eq!(status["data"]["passwordCommand"], false);
}

#[test]
fn nothing_is_seeded_and_existing_notes_are_left_alone() {
    let env = Env::new("existing");
    fs::create_dir_all(env.vault()).unwrap();
    fs::write(env.vault().join("old.txt"), "plain text").unwrap();
    fs::write(env.note("Mixed Case"), "kept").unwrap();
    env.init();
    assert_eq!(env.ids(), ["Mixed Case"]);
    assert!(env.vault().join("old.txt").is_file(), "no .txt migration");
    // Re-running init on the same vault changes nothing.
    let again = env.run(&["--json", "init", env.vault().to_str().unwrap()]);
    assert_eq!(again.json()["data"]["changed"], false);
}

#[test]
fn vault_selection_never_guesses() {
    let env = Env::new("selection");
    let run = env.run(&["--json", "list"]);
    run.assert_status(1);
    assert_eq!(run.error_code(), "vault_not_configured");

    // `--vault` acts on another directory for one command only.
    let other = env.path("other");
    fs::create_dir_all(&other).unwrap();
    fs::write(other.join("elsewhere.md"), "x").unwrap();
    assert_eq!(
        env.run(&["list", "--vault", other.to_str().unwrap()])
            .assert_ok()
            .line(),
        "elsewhere"
    );
    let run = env.run(&["--json", "list"]);
    assert_eq!(run.error_code(), "vault_not_configured");

    // Help and version need nothing at all.
    env.run(&["--help"]).assert_ok();
    env.run(&["--version"]).assert_ok();
}

#[test]
fn a_removed_vault_is_an_error_and_never_recreated() {
    let env = Env::new("removed");
    let root = env.init();
    fs::remove_dir_all(&root).unwrap();
    for args in [
        vec!["--json", "list"],
        vec!["--json", "create", "n", "--body", "x"],
    ] {
        let run = env.run(&args);
        run.assert_status(1);
        assert_eq!(run.error_code(), "vault_missing");
    }
    assert!(!root.exists());
}

#[test]
fn a_development_build_uses_only_its_own_directories() {
    let env = Env::new("namespace");
    env.init();
    env.run(&["create", "n", "--body", "x"]).assert_ok();
    env.run(&["search", "x"]).assert_ok();
    assert!(env.config_file().is_file());
    for base in ["xdg-config", "xdg-cache", "xdg-state"] {
        let names = fs::read_dir(env.path(base))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(names, ["futo-notes-cli-dev"], "{base}");
    }
}

#[test]
fn init_on_another_path_clears_the_server_and_password_command() {
    let env = Env::new("reinit");
    env.init();
    let config = format!(
        r#"{{"version":1,"vault":"{}","server":"http://127.0.0.1:9","passwordCommand":"cat pw"}}"#,
        fs::canonicalize(env.vault()).unwrap().display()
    );
    fs::write(env.config_file(), config).unwrap();
    let other = env.path("second vault");
    env.run(&["init", other.to_str().unwrap()]).assert_ok();
    let saved = fs::read_to_string(env.config_file()).unwrap();
    assert!(!saved.contains("server"), "{saved}");
    assert!(!saved.contains("passwordCommand"), "{saved}");
}

#[test]
fn a_newer_configuration_is_refused_and_left_alone() {
    let env = Env::new("newer-config");
    env.init();
    fs::write(env.config_file(), r#"{"version":2}"#).unwrap();
    let run = env.run(&["--json", "list"]);
    assert_eq!(run.error_code(), "io_error");
    assert_eq!(
        fs::read_to_string(env.config_file()).unwrap(),
        r#"{"version":2}"#
    );
}

#[test]
fn edge_case_bodies_and_ids_round_trip() {
    let env = Env::new("round-trip");
    env.init();

    env.run(&["create", "empty", "--body", ""]).assert_ok();
    assert_eq!(fs::read(env.note("empty")).unwrap(), b"");
    assert_eq!(env.run(&["read", "empty"]).assert_ok().stdout, "");

    let multi = "line one\n\n  indented\ttab\nno newline at end";
    env.run_stdin(&["create", "Ünïcødé ✓ 日本", "--stdin"], multi.as_bytes())
        .assert_ok();
    assert_eq!(env.run(&["read", "Ünïcødé ✓ 日本"]).stdout, multi);

    assert_eq!(
        env.run(&["create", "--body", "-x", "--", "-dash"])
            .assert_ok()
            .line(),
        "-dash"
    );
    assert_eq!(env.run(&["read", "--", "-dash"]).stdout, "-x");

    // `.md` inside an ID is part of the title, not a suffix to strip.
    assert_eq!(
        env.run(&["create", "notes.md", "--body", "m"])
            .assert_ok()
            .line(),
        "notes.md"
    );
    assert!(env.vault().join("notes.md.md").is_file());
    assert_eq!(env.run(&["read", "notes.md"]).stdout, "m");

    // An empty append changes nothing; a non-empty one adds no separator.
    env.run(&["append", "empty", "--body", ""]).assert_ok();
    env.run(&["append", "empty", "--body", "a"]).assert_ok();
    env.run_stdin(&["append", "empty", "--stdin"], b"b\n")
        .assert_ok();
    assert_eq!(env.run(&["read", "empty"]).stdout, "ab\n");
}

#[test]
fn bad_input_is_rejected_before_anything_is_written() {
    let env = Env::new("bad-input");
    let root = env.init();

    let run = env.run_stdin(
        &["--json", "create", "bytes", "--stdin"],
        &[0x66, 0xff, 0xfe],
    );
    run.assert_status(2);
    assert_eq!(run.error_code(), "invalid_argument");
    assert!(!env.note("bytes").exists());

    for id in ["../escape", "/abs", "a/../b", "a//b", "a\\b"] {
        let run = env.run(&["--json", "create", id, "--body", "x"]);
        run.assert_status(2);
        assert_eq!(run.error_code(), "invalid_argument", "{id}");
    }
    assert!(!env.path("escape.md").exists());
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0, "nothing written");

    // A symlinked folder that points outside the vault is refused too.
    let outside = env.path("outside");
    fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
    let run = env.run(&["--json", "create", "link/n", "--body", "x"]);
    run.assert_status(1);
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);

    for args in [
        vec!["--json", "read", "ghost"],
        vec!["--json", "append", "ghost", "--body", "x"],
        vec!["--json", "rename", "ghost", "new"],
        vec!["--json", "move", "ghost", "--folder", "f"],
    ] {
        let run = env.run(&args);
        run.assert_status(1);
        assert_eq!(run.error_code(), "note_not_found", "{args:?}");
    }
    assert!(!env.note("ghost").exists());

    let run = env.run(&["--json", "create", "n"]);
    run.assert_status(2);
    assert_eq!(run.error_code(), "invalid_argument");
}

#[test]
fn create_never_overwrites_and_reports_the_allocated_id() {
    let env = Env::new("collisions");
    env.init();
    env.run(&["create", "note", "--body", "first"]).assert_ok();
    let second = env.run(&["create", "note", "--body", "second"]);
    let id = second.assert_ok().line().to_owned();
    assert_ne!(id, "note");
    assert_eq!(env.run(&["read", "note"]).stdout, "first");
    assert_eq!(env.run(&["read", &id]).stdout, "second");
}

#[test]
fn concurrent_creates_and_appends_all_land() {
    let env = Env::new("concurrent");
    env.init();
    env.run(&["create", "log", "--body", ""]).assert_ok();
    let spawn = |args: Vec<String>| env.command().args(args).spawn().unwrap();
    let creates = (0..4)
        .map(|index| {
            spawn(vec![
                "create".into(),
                "same".into(),
                "--body".into(),
                format!("c{index}"),
            ])
        })
        .collect::<Vec<_>>();
    let appends = (0..8)
        .map(|index| {
            spawn(vec![
                "append".into(),
                "log".into(),
                "--body".into(),
                format!("[{index}]"),
            ])
        })
        .collect::<Vec<_>>();
    let mut allocated = creates
        .into_iter()
        .map(|child| {
            let output = child.wait_with_output().unwrap();
            assert!(output.status.success());
            String::from_utf8(output.stdout)
                .unwrap()
                .trim_end()
                .to_owned()
        })
        .collect::<Vec<_>>();
    for child in appends {
        assert!(child.wait_with_output().unwrap().status.success());
    }
    allocated.sort();
    allocated.dedup();
    assert_eq!(allocated.len(), 4, "{allocated:?}");
    let mut bodies = allocated
        .iter()
        .map(|id| env.run(&["read", id]).stdout)
        .collect::<Vec<_>>();
    bodies.sort();
    assert_eq!(bodies, ["c0", "c1", "c2", "c3"]);
    let log = env.run(&["read", "log"]).stdout;
    for index in 0..8 {
        assert_eq!(log.matches(&format!("[{index}]")).count(), 1, "{log}");
    }
}

#[test]
fn a_command_waits_for_another_cli_process_then_succeeds() {
    let env = Env::new("lock-wait");
    env.init();
    env.run(&["list"]).assert_ok();
    let locks = fs::read_dir(env.path("xdg-state/futo-notes-cli-dev/locks"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<_>>();
    assert_eq!(locks.len(), 1, "one lock file per vault, outside the vault");
    let held = fs::OpenOptions::new().write(true).open(&locks[0]).unwrap();
    held.lock().unwrap();

    let waiting = env
        .command()
        .args(["create", "after", "--body", "x"])
        .spawn()
        .unwrap();
    std::thread::sleep(Duration::from_millis(700));
    assert!(
        !env.note("after").exists(),
        "the create waited for the lock"
    );
    held.unlock().unwrap();
    assert!(waiting.wait_with_output().unwrap().status.success());
    assert!(env.note("after").exists());
    assert!(!env.vault().read_dir().unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("lock")
    }));
}

#[test]
fn rename_and_move_rewrite_backlinks_and_report_final_ids() {
    let env = Env::new("relink");
    env.init();
    env.run(&["create", "target", "--body", "t"]).assert_ok();
    env.run(&["create", "taken", "--body", "already here"])
        .assert_ok();
    env.run(&["create", "linker", "--body", "see [[target]]"])
        .assert_ok();

    let renamed = env.run(&["rename", "target", "taken"]);
    let id = renamed.assert_ok().line().to_owned();
    assert_ne!(id, "taken", "the collision got a new ID");
    assert_eq!(env.run(&["read", "taken"]).stdout, "already here");
    assert_eq!(env.run(&["read", "linker"]).stdout, format!("see [[{id}]]"));

    let moved = env.run(&["--json", "move", &id, "--folder", "archive/2026"]);
    let value = moved.json();
    let moved_id = value["data"]["id"].as_str().unwrap().to_owned();
    assert!(moved_id.starts_with("archive/2026/"), "{moved_id}");
    assert_eq!(env.run(&["read", &moved_id]).stdout, "t");
    assert!(env.run(&["read", "linker"]).stdout.contains(&moved_id));
}

fn editor_script(env: &Env, name: &str, body: &str) -> String {
    let path = env.path(name);
    fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    path.to_str().unwrap().to_owned()
}

#[test]
fn edit_saves_through_the_editor_and_cleans_up() {
    let env = Env::new("edit");
    env.init();
    env.run(&["create", "n", "--body", "before"]).assert_ok();
    let editor = editor_script(&env, "editor", r#"printf 'after' > "$1""#);
    env.command()
        .env("EDITOR", &editor)
        .args(["edit", "n"])
        .output()
        .map(|output| assert!(output.status.success(), "{output:?}"))
        .unwrap();
    assert_eq!(env.run(&["read", "n"]).stdout, "after");
    assert_eq!(fs::read_dir(env.path("tmp")).unwrap().count(), 0);
}

#[test]
fn edit_without_an_editor_says_so() {
    let env = Env::new("no-editor");
    env.init();
    env.run(&["create", "n", "--body", "x"]).assert_ok();
    let run = env.run(&["--json", "edit", "n"]);
    run.assert_status(2);
    assert!(run.json()["error"]["message"]
        .as_str()
        .unwrap()
        .contains("EDITOR"));
}

#[test]
fn an_unchanged_draft_writes_nothing() {
    let env = Env::new("edit-unchanged");
    env.init();
    env.run(&["create", "n", "--body", "same"]).assert_ok();
    let before = fs::metadata(env.note("n")).unwrap().modified().unwrap();
    std::thread::sleep(Duration::from_millis(20));
    let output = env
        .command()
        .env("VISUAL", "true")
        .env("EDITOR", "false")
        .args(["--json", "edit", "n"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "VISUAL wins over EDITOR: {output:?}"
    );
    assert_eq!(
        fs::metadata(env.note("n")).unwrap().modified().unwrap(),
        before
    );
}

#[test]
fn a_failed_editor_keeps_the_draft_and_leaves_the_note() {
    let env = Env::new("edit-fails");
    env.init();
    env.run(&["create", "n", "--body", "original"]).assert_ok();
    let editor = editor_script(&env, "editor", r#"printf 'half done' > "$1"; exit 3"#);
    let output = env
        .command()
        .env("EDITOR", &editor)
        .args(["--json", "edit", "n"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let draft = value["data"]["draftPath"].as_str().unwrap();
    assert_eq!(fs::read_to_string(draft).unwrap(), "half done");
    assert_eq!(env.run(&["read", "n"]).stdout, "original");
}

#[test]
fn a_note_changed_during_editing_parks_the_draft() {
    let env = Env::new("edit-parked");
    env.init();
    env.run(&["create", "n", "--body", "base"]).assert_ok();
    // The "editor" changes the note from another CLI process, then saves.
    let editor = editor_script(
        &env,
        "editor",
        &format!(
            "'{bin}' append n --body ' peer'\nprintf 'mine' > \"$1\"",
            bin = common::BIN
        ),
    );
    let output = env
        .command()
        .env("EDITOR", &editor)
        .args(["--json", "edit", "n"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["error"]["code"], "draft_parked");
    let parked = value["data"]["parkedId"].as_str().unwrap();
    assert_eq!(env.run(&["read", "n"]).stdout, "base peer");
    assert_eq!(env.run(&["read", parked]).stdout, "mine");
}

#[test]
fn a_failed_save_keeps_the_draft() {
    let env = Env::new("edit-save-fails");
    let root = env.init();
    env.run(&["create", "n", "--body", "base"]).assert_ok();
    let editor = editor_script(
        &env,
        "editor",
        &format!(
            "printf 'mine' > \"$1\"\nchmod 0555 '{}'\nchmod 0444 '{}'",
            root.display(),
            root.join("n.md").display()
        ),
    );
    let output = env
        .command()
        .env("EDITOR", &editor)
        .args(["--json", "edit", "n"])
        .output()
        .unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let draft = value["data"]["draftPath"].as_str().unwrap();
    assert_eq!(fs::read_to_string(draft).unwrap(), "mine");
}

#[test]
fn every_json_command_prints_exactly_one_object() {
    let env = Env::new("json");
    env.init();
    for args in [
        vec!["--json", "status"],
        vec!["--json", "create", "j", "--body", "x"],
        vec!["--json", "append", "j", "--body", "y"],
        vec!["--json", "read", "j"],
        vec!["--json", "list"],
        vec!["--json", "search", "x"],
        vec!["--json", "rename", "j", "k"],
        vec!["--json", "move", "k", "--folder", "f"],
        vec!["--json", "read", "missing"],
        vec!["--json", "sync"],
        vec!["--json", "auth", "logout"],
        vec!["--json", "init", env.vault().to_str().unwrap()],
        vec!["--json", "bogus-command"],
    ] {
        let run = env.run(&args);
        let value = run.json();
        if run.status == 0 {
            assert!(value["data"].is_object(), "{args:?}: {value}");
        } else {
            assert!(value["error"]["code"].is_string(), "{args:?}: {value}");
        }
    }
    let read = env.run(&["--json", "read", "f/k"]).json();
    assert_eq!(
        read["data"],
        serde_json::json!({"id": "f/k", "content": "xy"})
    );
    let list = env.run(&["--json", "list"]).json();
    assert_eq!(
        list["data"]["notes"][0],
        serde_json::json!({"id": "f/k", "title": "k", "folder": "f"})
    );
}

#[test]
fn sync_with_no_password_and_no_terminal_fails_at_once() {
    let env = Env::new("no-terminal");
    env.init();
    let config = format!(
        r#"{{"version":1,"vault":"{}","server":"http://127.0.0.1:9"}}"#,
        fs::canonicalize(env.vault()).unwrap().display()
    );
    fs::write(env.config_file(), config).unwrap();
    for args in [vec!["--json", "sync"], vec!["sync"]] {
        let run = env.run(&args);
        run.assert_status(1);
        assert!(run.elapsed < Duration::from_secs(5));
        if args[0] == "--json" {
            assert_eq!(run.error_code(), "auth_failed");
        }
    }
}
