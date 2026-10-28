use super::*;

fn pointer(json: &str) -> Pointer {
    serde_json::from_str(json).unwrap()
}

#[test]
fn a_click_is_down_then_up_and_a_double_click_counts_the_second_pair() {
    let phases = |steps: &[Step]| steps.iter().map(|s| (s.phase, s.count)).collect::<Vec<_>>();
    assert_eq!(
        phases(&steps(&pointer(r#"{"kind":"click","x":10,"y":20}"#)).unwrap()),
        [(Phase::Down, 1), (Phase::Up, 1)]
    );
    assert_eq!(
        phases(&steps(&pointer(r#"{"kind":"click","x":10,"y":20,"count":2}"#)).unwrap()),
        [
            (Phase::Down, 1),
            (Phase::Up, 1),
            (Phase::Down, 2),
            (Phase::Up, 2)
        ]
    );
    assert!(
        steps(&pointer(r#"{"kind":"click","x":1,"y":1,"button":"right"}"#))
            .unwrap()
            .iter()
            .all(|s| s.right)
    );
}

#[test]
fn a_drag_walks_from_start_to_end_and_ends_exactly_there() {
    let steps = steps(&pointer(
        r#"{"kind":"drag","x":0,"y":0,"x2":80,"y2":40,"duration":0.9}"#,
    ))
    .unwrap();
    assert_eq!(steps.len() as u32, DRAG_SAMPLES + 2);
    assert_eq!(
        (steps[0].phase, steps[0].x, steps[0].y),
        (Phase::Down, 0.0, 0.0)
    );
    let last = steps.last().unwrap();
    assert_eq!((last.phase, last.x, last.y), (Phase::Up, 80.0, 40.0));
    assert!(steps[1..]
        .iter()
        .all(|s| s.delay == Duration::from_millis(100)));
    assert_eq!(
        steps[1..DRAG_SAMPLES as usize + 1]
            .iter()
            .filter(|s| s.phase == Phase::Dragged)
            .count(),
        DRAG_SAMPLES as usize
    );
}

#[test]
fn a_scroll_is_a_run_of_wheel_notches_that_adds_up_to_the_distance() {
    let notches = steps(&pointer(r#"{"kind":"scroll","x":5,"y":6,"dy":100}"#)).unwrap();
    assert_eq!(notches.len(), 3);
    assert!(notches
        .iter()
        .all(|s| s.phase == Phase::Wheel && (s.x, s.y) == (5.0, 6.0)));
    assert!((notches.iter().map(|s| s.dy).sum::<f64>() - 100.0).abs() < 1e-9);
    assert!(notches.iter().all(|s| s.delay == Duration::ZERO));
    let long = steps(&pointer(r#"{"kind":"scroll","x":0,"y":0,"dy":3000}"#)).unwrap();
    assert_eq!(long.len() as u32, MAX_WHEEL_NOTCHES);
    assert!((long.iter().map(|s| s.dy).sum::<f64>() - 3000.0).abs() < 1e-9);
    let sideways = steps(&pointer(r#"{"kind":"scroll","x":0,"y":0,"dx":-30}"#)).unwrap();
    assert_eq!(
        (sideways.len(), sideways[0].dx, sideways[0].dy),
        (1, -30.0, 0.0)
    );
}

#[test]
fn steps_closer_than_a_trip_share_one_and_a_wider_gap_stays_paced() {
    let trip_count = |json: &str| trips(&steps(&pointer(json)).unwrap()).count();
    assert_eq!(
        trip_count(r#"{"kind":"drag","x":0,"y":0,"x2":80,"y2":0}"#),
        1
    );
    assert_eq!(trip_count(r#"{"kind":"scroll","x":0,"y":0,"dy":1000}"#), 1);
    assert_eq!(trip_count(r#"{"kind":"click","x":1,"y":1,"count":2}"#), 1);
    // A hold's release waits its own trip; a slow drag keeps every sample paced.
    assert_eq!(trip_count(r#"{"kind":"click","x":1,"y":1,"hold":0.8}"#), 2);
    assert_eq!(
        trip_count(r#"{"kind":"drag","x":0,"y":0,"x2":80,"y2":0,"duration":2}"#),
        DRAG_SAMPLES as usize + 2
    );
}

#[test]
fn a_hold_is_a_click_whose_release_waits() {
    let held = steps(&pointer(r#"{"kind":"click","x":1,"y":2,"hold":0.8}"#)).unwrap();
    assert_eq!(held.len(), 2);
    assert_eq!(held[1].phase, Phase::Up);
    assert_eq!(held[1].delay, Duration::from_millis(800));
    assert!(steps(&pointer(
        r#"{"kind":"click","x":1,"y":2,"hold":0.8,"count":2}"#
    ))
    .is_err());
    assert!(
        steps(&pointer(r#"{"kind":"drag","x":1,"y":2,"x2":1,"y2":2}"#))
            .unwrap_err()
            .contains("hold")
    );
}

#[test]
fn a_negative_or_too_long_hold_or_duration_and_too_many_clicks_are_refused() {
    for json in [
        r#"{"kind":"click","x":1,"y":2,"hold":-0.5}"#,
        r#"{"kind":"click","x":1,"y":2,"hold":1e20}"#,
        r#"{"kind":"click","x":1,"y":2,"hold":3.5}"#,
        r#"{"kind":"drag","x":0,"y":0,"x2":80,"y2":0,"duration":-1}"#,
        r#"{"kind":"drag","x":0,"y":0,"x2":80,"y2":0,"duration":60}"#,
        r#"{"kind":"click","x":1,"y":2,"count":100000}"#,
    ] {
        assert!(steps(&pointer(json)).is_err(), "{json}");
    }
    assert!(steps(&pointer(r#"{"kind":"click","x":1,"y":2,"hold":3}"#)).is_ok());
}

#[test]
fn devtools_holds_the_button_through_a_drag_and_scrolls_by_the_wheel_delta() {
    let drag = steps(&pointer(
        r#"{"kind":"drag","x":0,"y":0,"x2":80,"y2":40,"button":"right"}"#,
    ))
    .unwrap();
    let events: Vec<_> = drag
        .iter()
        .map(|step| devtools_mouse_event(*step))
        .collect();
    assert_eq!(
        (events[0]["type"].as_str(), events[0]["buttons"].as_u64()),
        (Some("mousePressed"), Some(2))
    );
    assert!(events[1..events.len() - 1]
        .iter()
        .all(|event| event["type"] == "mouseMoved" && event["buttons"] == 2));
    let last = events.last().unwrap();
    assert_eq!(
        (
            last["type"].as_str(),
            last["buttons"].as_u64(),
            last["x"].as_f64()
        ),
        (Some("mouseReleased"), Some(0), Some(80.0))
    );
    let double = steps(&pointer(r#"{"kind":"click","x":1,"y":2,"count":2}"#)).unwrap();
    assert_eq!(devtools_mouse_event(double[2])["clickCount"], 2);
    let notch = devtools_mouse_event(
        steps(&pointer(r#"{"kind":"scroll","x":5,"y":6,"dy":40}"#)).unwrap()[0],
    );
    assert_eq!(
        (notch["type"].as_str(), notch["deltaY"].as_f64()),
        (Some("mouseWheel"), Some(40.0))
    );
}

#[test]
fn a_gtk_scroll_unit_is_the_views_size_to_the_two_thirds() {
    // Measured on WebKitGTK 2.54: one unit in a 1378 px view was a 123 px `deltaY`.
    assert_eq!(gtk_scroll_units(123.0, 1378.0), 1.0);
    assert_eq!(gtk_scroll_units(-61.5, 1378.0), -0.5);
    // 1000^(2/3) comes out a hair under 100, which WebKit's `int` truncates to 99 too.
    assert_eq!(gtk_scroll_units(99.0, 1000.0), 1.0);
    assert_eq!(gtk_scroll_units(40.0, 0.0), 0.0);
}

#[test]
fn a_gesture_with_any_point_outside_the_web_view_is_refused_whole() {
    let gesture = |json: &str| steps(&pointer(json)).unwrap();
    let click = |x: f64, y: f64| gesture(&format!(r#"{{"kind":"click","x":{x},"y":{y}}}"#));
    assert!(check_bounds(&click(10.0, 20.0), 100.0, 50.0).is_ok());
    assert!(check_bounds(&click(100.0, 50.0), 100.0, 50.0).is_ok());
    assert!(check_bounds(&click(-1.0, 20.0), 100.0, 50.0)
        .unwrap_err()
        .contains("outside the web view"));
    assert!(check_bounds(&click(10.0, 51.0), 100.0, 50.0).is_err());
    // A drag that starts inside and leaves the view sends nothing, not a press with no release.
    let leaving = gesture(r#"{"kind":"drag","x":10,"y":10,"x2":10,"y2":-40}"#);
    assert!(check_bounds(&leaving[..1], 100.0, 50.0).is_ok());
    assert!(check_bounds(&leaving, 100.0, 50.0).is_err());
}

#[test]
fn touch_only_and_unknown_arguments_are_refused_before_anything_is_sent() {
    assert!(steps(&pointer(r#"{"kind":"drag","x":0,"y":0}"#))
        .unwrap_err()
        .contains("x2"));
    assert!(steps(&pointer(r#"{"kind":"scroll","x":0,"y":0}"#))
        .unwrap_err()
        .contains("dy"));
    assert!(steps(&pointer(r#"{"kind":"swipe","x":0,"y":0}"#))
        .unwrap_err()
        .contains("swipe"));
    assert!(steps(&pointer(
        r#"{"kind":"click","x":0,"y":0,"button":"middle"}"#
    ))
    .is_err());
    assert!(serde_json::from_str::<Pointer>(r#"{"kind":"click","x":0,"y":0,"swipe":1}"#).is_err());
}
