use super::*;

/// The editor's position verbs as `actions` lists them: the refusal offers the ways out each takes.
fn editor_menu() -> Value {
    let verb = |name: &str, keys: &[&str]| {
        let properties: Map<String, Value> = keys
            .iter()
            .map(|key| (key.to_string(), json!({"type": "string"})))
            .collect();
        json!({"name": name, "schema": {"properties": properties}})
    };
    json!({"actions": [
        verb("Select", &["from", "to", "find", "expect", "docVersion"]),
        verb("Insert", &["at", "after", "before", "text", "docVersion"]),
        verb("PlaceCaret", &["at", "docVersion"]),
        verb("OpenLink", &["at", "find", "newTab"]),
        verb("MoveBlock", &["line", "before", "after"]),
    ]})
}

/// Reusing a position across an edit in the same batch is the failure that
/// reports success: the verb runs, the diff looks plausible, the wrong words
/// changed. The refusal names the step that moved them and the anchor form.
#[test]
fn a_batch_refuses_positions_that_an_earlier_step_has_already_shifted() {
    let menu = editor_menu();
    let refused =
        |verb: &str, args: Value| stale_offsets_refusal(2, verb, &args, (1, "Bold"), &menu);
    let refusal = refused("Select", json!({"from": 46, "to": 50}))
        .expect("an unguarded position after an edit is refused");
    assert!(refusal.contains("step 3 Select"), "{refusal}");
    assert!(refusal.contains("step 2 Bold"), "{refusal}");
    assert!(refusal.contains("\"find\""), "{refusal}");
    assert!(refusal.contains("\"expect\""), "{refusal}");
    assert!(refusal.contains("Nothing was sent"), "{refusal}");
    assert!(refused("Insert", json!({"at": 7, "text": "x"}))
        .expect("Insert takes a position too")
        .contains("\"after\""));
    // Every verb that names a position is held to it, not a list that falls behind the page's.
    let caret = refused("PlaceCaret", json!({"at": 40})).expect("a caret position goes stale too");
    assert!(
        !caret.contains("\"find\"") && caret.contains("call of its own"),
        "{caret}"
    );
    assert!(refused("OpenLink", json!({"at": 40}))
        .expect("a link position goes stale too")
        .contains("OpenLink {\"find\""));

    // A proof survives an edit, so these are exactly as safe as the agent said.
    for (verb, guarded) in [
        ("Select", json!({"from": 46, "to": 50, "expect": "lazy"})),
        ("Select", json!({"find": "lazy"})),
        ("Select", json!({"from": 46, "to": 50, "docVersion": 12})),
        ("Insert", json!({"at": 7, "after": "intro", "text": "x"})),
        ("OpenLink", json!({"find": "wiki"})),
    ] {
        assert_eq!(
            refused(verb, guarded.clone()),
            None,
            "{guarded} is pinned to text"
        );
    }
    // A line is not a position: MoveBlock's numeric `after` is a line, and no proof either.
    for (verb, args) in [
        ("MoveBlock", json!({"line": 5, "after": 3})),
        ("OpenNote", json!({"noteId": "welcome"})),
        ("Bold", json!({})),
    ] {
        assert_eq!(refused(verb, args.clone()), None, "{verb} {args}");
    }
}

#[test]
fn only_an_editor_verbs_text_change_arms_the_guard() {
    assert!(wrote_document(
        &json!({"ok": true, "wrote": {"from": 0, "to": 0, "inserted": "hi"}})
    ));
    assert!(wrote_document(
        &json!({"ok": true, "editor": {"size": 9}, "diff": {"doc": {"line": 2}}})
    ));
    // A tab opened, a folder created: the document is a different document,
    // not a shifted one, and offsets for it were never read here.
    assert!(!wrote_document(&json!({"ok": true, "verb": "OpenNote"})));
    assert!(!wrote_document(
        &json!({"ok": true, "editor": {"size": 9}, "diff": {"selection": []}})
    ));
}

#[test]
fn a_refused_batch_says_why_and_which_steps_never_ran() {
    let steps: Vec<_> = ["ToggleFolder", "OpenNote", "Bold", "Italic"]
        .iter()
        .map(|verb| (verb.to_string(), json!({})))
        .collect();
    let receipts = [
        json!({"verb": "ToggleFolder", "status": 200, "result": {"ok": true}}),
        json!({"verb": "OpenNote", "status": 409, "result": {"ok": false, "error": "no row on screen"}}),
    ];
    assert_eq!(
        render_batch(&receipts, &steps, None, None),
        "OK ToggleFolder\nno change\nREFUSED 409 OpenNote: no row on screen\nnot run: Bold, Italic\n"
    );
    assert_eq!(
        render_batch(
            &receipts[..1],
            &steps[..3],
            Some("REFUSED OpenNote (not sent): offsets moved"),
            None
        ),
        "OK ToggleFolder\nno change\nREFUSED OpenNote (not sent): offsets moved\nnot run: Bold\n"
    );
    // A call that failed after a step ran: what ran, the failure, and what never did.
    assert_eq!(
        render_batch(
            &receipts[..1],
            &steps,
            Some("FAILED OpenNote: the desktop app did not answer"),
            None
        ),
        "OK ToggleFolder\nno change\nFAILED OpenNote: the desktop app did not answer\nnot run: Bold, Italic\n"
    );
}

/// Every line a step prints in full that is not one of its rows, it prints in a batch too.
fn facts_kept(receipt: &Value) -> Result<(), String> {
    let full = render_step(receipt, true);
    let short = render_step(receipt, false);
    let diff = &receipt["result"]["diff"];
    let moved = &receipt["result"]["changedSinceLast"]["diff"];
    let rows: Vec<String> = render_diff_rows(diff)
        .lines()
        .map(str::to_string)
        .chain(
            render_diff_rows(moved)
                .lines()
                .map(|line| format!("  {line}")),
        )
        .collect();
    for line in full.lines() {
        let is_row = rows.iter().any(|row| row == line);
        let empty = line.trim() == "no change";
        if !is_row && !empty && !short.lines().any(|kept| kept == line) {
            return Err(format!("{line:?} is lost from\n{short}"));
        }
    }
    Ok(())
}

#[test]
fn a_batch_keeps_every_steps_facts_and_shows_the_screen_once_as_it_ended() {
    let row = |reference: &str, text: &str| {
        json!({"ref": reference, "role": "button", "text": text, "section": "list",
               "handlers": ["click=open"], "rect": {"x": 0, "y": 0, "w": 10, "h": 10}})
    };
    let steps: Vec<_> = ["OpenSearch", "SetSearchQuery", "CloseSearch", "SetTheme"]
        .iter()
        .map(|verb| (verb.to_string(), json!({})))
        .collect();
    let receipts = [
        json!({"verb": "OpenSearch", "status": 200, "result": {"ok": true, "diff": {
            "state": {"searchOpen": [false, true]},
            "elements": {"added": [row("e9", "Search notes")], "removed": [row("e1", "work")], "changed": []}}}}),
        json!({"verb": "SetSearchQuery", "status": 200, "result": {"ok": true, "query": "lease", "diff": {
            "elements": {"added": [row("e10", "lease notes")], "removed": [], "changed": []}}}}),
        json!({"verb": "CloseSearch", "status": 200, "result": {"ok": true, "diff": {
            "state": {"searchOpen": [true, false]},
            "elements": {"added": [row("e1", "work")], "removed": [row("e9", "Search notes"), row("e10", "lease notes")], "changed": []}}}}),
        json!({"verb": "SetTheme", "status": 200, "result": {"ok": true}}),
    ];
    let net = json!({"elements": {"added": [], "removed": [], "changed": []}});
    let text = render_batch(&receipts, &steps, None, Some(&net));
    assert_eq!(
        text,
        "OK OpenSearch\nsearchOpen false → true\nrows +1 -1 ~0\n\
         OK SetSearchQuery\nquery \"lease\"\nrows +1 -0 ~0\n\
         OK CloseSearch\nsearchOpen true → false\nrows +1 -2 ~0\n\
         OK SetTheme\nno change\n\
         the screen now, against before the batch:\nno row changed\n"
    );
    for receipt in &receipts {
        facts_kept(receipt).unwrap();
    }
    // A batch that opened another screen ends on all of it.
    let opened = json!({"screen": ["list", "editor:a"], "now": [row("e2", "Back")]});
    let text = render_batch(&receipts[..2], &steps[..2], None, Some(&opened));
    assert!(text.ends_with("the screen now, against before the batch:\nscreen \"list\" → \"editor:a\"\nlist\n  e2  -  button  \"Back\"  click  0,0 10×10\n"), "{text}");
    // Without a net change (a single step, a snapshot gone), each step is in full.
    assert_eq!(
        render_batch(&receipts[..1], &steps[..1], None, None),
        render_step(&receipts[0], true)
    );
}

/// The real receipts in this checkout's trace, through the renderer: how big they come out,
/// and which fields fell through to `key value` (each wants a rendering of its own).
/// `cargo test -p futo-puppet -- --ignored --nocapture receipts_from_the_trace`
#[test]
#[ignore]
fn receipts_from_the_trace() {
    let trace =
        std::fs::read_to_string(repo_root().join(".puppet/trace.jsonl")).unwrap_or_default();
    let mut sizes = Vec::new();
    let mut generic: std::collections::BTreeMap<String, usize> = Default::default();
    let known = [
        "OK",
        "REFUSED",
        "screen",
        "doc",
        "selection",
        "vault",
        "copied",
        "wrote",
        "+",
        "-",
        "~",
        "before",
        "no",
        "touch",
        "type",
        "press",
    ];
    for line in trace.lines().rev().take(3000) {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if record["kind"] != "do" {
            continue;
        }
        let text = render_step(&record["record"], true);
        facts_kept(&record["record"]).unwrap();
        for line in text.lines().filter(|line| !line.starts_with(' ')) {
            let key = line.split(' ').next().unwrap_or("");
            // A state path (`settings.theme`) and a section (`sidebar`, then rows) are rendered.
            if !known.contains(&key) && !key.contains('.') && !key.contains(':') {
                *generic.entry(key.to_string()).or_default() += 1;
            }
        }
        sizes.push([
            pretty(&record["record"]).len(),
            text.len(),
            text.lines().count(),
        ]);
    }
    for (name, index) in [("json bytes", 0), ("text bytes", 1), ("text lines", 2)] {
        let mut column: Vec<usize> = sizes.iter().map(|size| size[index]).collect();
        column.sort_unstable();
        let at = |fraction: f64| {
            column
                .get(((column.len() as f64 - 1.0) * fraction) as usize)
                .copied()
                .unwrap_or(0)
        };
        println!("{name}: median {} p90 {} max {}", at(0.5), at(0.9), at(1.0));
    }
    println!("first word of top-level lines with no rendering of their own: {generic:?}");
}
