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
    assert_eq!(landing.plan(true, true, &opened), FindStepPlan::Hold);
    assert_eq!(landing.landing(FindStepPlan::Hold, &opened), None);
    assert_eq!(landing.plan(false, true, &opened), FindStepPlan::Land);
    let first = landing.landing(FindStepPlan::Land, &opened).unwrap();
    assert_eq!(first, opened.current_range.unwrap());
    assert_eq!(landing.plan(false, true, &opened), FindStepPlan::Advance);
    let next = session.find_step(rev, CaretDirection::Forward).unwrap();
    let second = landing.landing(FindStepPlan::Advance, &next).unwrap();
    assert_eq!(next.current, 2);
    assert_ne!(first, second);
    landing.reset();
    assert_eq!(landing.plan(false, true, &opened), FindStepPlan::Land);
}

#[test]
fn a_press_with_no_match_stays_a_first_press() {
    let mut session = EditorSession::open(SOURCE);
    let rev = session.revision();
    let mut landing = FindLanding::default();
    let none = session.find_set_query(rev, "zzz").unwrap();
    assert_eq!(landing.landing(FindStepPlan::Land, &none), None);
    assert_eq!(landing.plan(false, true, &none), FindStepPlan::Land);
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
        assert_eq!(landing.plan(false, true, &report), FindStepPlan::Advance);
        let stepped = session.find_step(rev, direction).unwrap();
        assert_eq!(
            landing.landing(FindStepPlan::Advance, &stepped),
            Some(expected)
        );
        assert_eq!(stepped.current_range, Some(expected));
    }
}

const FOUR: &str = "cat\n\ncat\n\ncat\n\ncat\n"; // matches at 0..3, 5..8, 10..13, 15..18

fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

/// One press as `NativeEditorSession::find_step_landing` runs it.
fn press(
    session: &mut EditorSession,
    landing: &mut FindLanding,
    forward: bool,
) -> Option<DisplayRange> {
    let rev = session.revision();
    let plan = landing.plan(false, forward, &session.find_report());
    let report = if plan == FindStepPlan::Advance {
        let direction = if forward {
            CaretDirection::Forward
        } else {
            CaretDirection::Backward
        };
        session.find_step(rev, direction).unwrap()
    } else {
        session.find_report()
    };
    landing.landing(plan, &report)
}

fn edit(session: &mut EditorSession, at: DisplayRange, text: &str) {
    let rev = session.revision();
    session.replace(rev, at, text, &mut |_| Ok(())).unwrap();
}

fn rescan(session: &mut EditorSession) {
    let request = session.find_scan_request().unwrap();
    assert!(session.find_apply_scan(&request.run()).is_some());
}

/// Find open on `FOUR` with two presses taken: the user is on the second match (5..8).
fn on_the_second_match() -> (EditorSession, FindLanding) {
    let mut session = EditorSession::open(FOUR);
    let rev = session.revision();
    session.find_set_query(rev, "cat").unwrap();
    let mut landing = FindLanding::default();
    press(&mut session, &mut landing, true);
    assert_eq!(press(&mut session, &mut landing, true), Some(range(5, 8)));
    (session, landing)
}

#[test]
fn after_an_edit_drops_the_current_match_next_goes_at_or_after_it_and_previous_before_it() {
    // One rule, whether or not a rescan has landed: Next to the first match at or after where
    // the user was (10..13), Previous to the last one before it (0..3).
    for rescanned in [false, true] {
        for forward in [true, false] {
            let (mut session, mut landing) = on_the_second_match();
            edit(&mut session, range(6, 7), "x");
            if rescanned {
                rescan(&mut session);
                let report = session.find_report();
                assert_eq!((report.total, report.current), (3, 2));
            }
            let first = if forward { range(10, 13) } else { range(0, 3) };
            let label = format!("rescanned={rescanned} forward={forward}");
            assert_eq!(
                press(&mut session, &mut landing, forward),
                Some(first),
                "{label}"
            );
            // Then presses move on from there, with wrap.
            assert_eq!(
                press(&mut session, &mut landing, forward),
                Some(range(15, 18)),
                "{label}"
            );
        }
    }
}

#[test]
fn previous_after_a_dropped_first_match_wraps_to_the_last_with_or_without_a_rescan() {
    for rescanned in [false, true] {
        let mut session = EditorSession::open(FOUR);
        let rev = session.revision();
        session.find_set_query(rev, "cat").unwrap();
        let mut landing = FindLanding::default();
        assert_eq!(press(&mut session, &mut landing, true), Some(range(0, 3)));
        edit(&mut session, range(1, 2), "x");
        if rescanned {
            rescan(&mut session);
        }
        assert_eq!(
            press(&mut session, &mut landing, false),
            Some(range(15, 18)),
            "rescanned={rescanned}"
        );
    }
}

/// 65 one-byte edits with no find read between them: past the engine's edit log.
fn overflow(session: &mut EditorSession, at: usize) {
    for _ in 0..65 {
        edit(session, range(at, at), "z");
    }
}

#[test]
fn an_overflowed_edit_log_after_the_current_match_does_not_take_it() {
    for forward in [true, false] {
        let (mut session, mut landing) = on_the_second_match();
        overflow(&mut session, 19);
        rescan(&mut session);
        let moved = if forward { range(10, 13) } else { range(0, 3) };
        assert_eq!(press(&mut session, &mut landing, forward), Some(moved));
    }
}

#[test]
fn an_overflowed_edit_log_before_the_current_match_keeps_the_users_own_match() {
    // 65 inserts at 0 move the user's match to 70..73; the rescan must not pick an earlier one.
    for forward in [true, false] {
        let (mut session, mut landing) = on_the_second_match();
        overflow(&mut session, 0);
        rescan(&mut session);
        let report = session.find_report();
        assert_eq!(report.current_range, Some(range(70, 73)));
        let moved = if forward {
            range(75, 78)
        } else {
            range(65, 68)
        };
        assert_eq!(press(&mut session, &mut landing, forward), Some(moved));
    }
}

#[test]
fn an_overflowed_edit_log_that_touched_the_current_match_drops_it() {
    let (mut session, mut landing) = on_the_second_match();
    edit(&mut session, range(6, 7), "x");
    overflow(&mut session, 19);
    rescan(&mut session);
    assert_eq!(press(&mut session, &mut landing, true), Some(range(10, 13)));
}

#[test]
fn an_edit_that_leaves_the_current_match_in_place_still_advances_after_a_rescan() {
    let (mut session, mut landing) = on_the_second_match();
    edit(&mut session, range(4, 4), "z"); // between the first and second match
    edit(&mut session, range(19, 19), "z"); // after the last
    rescan(&mut session);
    let report = session.find_report();
    assert_eq!((report.total, report.current), (4, 2));
    assert_eq!(press(&mut session, &mut landing, true), Some(range(11, 14)));
    assert_eq!(press(&mut session, &mut landing, false), Some(range(6, 9)));
}

#[test]
fn undoing_the_dropping_edit_then_rescanning_lands_on_the_restored_match() {
    let (mut session, mut landing) = on_the_second_match();
    edit(&mut session, range(6, 7), "x");
    let rev = session.revision();
    session.undo(rev, &mut |_| Ok(())).unwrap().unwrap();
    rescan(&mut session);
    let report = session.find_report();
    assert_eq!((report.total, report.current), (4, 2));
    assert_eq!(press(&mut session, &mut landing, true), Some(range(5, 8)));
    assert_eq!(press(&mut session, &mut landing, true), Some(range(10, 13)));
}
