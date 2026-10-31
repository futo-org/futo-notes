use super::*;
use futo_notes_editor::HistoryClock;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

#[derive(Default)]
struct Clock(AtomicU64);
impl HistoryClock for Clock {
    fn now(&self) -> std::time::Duration {
        std::time::Duration::from_millis(self.0.load(Ordering::Relaxed))
    }
}

#[test]
fn loaded_partial_angle_and_authored_autolink_do_not_acquire_typed_pending_ownership() {
    for (source, shown) in [
        ("<https://x.test", "<https://x.test"),
        ("\\<https://x.test", "<https://x.test"),
        ("<<https://x.test>>", "<https://x.test>"),
    ] {
        let mut session = EditorSession::open(source);
        let mut view = ReferenceView::new(shown);
        assert_eq!(session.display_text(), shown);
        let initial = session
            .project(Revision(0), range(0, shown.len()))
            .unwrap()
            .links;
        assert_eq!(initial.len(), 1, "source={source:?}");
        assert_eq!(initial[0].destination, "https://x.test");
        let at = view.text.len();
        view.apply(
            session
                .replace(Revision(0), range(at, at), ">", &mut |_| Ok(()))
                .unwrap(),
        );
        assert_eq!(view.text, format!("{shown}>"));
        let links = session
            .project(session.revision(), range(0, view.text.len()))
            .unwrap()
            .links;
        assert_eq!(links.len(), 1, "source={:?}", session.source_text());
        assert_eq!(links[0].destination, "https://x.test");
        assert_eq!(links[0].range, range(1, 15));
        let reopened = EditorSession::open(&session.source_text());
        assert_eq!(reopened.display_text(), view.text);
        assert_eq!(
            reopened
                .project(reopened.revision(), range(0, view.text.len()))
                .unwrap()
                .links,
            links
        );
        view.apply(
            session
                .undo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), source);
        assert_eq!(view.text, shown);
    }
}

#[test]
fn typed_angle_pending_is_exact_history_state_and_is_absent_after_reopen() {
    let clock = Arc::new(Clock::default());
    let mut session = EditorSession::open_with_clock("", clock.clone());
    let mut view = ReferenceView::new("");
    for ch in "<https://x.test>".chars() {
        let at = view.text.len();
        view.apply(
            session
                .replace(
                    session.revision(),
                    range(at, at),
                    &ch.to_string(),
                    &mut |_| Ok(()),
                )
                .unwrap(),
        );
    }
    assert_eq!(session.source_text(), "<<https://x.test>>");
    assert!(session
        .project(session.revision(), range(0, 16))
        .unwrap()
        .links
        .is_empty());
    clock.0.store(500, Ordering::Relaxed);
    view.apply(
        session
            .replace(session.revision(), range(16, 16), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(session.source_text(), "<<https://x.test>> ");
    let links = session
        .project(session.revision(), range(0, 17))
        .unwrap()
        .links;
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].destination, "https://x.test");
    view.apply(
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), "<<https://x.test>>");
    assert_eq!(view.text, "<https://x.test>");
    assert!(session
        .project(session.revision(), range(0, 16))
        .unwrap()
        .links
        .is_empty());
    let reopened = EditorSession::open(&session.source_text());
    let loaded = reopened.project(Revision(0), range(0, 16)).unwrap().links;
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].destination, "https://x.test");
    view.apply(
        session
            .redo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(view.text, "<https://x.test> ");
    assert_eq!(
        session
            .project(session.revision(), range(0, 17))
            .unwrap()
            .links,
        links
    );
    view.apply(
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    view.apply(
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), "");
    view.apply(
        session
            .redo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), "<<https://x.test>>");
    assert!(session
        .project(session.revision(), range(0, 16))
        .unwrap()
        .links
        .is_empty());
}
