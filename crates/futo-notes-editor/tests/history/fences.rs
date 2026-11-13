use super::*;
use futo_notes_editor::{Affinity, InputAction, ParagraphKey};

#[test]
fn fence_frame_repairs_keep_ordinary_typing_history_and_rejection_boundaries() {
    // Typing in an empty code block writes a line ending, then the text, behind the
    // hidden opening fence. (A fence is not read after `>`, so the blocks are unquoted.)
    for (source, shown, at, expected, display) in [
        ("```\n```", "", 0, "```\n!?\n```", "!?"),
        ("~~~", "", 0, "~~~\n!?", "!?"),
        (
            "__P__\r\n\r\n~~~\r\n~~~~~  ",
            "P\r\n\r\n",
            5,
            "__P__\r\n\r\n~~~\r\n!?\r\n~~~~~  ",
            "P\r\n\r\n!?",
        ),
    ] {
        for isolated in [false, true] {
            let clock = Arc::new(Clock::default());
            clock.0.store(10, Ordering::Relaxed);
            let mut session = EditorSession::open_with_clock(source, clock.clone());
            session
                .select_with_affinity(Revision(0), range(at, at), Affinity::Forward)
                .unwrap();
            let mut view = ReferenceView::new(shown);
            for (index, text) in ["!", "?"].into_iter().enumerate() {
                let action = if isolated && index == 0 {
                    InputAction::Isolated
                } else {
                    InputAction::Typing
                };
                let rev = session.revision();
                let selected = session.selection();
                let before = session.source_text();
                assert!(session
                    .replace_action(rev, selected, text, action, &mut |_| Err("append".into()))
                    .is_err());
                assert_eq!(session.revision(), rev);
                assert_eq!(session.selection(), selected);
                assert_eq!(session.source_text(), before);
                view.apply(
                    session
                        .replace_action(rev, selected, text, action, &mut |_| Ok(()))
                        .unwrap(),
                );
                clock.0.store(20, Ordering::Relaxed);
            }
            assert_eq!(session.source_text(), expected);
            assert_eq!(view.text, display);
            assert!(session
                .undo(session.revision(), &mut |_| Err("append".into()))
                .is_err());
            assert_eq!(session.source_text(), expected);
            for _ in 0..if isolated { 2 } else { 1 } {
                view.apply(
                    session
                        .undo(session.revision(), &mut |_| Ok(()))
                        .unwrap()
                        .unwrap(),
                );
            }
            assert_eq!(session.source_text(), source);
            assert_eq!(view.text, shown);
            assert!(session
                .undo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .is_none());
            for _ in 0..if isolated { 2 } else { 1 } {
                view.apply(
                    session
                        .redo(session.revision(), &mut |_| Ok(()))
                        .unwrap()
                        .unwrap(),
                );
            }
            assert_eq!(session.source_text(), expected);
            assert_eq!(view.text, display);
            view.apply(
                session
                    .paragraph_key(
                        session.revision(),
                        session.selection(),
                        ParagraphKey::Enter,
                        &mut |_| Ok(()),
                    )
                    .unwrap()
                    .unwrap(),
            );
            view.apply(
                session
                    .undo(session.revision(), &mut |_| Ok(()))
                    .unwrap()
                    .unwrap(),
            );
            assert_eq!(session.source_text(), expected, "Enter remains isolated");
        }
    }
}
