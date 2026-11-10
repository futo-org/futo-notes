use futo_notes_editor::host::{plan_find, DisplayMirror, FindLanding, FindStepPlan};
use futo_notes_editor::*;

const SOURCE: &str = "日本 **bo**ld bold\n\nBOLD\n";

fn whole(session: &EditorSession) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(0),
        end: DisplayOffset(session.display_text().len()),
    }
}

#[test]
fn marks_are_utf16_and_reveal_is_the_current_match() {
    let mut session = EditorSession::open(SOURCE);
    let mirror = DisplayMirror::new(&session.display_text());
    let rev = session.revision();
    let report = session.find_set_query(rev, "bold").unwrap();
    let matches = session.find_matches(rev, whole(&session)).unwrap();
    let plan = plan_find(&report, &matches, &mirror, false, true).unwrap();
    assert_eq!((plan.total, plan.current, plan.open), (3, 1, true));
    // "日本 " is three UTF-16 units; the first match follows it.
    assert_eq!(plan.matches, vec![(3, 7), (8, 12), (14, 18)]);
    assert_eq!(plan.reveal, Some((3, 7)));
    // Without a reveal request nothing scrolls; composing hides the marks.
    assert_eq!(
        plan_find(&report, &matches, &mirror, false, false)
            .unwrap()
            .reveal,
        None
    );
    assert!(plan_find(&report, &matches, &mirror, true, true)
        .unwrap()
        .matches
        .is_empty());
}

#[test]
fn a_closed_find_has_no_marks() {
    let mut session = EditorSession::open(SOURCE);
    let mirror = DisplayMirror::new(&session.display_text());
    let rev = session.revision();
    session.find_set_query(rev, "bold").unwrap();
    let report = session.find_close();
    let plan = plan_find(&report, &[], &mirror, false, true).unwrap();
    assert!(!plan.open && plan.matches.is_empty() && plan.total == 0);
}

#[test]
fn the_first_press_lands_and_later_ones_advance_until_the_query_changes() {
    let mut session = EditorSession::open(SOURCE);
    let rev = session.revision();
    let mut landing = FindLanding::default();
    let opened = session.find_set_query(rev, "bold").unwrap();
    assert_eq!(landing.plan(true, &opened), FindStepPlan::Hold);
    assert_eq!(landing.landing(FindStepPlan::Hold, &opened), None);
    assert_eq!(landing.plan(false, &opened), FindStepPlan::Land);
    let first = landing.landing(FindStepPlan::Land, &opened).unwrap();
    assert_eq!(first, opened.current_range.unwrap());
    assert_eq!(landing.plan(false, &opened), FindStepPlan::Advance);
    let next = session.find_step(rev, CaretDirection::Forward).unwrap();
    let second = landing.landing(FindStepPlan::Advance, &next).unwrap();
    assert_eq!(next.current, 2);
    assert_ne!(first, second);
    landing.reset();
    assert_eq!(landing.plan(false, &opened), FindStepPlan::Land);
}

#[test]
fn a_press_with_no_match_stays_a_first_press() {
    let mut session = EditorSession::open(SOURCE);
    let rev = session.revision();
    let mut landing = FindLanding::default();
    let none = session.find_set_query(rev, "zzz").unwrap();
    assert_eq!(landing.landing(FindStepPlan::Land, &none), None);
    assert_eq!(landing.plan(false, &none), FindStepPlan::Land);
}

#[test]
fn a_first_press_with_matches_but_no_current_one_steps_to_one() {
    // Typing inside the current match drops it from the matches until a rescan lands, leaving
    // matches and no current one; the first press then has to step, not wait for a landing.
    let range = |start, end| DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    };
    for (forward, direction, expected) in [
        (true, CaretDirection::Forward, range(5, 8)),
        (false, CaretDirection::Backward, range(10, 13)),
    ] {
        let mut session = EditorSession::open("cat\n\ncat\n\ncat\n");
        let rev = session.revision();
        session.find_set_query(rev, "cat").unwrap();
        let mut accept = |_: &SourceEdit| Ok(());
        session.replace(rev, range(1, 2), "x", &mut accept).unwrap();
        let rev = session.revision();
        let report = session.find_report();
        assert_eq!((report.total, report.current), (2, 0), "forward={forward}");
        let mut landing = FindLanding::default();
        assert_eq!(landing.plan(false, &report), FindStepPlan::Advance);
        let stepped = session.find_step(rev, direction).unwrap();
        assert_eq!(
            landing.landing(FindStepPlan::Advance, &stepped),
            Some(expected)
        );
        assert_eq!(stepped.current_range, Some(expected));
    }
}
