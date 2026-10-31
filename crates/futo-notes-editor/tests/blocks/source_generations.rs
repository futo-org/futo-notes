//! Public target and history behavior through a protected exact boundary.
use super::*;

#[test]
fn a_command_retains_both_entity_interiors_after_a_nonlinear_protected_input() {
    let raw = "> > \n> &acE; / &NotEqualTilde;\n> ===";
    let typed = "> > *ab* \n>\n> &acE; / &NotEqualTilde;\n> ===";
    let changed = "> > *ab* \n>\n> ### &acE; / &NotEqualTilde;";
    let opening = "\n∾\u{333} / ≂\u{338}";
    let shown = "ab \n\n∾\u{333} / ≂\u{338}";
    // Establish the composition commit's source intent independently of the
    // following command, whose two endpoints address the raw marked overlay.
    let mut control = EditorSession::open(raw);
    control.compose(Revision(0), range(0, 0), "*ab* ").unwrap();
    control
        .commit_composition(Revision(0), None, &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(control.source_text(), typed);
    assert_eq!(control.display_text(), shown);
    assert_eq!(control.selection(), range(3, 3));
    for affinity in [Affinity::Forward, Affinity::Backward] {
        let mut session = EditorSession::open(raw);
        let mut view = ReferenceView::new(opening);
        session
            .select_with_affinity(Revision(0), range(4, 12), affinity)
            .unwrap();
        let marked = session.compose(Revision(0), range(0, 0), "*ab* ").unwrap();
        let mut calls = 0;
        assert_eq!(
            session.block_command(
                Revision(0),
                range(9, 17),
                BlockCommand::Heading(3),
                &mut |_| {
                    calls += 1;
                    Err("full".into())
                }
            ),
            Err(EditorError::Persistence("full".into()))
        );
        // Both command endpoints are inside retained nonidentity atoms. The
        // first atom has equal raw/display byte lengths, without raw identity.
        assert_eq!(calls, 1);
        assert_eq!(session.source_text(), raw);
        assert_eq!(session.selection(), range(4, 12));
        assert_eq!(session.composition(), Some(&marked));
        view.apply(
            session
                .block_command(
                    Revision(0),
                    range(9, 17),
                    BlockCommand::Heading(3),
                    &mut |_| Ok(()),
                )
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), changed);
        assert_eq!(view.text, shown);
        assert_eq!(session.selection(), range(8, 16));
        view.apply(
            session
                .undo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), typed);
        // Explicit command range is distinct from the actual pre-command
        // selection, independently established by the composition control.
        assert_eq!(session.selection(), range(3, 3));
        view.apply(
            session
                .undo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), raw);
        assert_eq!(view.text, opening);
        assert_eq!(session.selection(), range(4, 12));
        assert_eq!(session.affinity(), affinity);
        view.apply(
            session
                .redo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), typed);
        assert_eq!(session.selection(), range(3, 3));
        view.apply(
            session
                .redo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), changed);
        assert_eq!(session.selection(), range(8, 16));
    }
}

#[test]
fn both_inserted_command_endpoints_map_across_the_boundary_and_hidden_markers() {
    let raw = "> > \n> ab\n> ===";
    let typed = "> > *ab* \n>\n> ab\n> ===";
    let changed = "> > ### *ab* \n>\n> ab\n> ===";
    let mut session = EditorSession::open(raw);
    let mut view = ReferenceView::new("\nab");
    session.compose(Revision(0), range(0, 0), "*ab* ").unwrap();
    let mut calls = 0;
    view.apply(
        session
            .block_command(
                Revision(0),
                range(0, 5),
                BlockCommand::Heading(3),
                &mut |_| {
                    calls += 1;
                    Ok(())
                },
            )
            .unwrap()
            .unwrap(),
    );
    assert_eq!(calls, 1);
    assert_eq!(session.source_text(), changed);
    assert_eq!(view.text, "ab \n\nab");
    assert_eq!(session.selection(), range(0, 3));
    view.apply(
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), typed);
    assert_eq!(session.selection(), range(3, 3));
    view.apply(
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), raw);
    assert_eq!(view.text, "\nab");
    assert_eq!(session.selection(), range(0, 0));
    view.apply(
        session
            .redo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), typed);
    view.apply(
        session
            .redo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), changed);
    assert_eq!(session.selection(), range(0, 3));
}
