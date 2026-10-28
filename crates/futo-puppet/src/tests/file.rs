use super::*;

fn narrowed(args: Value) -> Result<String, String> {
    let note = json!({ "noteId": "work/retro", "text": "# Retro\n\nlease due\nrent\nnotes\nlease signed\n" });
    let mut args = args;
    args["noteId"] = json!("work/retro");
    Ok(render_file(&FileQuery::parse(&args)?.apply(&note)?))
}

#[test]
fn file_prints_every_line_numbered_unless_narrowed() {
    assert_eq!(
        narrowed(json!({})).unwrap(),
        "work/retro · 6 lines\n1│# Retro\n2│\n3│lease due\n4│rent\n5│notes\n6│lease signed\n"
    );
    assert_eq!(
        narrowed(json!({ "lines": "3-4" })).unwrap(),
        "work/retro · 6 lines · lines 3–4\n3│lease due\n4│rent\n"
    );
    assert_eq!(
        narrowed(json!({ "lines": "5-" })).unwrap(),
        "work/retro · 6 lines · lines 5–6\n5│notes\n6│lease signed\n"
    );
    assert_eq!(
        render_file(
            &json!({ "noteId": "a", "lineCount": 1, "lines": [{ "line": 1, "text": "x" }] })
        ),
        "a · 1 line\n1│x\n"
    );
    let unterminated = json!({ "noteId": "a", "text": "x\ny" });
    assert_eq!(
        render_file(
            &FileQuery::parse(&json!({ "noteId": "a" }))
                .unwrap()
                .apply(&unterminated)
                .unwrap()
        ),
        "a · 2 lines · no newline at end\n1│x\n2│y\n"
    );
    assert_eq!(
        narrowed(json!({ "save": false, "lines": "3" })).unwrap(),
        "work/retro · 6 lines · read without saving first: any edits not saved yet are not in it · lines 3–3\n3│lease due\n"
    );
    assert_eq!(
        narrowed(json!({ "save": false, "lines": "9-" })).unwrap_err(),
        "file: line 9 is past the end; \"work/retro\" has 6 lines, read without saving first: any edits not saved yet are not in it"
    );
    assert_eq!(
        narrowed(json!({ "lines": "2" })).unwrap(),
        "work/retro · 6 lines · lines 2–2\n2│\n"
    );
}

#[test]
fn file_find_prints_the_matches_with_lines_around_them_and_marks_a_gap() {
    assert_eq!(
        narrowed(json!({ "find": "lease" })).unwrap(),
        "work/retro · 6 lines · \"lease\" on lines 3, 6\n3│lease due\n…\n6│lease signed\n"
    );
    assert_eq!(
        narrowed(json!({ "find": "lease", "around": 1 })).unwrap(),
        "work/retro · 6 lines · \"lease\" on lines 3, 6, 1 around each\n2│\n3│lease due\n4│rent\n5│notes\n6│lease signed\n"
    );
    // A range narrows where find looks, and its edges bound the lines around a match.
    assert_eq!(
        narrowed(json!({ "find": "lease", "around": 2, "lines": "1-4" })).unwrap(),
        "work/retro · 6 lines · lines 1–4 · \"lease\" on line 3, 2 around each\n1│# Retro\n2│\n3│lease due\n4│rent\n"
    );
    assert_eq!(
        narrowed(json!({ "find": "rent", "around": u64::MAX })).unwrap(),
        "work/retro · 6 lines · \"rent\" on line 4, 18446744073709551615 around each\n1│# Retro\n2│\n3│lease due\n4│rent\n5│notes\n6│lease signed\n"
    );
    assert_eq!(
        narrowed(json!({ "find": "Lease" })).unwrap(),
        "work/retro · 6 lines · no line contains \"Lease\"\n"
    );
}

#[test]
fn file_refuses_what_it_cannot_narrow_before_asking_the_app() {
    for args in [
        json!({}),
        json!({ "noteId": "" }),
        json!({ "noteId": "a", "line": 3 }),
        json!({ "noteId": "a", "lines": "9-3" }),
        json!({ "noteId": "a", "lines": "0" }),
        json!({ "noteId": "a", "lines": "x" }),
        json!({ "noteId": "a", "find": "" }),
        json!({ "noteId": "a", "find": "x", "around": -1 }),
        json!({ "noteId": "a", "lines": 2 }),
        json!({ "noteId": "a", "save": "no" }),
    ] {
        assert!(FileQuery::parse(&args).is_err(), "{args}");
    }
    assert!(FileQuery::parse(&json!({ "noteId": "a", "around": 2 }))
        .is_err_and(|error| error.contains("give find too")));
    assert_eq!(
        narrowed(json!({ "lines": "9-12" })).unwrap_err(),
        "file: line 9 is past the end; \"work/retro\" has 6 lines"
    );
}

/// `save` reaches the app: dropped, every `"save":false` read would save first while its header
/// said it had not.
#[test]
fn file_sends_save_to_the_app() {
    let (port, scripts) = super::gestures::fake_bridge(|_| {
        json!({"id": "futo-puppet", "success": true,
               "data": json!({"status": 200, "body": {"noteId": "a", "text": "x\n"}}).to_string()})
    });
    let target = Target::Desktop(port);
    file(&target, &json!({ "noteId": "a", "save": false })).unwrap();
    file(&target, &json!({ "noteId": "a" })).unwrap();
    assert_eq!(
        *scripts.lock().unwrap(),
        [
            forward_script("file", &json!({ "noteId": "a", "save": false })),
            forward_script("file", &json!({ "noteId": "a", "save": true })),
        ]
    );
}
