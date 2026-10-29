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
fn portable_grouped_undo_waits_for_one_acknowledgement_and_backpressures_input() {
    use futo_notes_editor::{HostOperation, PortableError, PortableSession, SessionToken};
    let clock = Arc::new(Clock::default());
    let mut page = PortableSession::open_with_clock(
        SessionToken(20),
        "__a__",
        Revision(0),
        Revision(0),
        clock.clone(),
    );
    let mut view = ReferenceView::new("a");
    let first = page.replace(Revision(0), range(1, 1), "b").unwrap();
    view.apply(
        page.acknowledge(first.accepted(Revision(1), Revision(0)))
            .unwrap()
            .unwrap(),
    );
    clock.0.store(499, Ordering::Relaxed);
    let second = page.replace(Revision(1), range(2, 2), "c").unwrap();
    view.apply(
        page.acknowledge(second.accepted(Revision(2), Revision(0)))
            .unwrap()
            .unwrap(),
    );
    let undo = page.undo(Revision(2)).unwrap().unwrap();
    let HostOperation::Append(edit) = &undo.operation else {
        panic!("one undo append");
    };
    assert_eq!(edit.removed, "bc");
    assert_eq!(edit.inserted, "");
    assert_eq!(view.text, "abc");
    assert_eq!(
        page.replace(Revision(3), range(1, 1), "x"),
        Err(PortableError::Busy)
    );
    view.apply(
        page.acknowledge(undo.accepted(Revision(3), Revision(0)))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(view.text, "a");
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
