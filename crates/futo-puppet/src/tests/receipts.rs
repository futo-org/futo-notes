use super::*;

#[test]
fn events_render_one_line_each_and_collapse_move_runs() {
    let events = json!([
        {"id": 7, "t": 1200, "type": "touchstart", "trusted": true, "x": 40, "y": 60,
         "target": "e9", "component": "MilkdownEditor.svelte",
         "handlers": [{"fn": "pm", "on": "e9", "prevented": true, "stopped": false}],
         "editor": {"resolved": 12, "settled": {"from": 12, "to": 12}}},
        {"id": 8, "t": 1210, "type": "pointermove", "trusted": true, "x": 41, "y": 60, "target": "e9", "component": null, "handlers": []},
        {"id": 9, "t": 1220, "type": "touchmove", "trusted": true, "x": 42, "y": 60, "target": "e9", "component": null, "handlers": []},
        {"id": 10, "t": 1300, "type": "keydown", "trusted": false, "key": "b", "modifiers": "meta", "target": "e9", "component": null,
         "handlers": [{"fn": "onKey", "on": "e2", "threw": "boom"}]},
        {"id": 11, "t": 1400, "type": "selectionchange", "trusted": true, "target": "e9", "component": null, "handlers": [], "selection": {"from": 10, "to": 15}}
    ]);
    assert_eq!(
        render_events(events.as_array().unwrap(), false),
        "#7      1200ms  touchstart  @40,60  → e9 MilkdownEditor.svelte  handlers: pm@e9!prevent  editor: resolved 12 settled 12-12\n\
         #8      1210ms  pointermove/touchmove ×2  @42,60  → e9 -\n\
         #10     1300ms  keydown  key=\"b\"  meta  synthetic  → e9 -  handlers: onKey@e2!threw(boom)\n\
         #11     1400ms  selectionchange  → e9 -  selection 10-15\n"
    );
}

#[test]
fn diffs_render_as_change_lines_or_no_change() {
    let empty =
        json!({"before": 1, "after": 2, "elements": {"added": [], "removed": [], "changed": []}});
    assert_eq!(render_diff(&empty), "no change\n");
    let diff = json!({
        "before": 1, "after": 2,
        "doc": {"line": 1, "removed": "brown", "inserted": "**brown**"},
        "selection": [{"from": 10, "to": 15}, {"from": 12, "to": 17}],
        "state": {"note.dirty": [false, true]},
        "elements": {
            "added": [{"ref": "e4", "component": "FindBar.svelte", "role": "search", "text": "", "handlers": [], "flags": ["focused"], "rect": {"x": 0, "y": 0, "w": 300, "h": 40}, "section": "main · find", "verb": "SetFindQuery"}],
            "removed": [],
            "changed": [{"ref": "e1", "component": null, "role": "editor", "text": "the quick…", "section": "main", "rect": [{"x": 0, "y": 40, "w": 300, "h": 500}, {"x": 0, "y": 80, "w": 300, "h": 460}]}]
        }
    });
    assert_eq!(
        render_diff(&diff),
        "doc L1 -\"brown\" +\"**brown**\"\n\
         selection 10-15 → 12-17\n\
         note.dirty false → true\n\
         + main · find: e4  FindBar  search  \"\"  focused  0,0 300×40  → SetFindQuery\n\
         ~ main: e1 - editor \"the quick…\"  rect 0,40 300×500 → 0,80 300×460\n"
    );
}

#[test]
fn an_action_renders_header_events_then_diff() {
    let action = json!({
        "id": 3, "kind": "gesture", "before": 5, "after": 6, "events": [40, 42],
        "trace": [{"id": 41, "t": 9, "type": "click", "trusted": true, "x": 1, "y": 2, "target": "e1", "component": null, "handlers": []}],
        "diff": {"before": 5, "after": 6, "elements": {"added": [], "removed": [], "changed": []}}
    });
    assert_eq!(
        render_action(&action),
        "action 3 gesture · snapshots 5 → 6 · events 2\n#41        9ms  click  @1,2  → e1 -\nno change\nthe click landed on e1 -, which has no click handler — aim with {\"ref\":\"eN\"} at the element you meant\n"
    );
    let handled = json!({
        "id": 4, "kind": "gesture", "before": 6, "after": 7, "events": [0, 1],
        "trace": [{"id": 42, "t": 9, "type": "click", "trusted": true, "x": 1, "y": 2, "target": "e1", "component": null,
                   "handlers": [{"fn": "onclick", "on": "e1"}]}],
    });
    assert!(render_action(&handled).ends_with("no change\n"));
}

#[test]
fn a_receipt_reads_verdict_answer_effects_then_rows_and_drops_nothing() {
    let row = json!({"ref": "e7", "role": "button", "component": "Row.svelte", "text": "retro",
                     "flags": ["selected"], "handlers": ["click=open"], "rect": {"x": 8, "y": 40, "w": 200, "h": 30},
                     "section": "sidebar", "verb": "OpenNote"});
    let long = "a value much longer than the eighty characters the old receipts cut every state value down to";
    let receipt = json!({"verb": "CreateNote", "status": 200, "result": {
        "ok": true, "verb": "CreateNote", "action": 12, "events": 3, "noteId": "work/retro",
        "diff": {"before": 4, "after": 5, "screen": ["home", "editor:work/retro"],
                 "vault": {"notes": {"added": ["work/retro"]}},
                 "state": {"settings.theme": ["auto", long]},
                 "elements": {"added": [row], "removed": [], "changed": []},
                 "panel": {"open": [false, true]}},
        "fresh": "a field no renderer knows"}});
    let text = render_step(&receipt, true);
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(
        lines[0],
        "OK CreateNote · action 12 · events 3 · snapshots 4 → 5"
    );
    // What the verb answered comes before what it did.
    assert!(text.find("noteId \"work/retro\"") < text.find("screen \"home\""));
    for fact in [
        "fresh \"a field no renderer knows\"",
        "screen \"home\" → \"editor:work/retro\"",
        "vault +note \"work/retro\"",
        long,
        "panel {\"open\":[false,true]}",
    ] {
        assert!(text.contains(fact), "{fact} missing from\n{text}");
    }
    // The row comes after every fact, on one line with every field: its handlers as what a
    // person can do to it, as `elements` prints them (`events` names the functions).
    let row_line = lines.last().unwrap();
    for field in [
        "sidebar",
        "e7",
        "Row",
        "button",
        "\"retro\"",
        "click",
        "selected",
        "8,40 200×30",
        "→ OpenNote",
    ] {
        assert!(row_line.contains(field), "{field} missing from {row_line}");
    }
}

/// A change a person cannot see is only where it is.
#[test]
fn a_change_off_screen_renders_only_where_it_is() {
    let diff = json!({
        "before": 1, "after": 2,
        "doc": {"line": 4000, "to": 4010, "offScreen": true},
        "elements": {"added": [], "removed": [], "changed": []}
    });
    assert_eq!(render_diff(&diff), "doc L4000–4010 changed off screen\n");
}

/// A refusal for a place off screen prints the batch that brings it on, ready to paste.
#[test]
fn an_off_screen_refusal_prints_the_way_there() {
    let receipt = json!({"verb": "OpenNote", "status": 409, "result": {
        "ok": false,
        "error": "\"mom's list\" is not on screen",
        "reach": [["ScrollToRow", {"noteId": "mom's list"}]]
    }});
    assert_eq!(
        render_step(&receipt, true),
        concat!(
            r#"REFUSED 409 OpenNote: "mom's list" is not on screen"#,
            "\n",
            r#"reach it: do "[[\"ScrollToRow\",{\"noteId\":\"mom's list\"}]]""#,
            "\n"
        )
    );
}

/// A gesture says its verdict first, as a `do` step does, and a refusal goes the same way: the
/// batch that reaches its place, through the one renderer every refusal uses.
#[test]
fn a_gesture_reads_ok_or_refused_like_a_step() {
    let traced = Reply {
        status: 200,
        body: json!({"id": 12, "kind": "gesture", "before": 4, "after": 5, "events": [7, 10],
                     "trace": [], "diff": {"elements": {"added": [], "removed": [], "changed": []}}}),
    };
    assert!(render_gesture("click", &traced)
        .starts_with("OK click · action 12 · events 3 · snapshots 4 → 5\n"));
    let native = Reply {
        status: 200,
        body: json!({"kind": "tap", "screen": "list", "diff": {"elements": {}}}),
    };
    assert!(render_gesture("tap", &native).starts_with("OK tap · screen list\n"));
    let refused = Reply {
        status: 409,
        body: json!({"ok": false, "error": "\"zzz\" is not on screen", "reach": [["ScrollToLine", {"line": 40}]]}),
    };
    assert_eq!(
        render_gesture("tap", &refused),
        "REFUSED 409 tap: \"zzz\" is not on screen\nreach it: do '[[\"ScrollToLine\",{\"line\":40}]]'\n"
    );
}

/// The listener's numbers are untrusted: a malformed record counts nothing, never panics.
#[test]
fn a_malformed_event_range_counts_nothing() {
    assert_eq!(event_count(&json!({"events": [7, 3]})), 0);
    assert_eq!(event_count(&json!({"events": [5]})), 0);
    assert_eq!(event_count(&json!({"events": [3, 7]})), 4);
}

/// One key press the way the desktop editor records it: keydown through keyup.
fn press(id: u64, key: &str, prevented: bool) -> Vec<Value> {
    let on_key = json!([{"fn": "pm", "on": "e30", "prevented": prevented, "stopped": false}]);
    let mut press = vec![
        json!({"id": id, "t": id * 10, "type": "keydown", "trusted": true, "key": key, "target": "e30", "component": "MilkdownEditor.svelte", "handlers": on_key}),
    ];
    if !prevented {
        for (offset, kind) in ["beforeinput", "input"].iter().enumerate() {
            press.push(json!({"id": id + 1 + offset as u64, "t": id * 10, "type": kind, "trusted": true, "data": key, "target": "e30", "component": "MilkdownEditor.svelte",
                "handlers": [{"fn": "onEdit", "on": "document", "prevented": false, "stopped": false}]}));
        }
    }
    press.push(json!({"id": id + 3, "t": id * 10, "type": "selectionchange", "trusted": true, "target": "e30", "component": "MilkdownEditor.svelte", "handlers": [], "selection": {"from": id, "to": id}}));
    press.push(json!({"id": id + 4, "t": id * 10, "type": "keyup", "trusted": true, "key": key, "target": "e30", "component": "MilkdownEditor.svelte", "handlers": []}));
    press
}

#[test]
fn a_receipt_prints_each_run_of_alike_key_presses_as_one_line() {
    let mut events: Vec<Value> = ["l", "e", "a"]
        .iter()
        .enumerate()
        .flat_map(|(index, key)| press(10 * (index as u64 + 1), key, false))
        .collect();
    events.extend(press(40, "Enter", true));
    events.extend(press(50, "Backspace", false));
    events.extend(press(60, "Backspace", false));
    assert_eq!(
        render_events(&events, true),
        "#10      100ms  keys \"lea\" ×3: keydown/beforeinput/input/selectionchange/keyup  → e30 MilkdownEditor.svelte  handlers: pm@e30 onEdit@document  selection 30-30\n\
         #40      400ms  keys \"Enter\": keydown/selectionchange/keyup  → e30 MilkdownEditor.svelte  handlers: pm@e30!prevent  selection 40-40\n\
         #50      500ms  keys \"Backspace\" ×2: keydown/beforeinput/input/selectionchange/keyup  → e30 MilkdownEditor.svelte  handlers: pm@e30 onEdit@document  selection 60-60\n"
    );
    // `events` answers with every one of them.
    assert_eq!(render_events(&events, false).lines().count(), events.len());
}

#[test]
fn a_chord_prints_event_by_event() {
    let mut chord = vec![
        json!({"id": 1, "t": 0, "type": "keydown", "trusted": true, "key": "Meta", "target": "e30", "component": null, "handlers": []}),
    ];
    chord.extend(press(2, "b", false));
    chord.push(json!({"id": 9, "t": 0, "type": "keyup", "trusted": true, "key": "Meta", "target": "e30", "component": null, "handlers": []}));
    let rendered = render_events(&chord, true);
    assert!(
        rendered.starts_with("#1         0ms  keydown  key=\"Meta\""),
        "{rendered}"
    );
    assert!(rendered.contains("keys \"b\": keydown/"), "{rendered}");
    assert!(
        rendered.ends_with("keyup  key=\"Meta\"  → e30 -\n"),
        "{rendered}"
    );
}
