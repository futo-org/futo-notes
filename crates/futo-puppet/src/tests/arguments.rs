use super::*;

#[test]
fn do_accepts_one_verb_with_optional_args() {
    let steps = parse_do(&strings(&["OpenNote", r#"{"noteId":"a"}"#])).unwrap();
    assert_eq!(steps, vec![("OpenNote".to_string(), json!({"noteId":"a"}))]);
    // The verb and its JSON in one quoted argument: the refusal is the call that works.
    let joined = parse_do(&strings(&[r#"OpenNote {"noteId":"a"}"#])).unwrap_err();
    assert!(
        joined.ends_with(r#"they go as two: do OpenNote '{"noteId":"a"}'"#),
        "{joined}"
    );
    let gesture = parse_do(&strings(&[r#"scroll {"dy":3}"#])).unwrap_err();
    assert!(
        gesture.ends_with(r#"they go as two: scroll '{"dy":3}'"#),
        "{gesture}"
    );
    assert_eq!(
        parse_do(&strings(&["Bold"])).unwrap(),
        vec![("Bold".to_string(), json!({}))]
    );
}

#[test]
fn do_accepts_an_ordered_batch() {
    let steps = parse_do(&strings(&[
        r#"[["Select",{"from":10,"to":15}],["Bold"],"CloseFind"]"#,
    ]))
    .unwrap();
    assert_eq!(
        steps,
        vec![
            ("Select".to_string(), json!({"from":10,"to":15})),
            ("Bold".to_string(), json!({})),
            ("CloseFind".to_string(), json!({})),
        ]
    );
    assert!(parse_do(&strings(&[r#"[["Select","nope"]]"#])).is_err());
    assert!(parse_do(&strings(&["OpenNote", "[1]"])).is_err());
    assert!(parse_do(&[]).is_err());
}

#[test]
fn queries_take_one_json_object_and_strip_the_json_switch() {
    match parse_invocation(&strings(&["at", r#"{"x":1,"y":2,"json":true}"#])).unwrap() {
        Invocation::Query(command, mut args) => {
            assert_eq!(command, "at");
            assert!(take_json_switch(&mut args));
            assert_eq!(args, json!({"x":1,"y":2}));
        }
        _ => panic!("expected a query"),
    }
    assert!(parse_invocation(&strings(&["at", "[1]"])).is_err());
    assert!(parse_invocation(&[]).is_err());
}

#[test]
fn gestures_and_screenshots_parse_as_their_own_invocations() {
    assert!(matches!(
        parse_invocation(&strings(&["tap", r#"{"x":1,"y":2}"#])).unwrap(),
        Invocation::Gesture(name, _) if name == "tap"
    ));
    assert!(matches!(
        parse_invocation(&strings(&["click", r#"{"x":1,"y":2}"#])).unwrap(),
        Invocation::Gesture(name, _) if name == "click"
    ));
    assert!(matches!(
        parse_invocation(&strings(&["screenshot"])).unwrap(),
        Invocation::Screenshot
    ));
    assert!(matches!(
        parse_invocation(&strings(&["look"])).unwrap(),
        Invocation::Look
    ));
    assert!(matches!(
        parse_invocation(&strings(&["relaunch"])).unwrap(),
        Invocation::Relaunch
    ));
    assert!(matches!(
        parse_invocation(&strings(&["events", r#"{"since":3}"#])).unwrap(),
        Invocation::Query(command, _) if command == "events"
    ));
    assert!(parse_invocation(&strings(&["swipe"])).is_err());
}

/// What a command does not take is refused before anything reaches the app: a batch split by
/// mistake ran half of itself, and the output did not say so.
#[test]
fn extra_input_is_refused_not_dropped() {
    for extra in [
        &["do", "[]"][..],
        &["do", "Bold", "{}", r#"{"x":1}"#],
        &["do", r#"[["Insert",{"text":"a"},{"text":"b"}]]"#],
        &["do", r#"[["Bold"]]"#, "{}"],
        &["click", r#"{"x":1}"#, r#"{"y":2}"#],
        &["state", "{}", "{}"],
        &["look", "{}"],
    ] {
        assert!(parse_invocation(&strings(extra)).is_err(), "{extra:?}");
    }
}

/// `step` is one verb through the same path as `do`'s, its raw switch the CLI's.
#[test]
fn step_takes_one_verb_and_keeps_the_json_switch_for_itself() {
    match parse_invocation(&strings(&["step", "Bold", r#"{"json":true}"#])).unwrap() {
        Invocation::Step(Some((verb, args))) => {
            assert_eq!((verb.as_str(), args), ("Bold", json!({})))
        }
        _ => panic!("expected a step"),
    }
    let batch = parse_invocation(&strings(&["step", r#"[["Bold"],["Italic"]]"#]));
    assert!(batch.is_err_and(|error| error.contains("a batch is `do`")));
    assert!(matches!(
        parse_invocation(&strings(&["step"])).unwrap(),
        Invocation::Step(None)
    ));
}

/// The phones' tools ignore what they do not read: `hodl` sent a short tap where a long press
/// was meant, and `"hold":"0.8"` the same. Refused as desktop's input commands refuse it.
#[test]
fn a_gesture_argument_it_does_not_take_or_of_the_wrong_kind_is_refused() {
    let refused =
        |name: &str, args: Value| parse_invocation(&strings(&[name, &args.to_string()])).err();
    let misspelled = refused("tap", json!({"x": 1, "y": 2, "hodl": 0.8})).unwrap();
    assert!(
        misspelled.contains("not \"hodl\"") && misspelled.contains("hold"),
        "{misspelled}"
    );
    assert!(refused("tap", json!({"x": 1, "y": 2, "hold": "0.8"}))
        .unwrap()
        .contains("seconds"));
    assert!(refused("tap", json!({"x": 1, "y": 2, "hold": -5})).is_some());
    assert!(refused(
        "drag",
        json!({"x": 1, "y": 2, "x2": 3, "y2": 4, "durration": 2})
    )
    .is_some());
    assert!(refused("tap", json!({"ref": "n1", "x": 1}))
        .unwrap()
        .contains("not both"));
    assert!(refused("tap", json!({"text": "Done", "x": 1}))
        .unwrap()
        .contains("not both"));
    assert!(refused("type", json!({"ref": "n3", "text": "a"}))
        .unwrap()
        .contains("focus"));
    for fine in [
        ("tap", json!({"x": 1, "y": 2, "hold": 0.8, "json": true})),
        ("click", json!({"text": "Done", "button": "right"})),
        (
            "drag",
            json!({"x": 1, "y": 2, "x2": 3, "y2": 4, "duration": 0.5}),
        ),
        ("type", json!({"text": "a", "delay": 120})),
        ("press", json!({"key": "Enter", "count": 3})),
    ] {
        assert_eq!(refused(fine.0, fine.1.clone()), None, "{fine:?}");
    }
}
