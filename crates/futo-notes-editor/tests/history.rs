use futo_notes_editor::{DisplayOffset, DisplayRange, EditorSession, HistoryClock, Revision};
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
mod common;
use common::ReferenceView;

#[path = "history/compound.rs"]
mod compound;

#[derive(Default)]
struct Clock(AtomicU64);
impl HistoryClock for Clock {
    fn now(&self) -> Duration {
        Duration::from_millis(self.0.load(Ordering::Relaxed))
    }
}
fn range(a: usize, z: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(a),
        end: DisplayOffset(z),
    }
}
/// Chaos finding lane-1-11: every Undo after a heading shortcut typed into an
/// ordered item returns to a state that was on screen while typing.
#[test]
fn undo_after_a_typed_heading_in_an_item_walks_back_through_typed_states() {
    use futo_notes_editor::{InputAction, ParagraphKey};
    let clock = Arc::new(Clock::default());
    let mut s = EditorSession::open_with_clock("1. first step\n2. second step", clock);
    let mut view = ReferenceView::new("first step\nsecond step");
    s.select(s.revision(), range(11, 11)).unwrap();
    let mut states = vec![(s.source_text(), s.selection())];
    for _ in 0..2 {
        view.apply(
            s.paragraph_key(
                s.revision(),
                s.selection(),
                ParagraphKey::Enter,
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
        );
        states.push((s.source_text(), s.selection()));
    }
    assert_eq!(states[2].0, "1. first step\n\n\n2. second step");
    for (index, ch) in "## Sub heading".chars().enumerate() {
        view.apply(
            s.replace_action(
                s.revision(),
                s.selection(),
                &ch.to_string(),
                InputAction::Typing,
                &mut |_| Ok(()),
            )
            .unwrap(),
        );
        // The typed `##`, the triggering space, and the typed words.
        if matches!(index, 1 | 2) {
            states.push((s.source_text(), s.selection()));
        }
    }
    assert_eq!(
        s.source_text(),
        "1. first step\n\n\n2. ## Sub headingsecond step"
    );
    assert_eq!(view.text, "first step\n\n\nSub headingsecond step");
    assert_eq!(states[3].0, "1. first step\n\n\n2. ##second step");
    assert_eq!(states[4].0, "1. first step\n\n\n2. ## second step");
    for (source, selection) in states.into_iter().rev() {
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), source);
        assert_eq!(s.selection(), selection);
        if source == "1. first step\n2. second step" {
            break;
        }
    }
    assert_eq!(s.source_text(), "1. first step\n2. second step");
    assert_eq!(view.text, "first step\nsecond step");
}

#[test]
fn typing_groups_use_the_injected_clock_and_exact_pause_boundary() {
    let clock = Arc::new(Clock::default());
    let mut session = EditorSession::open_with_clock("__日__\r\n", clock.clone());
    let mut view = ReferenceView::new("日\r\n");
    view.apply(
        session
            .replace(Revision(0), range(3, 3), "a", &mut |_| Ok(()))
            .unwrap(),
    );
    clock.0.store(499, Ordering::Relaxed);
    view.apply(
        session
            .replace(Revision(1), range(4, 4), "b", &mut |_| Ok(()))
            .unwrap(),
    );
    clock.0.store(999, Ordering::Relaxed);
    view.apply(
        session
            .replace(Revision(2), range(5, 5), "c", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(session.source_text(), "__日abc__\r\n");
    view.apply(session.undo(Revision(3), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), "__日ab__\r\n");
    view.apply(session.undo(Revision(4), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), "__日__\r\n");
    assert_eq!(view.text, "日\r\n");
    assert!(session
        .undo(Revision(5), &mut |_| Ok(()))
        .unwrap()
        .is_none());
    view.apply(session.redo(Revision(5), &mut |_| Ok(())).unwrap().unwrap());
    view.apply(session.redo(Revision(6), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), "__日abc__\r\n");
    assert_eq!(view.text, "日abc\r\n");
}

#[test]
fn grouped_history_accepts_once_and_failed_undo_keeps_every_state_and_the_group() {
    use futo_notes_editor::{Affinity, EditorError, InlineFormat};
    let clock = Arc::new(Clock::default());
    let mut session = EditorSession::open_with_clock("__日__", clock);
    session
        .select_with_affinity(Revision(0), range(3, 3), Affinity::Backward)
        .unwrap();
    session
        .replace(Revision(0), range(3, 3), "a", &mut |_| Ok(()))
        .unwrap();
    session
        .replace(Revision(1), range(4, 4), "😀", &mut |_| Ok(()))
        .unwrap();
    assert_eq!(session.active_formats(), vec![InlineFormat::Bold]);
    let mut calls = 0;
    let failure = session.undo(Revision(2), &mut |edit| {
        calls += 1;
        assert_eq!(edit.removed, "a😀");
        assert_eq!(edit.inserted, "");
        Err("disk full".into())
    });
    assert_eq!(calls, 1);
    assert_eq!(failure, Err(EditorError::Persistence("disk full".into())));
    assert_eq!(session.source_text(), "__日a😀__");
    assert_eq!(session.selection(), range(8, 8));
    assert_eq!(session.affinity(), Affinity::Backward);
    assert_eq!(session.active_formats(), vec![InlineFormat::Bold]);
    let mut accepted = 0;
    session
        .undo(Revision(2), &mut |_| {
            accepted += 1;
            Ok(())
        })
        .unwrap()
        .unwrap();
    assert_eq!(accepted, 1);
    assert_eq!(session.source_text(), "__日__");
    assert_eq!(session.selection(), range(3, 3));
    assert_eq!(session.affinity(), Affinity::Backward);
    assert_eq!(session.active_formats(), vec![InlineFormat::Bold]);
    session.redo(Revision(3), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(session.source_text(), "__日a😀__");
    assert_eq!(session.selection(), range(8, 8));
}

#[test]
fn isolated_input_and_composition_commits_cannot_join_adjacent_typing() {
    use futo_notes_editor::InputAction;
    let mut session = EditorSession::open_with_clock("", Arc::new(Clock::default()));
    session
        .replace(Revision(0), range(0, 0), "a", &mut |_| Ok(()))
        .unwrap();
    session
        .replace_action(
            Revision(1),
            range(1, 1),
            "b",
            InputAction::Isolated,
            &mut |_| Ok(()),
        )
        .unwrap();
    session
        .replace_action(
            Revision(2),
            range(2, 2),
            "日",
            InputAction::CompositionCommit,
            &mut |_| Ok(()),
        )
        .unwrap();
    session
        .replace(Revision(3), range(5, 5), "c", &mut |_| Ok(()))
        .unwrap();
    for (revision, expected) in [(4, "ab日"), (5, "ab"), (6, "a"), (7, "")] {
        session
            .undo(Revision(revision), &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(session.source_text(), expected);
    }
    assert!(session
        .undo(Revision(8), &mut |_| Ok(()))
        .unwrap()
        .is_none());
}

#[test]
fn formatting_caret_moves_and_direction_changes_end_typing_bursts() {
    use futo_notes_editor::{Affinity, InlineFormat};
    let mut session = EditorSession::open_with_clock("ab", Arc::new(Clock::default()));
    session
        .select_with_affinity(Revision(0), range(2, 2), Affinity::Backward)
        .unwrap();
    session
        .replace(Revision(0), range(2, 2), "c", &mut |_| Ok(()))
        .unwrap();
    session
        .toggle_format(Revision(1), InlineFormat::Bold, &mut |_| {
            panic!("collapsed toggle cannot append")
        })
        .unwrap();
    session
        .replace(Revision(1), range(3, 3), "d", &mut |_| Ok(()))
        .unwrap();
    session.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(session.source_text(), "abc");
    assert_eq!(session.active_formats(), vec![InlineFormat::Bold]);
    session.undo(Revision(3), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(session.source_text(), "ab");
    assert_eq!(session.active_formats(), vec![]);
    session.redo(Revision(4), &mut |_| Ok(())).unwrap().unwrap();
    session.redo(Revision(5), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(session.source_text(), "abc**d**");
    session
        .select_with_affinity(Revision(6), range(1, 1), Affinity::Forward)
        .unwrap();
    session
        .replace(Revision(6), range(1, 1), "x", &mut |_| Ok(()))
        .unwrap();
    session.undo(Revision(7), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(session.source_text(), "abc**d**");
    assert_eq!(session.selection(), range(1, 1));
    assert_eq!(session.affinity(), Affinity::Forward);
}

#[test]
fn repeated_backspaces_and_deletes_group_by_direction_and_restore_source() {
    let mut session = EditorSession::open_with_clock("__abcd__", Arc::new(Clock::default()));
    session.select(Revision(0), range(3, 3)).unwrap();
    session
        .replace(Revision(0), range(2, 3), "", &mut |_| Ok(()))
        .unwrap();
    session
        .replace(Revision(1), range(1, 2), "", &mut |_| Ok(()))
        .unwrap();
    assert_eq!(session.source_text(), "__ad__");
    session
        .replace(Revision(2), range(1, 2), "", &mut |_| Ok(()))
        .unwrap();
    assert_eq!(session.source_text(), "__a__");
    session.undo(Revision(3), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(session.source_text(), "__ad__");
    session.undo(Revision(4), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(session.source_text(), "__abcd__");
    assert_eq!(session.selection(), range(3, 3));
    session.redo(Revision(5), &mut |_| Ok(())).unwrap().unwrap();
    session.redo(Revision(6), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(session.source_text(), "__a__");
}

#[test]
fn selected_formatting_repairs_are_one_action_and_restore_selection_formats() {
    use futo_notes_editor::{Affinity, InlineFormat};
    let mut session = EditorSession::open_with_clock("__a__ x", Arc::new(Clock::default()));
    let mut view = ReferenceView::new("a x");
    session
        .select_with_affinity(Revision(0), range(0, 3), Affinity::Forward)
        .unwrap();
    view.apply(
        session
            .toggle_format(Revision(0), InlineFormat::Italic, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    let formatted = "*__a__ x*";
    assert_eq!(session.source_text(), formatted);
    assert_eq!(view.text, "a x");
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), "__a__ x");
    assert_eq!(session.selection(), range(0, 3));
    assert_eq!(session.affinity(), Affinity::Forward);
    assert!(session
        .undo(Revision(2), &mut |_| Ok(()))
        .unwrap()
        .is_none());
    view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), formatted);
    assert_eq!(view.text, "a x");
}

#[test]
fn portable_grouped_undo_is_one_request_and_displays_at_once() {
    use futo_notes_editor::{HostOperation, PortableSession, SessionToken};
    let clock = Arc::new(Clock::default());
    let mut page =
        PortableSession::open_with_clock(SessionToken(20), "__a__", Revision(0), clock.clone());
    let mut view = ReferenceView::new("a");
    let first = page.replace(Revision(0), range(1, 1), "b").unwrap();
    view.apply(first.change);
    clock.0.store(499, Ordering::Relaxed);
    let second = page.replace(Revision(1), range(2, 2), "c").unwrap();
    view.apply(second.change);
    // No acknowledgement has arrived; undo still works and shows now.
    let undo = page.undo(Revision(2)).unwrap().unwrap();
    let HostOperation::Append(edit) = &undo.request.operation else {
        panic!("one undo append");
    };
    assert_eq!(edit.removed, "bc");
    assert_eq!(edit.inserted, "");
    view.apply(undo.change);
    assert_eq!(view.text, "a");
    assert_eq!(page.status().outstanding, 3);
    assert!(page.undo(Revision(3)).unwrap().is_none());
}

#[test]
fn typing_group_includes_marker_repairs_and_redo_branch_is_replaced_only_after_acceptance() {
    use futo_notes_editor::Affinity;
    let mut session = EditorSession::open_with_clock("__a__", Arc::new(Clock::default()));
    let mut view = ReferenceView::new("a");
    session
        .select_with_affinity(Revision(0), range(1, 1), Affinity::Backward)
        .unwrap();
    view.apply(
        session
            .replace(Revision(0), range(1, 1), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(session.source_text(), "__a__ ");
    view.apply(
        session
            .replace(Revision(1), range(2, 2), "b", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(session.source_text(), "__a b__");
    view.apply(session.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), "__a__");
    assert!(session
        .replace(Revision(3), range(1, 1), "x", &mut |_| Err("full".into()))
        .is_err());
    view.apply(session.redo(Revision(3), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), "__a b__");
    view.apply(session.undo(Revision(4), &mut |_| Ok(())).unwrap().unwrap());
    view.apply(
        session
            .replace(Revision(5), range(1, 1), "x", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(session.source_text(), "__ax__");
    assert!(session
        .redo(Revision(6), &mut |_| Ok(()))
        .unwrap()
        .is_none());
    assert_eq!(view.text, "ax");
}

#[test]
fn native_selection_echo_keeps_carried_format_and_the_typing_group() {
    use futo_notes_editor::Affinity;
    let mut session = EditorSession::open_with_clock("__a__", Arc::new(Clock::default()));
    session
        .select_with_affinity(Revision(0), range(1, 1), Affinity::Backward)
        .unwrap();
    session
        .replace(Revision(0), range(1, 1), " ", &mut |_| Ok(()))
        .unwrap();
    // A native text control echoes the exact accepted caret, not a user jump.
    session
        .select_with_affinity(Revision(1), range(2, 2), Affinity::Backward)
        .unwrap();
    session
        .replace(Revision(1), range(2, 2), "b", &mut |_| Ok(()))
        .unwrap();
    assert_eq!(session.source_text(), "__a b__");
    session.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(session.source_text(), "__a__");
    assert!(session
        .undo(Revision(3), &mut |_| Ok(()))
        .unwrap()
        .is_none());
}

#[test]
fn actual_selection_or_affinity_jump_breaks_the_run_even_after_returning_to_the_old_caret() {
    use futo_notes_editor::Affinity;
    for jump in [range(0, 0), range(2, 2)] {
        let mut session = EditorSession::open_with_clock("a", Arc::new(Clock::default()));
        session
            .select_with_affinity(Revision(0), range(1, 1), Affinity::Backward)
            .unwrap();
        session
            .replace(Revision(0), range(1, 1), "b", &mut |_| Ok(()))
            .unwrap();
        session
            .select_with_affinity(Revision(1), jump, Affinity::Forward)
            .unwrap();
        session
            .select_with_affinity(Revision(1), range(2, 2), Affinity::Backward)
            .unwrap();
        session
            .replace(Revision(1), range(2, 2), "c", &mut |_| Ok(()))
            .unwrap();
        session.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap();
        assert_eq!(session.source_text(), "ab");
        session.undo(Revision(3), &mut |_| Ok(())).unwrap().unwrap();
        assert_eq!(session.source_text(), "a");
    }
}

#[test]
fn rejected_isolated_input_and_compound_command_leave_the_previous_typing_group_untouched() {
    use futo_notes_editor::{DisplayReplacement, InputAction};
    let mut session = EditorSession::open_with_clock("a", Arc::new(Clock::default()));
    session
        .replace(Revision(0), range(1, 1), "b", &mut |_| Ok(()))
        .unwrap();
    assert!(session
        .replace_action(
            Revision(1),
            range(2, 2),
            "x",
            InputAction::Isolated,
            &mut |_| Err("full".into())
        )
        .is_err());
    assert!(session
        .replace_many(
            Revision(1),
            &[
                DisplayReplacement {
                    range: range(0, 1),
                    inserted: "x".into()
                },
                DisplayReplacement {
                    range: range(1, 2),
                    inserted: "y".into()
                },
            ],
            &mut |_| Err("full".into())
        )
        .is_err());
    assert_eq!(session.source_text(), "ab");
    assert_eq!(session.selection(), range(2, 2));
    session
        .replace(Revision(1), range(2, 2), "c", &mut |_| Ok(()))
        .unwrap();
    session.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(session.source_text(), "a");
    assert!(session
        .undo(Revision(3), &mut |_| Ok(()))
        .unwrap()
        .is_none());
}
#[path = "history/fences.rs"]
mod fences;
