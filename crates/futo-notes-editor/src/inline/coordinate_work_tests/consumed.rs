//! Public actions calibrate actual consumed work before aggregation is repaired.
use super::{children as child_snapshot, reset};
use crate::*;
fn range(a: usize, z: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(a),
        end: DisplayOffset(z),
    }
}

#[test]
fn public_actions_report_each_consumed_planning_contribution() {
    for (name, source, expected, command, at) in [
        (
            "lift-list",
            "- label https://x.test",
            "# label https://x.test",
            BlockCommand::Heading(1),
            0,
        ),
        (
            "header-apply",
            "- > &acE;",
            "\n> &acE;",
            BlockCommand::Heading(0),
            3,
        ),
        (
            "fence-apply",
            "- parent https://x.test\n  ```Rust\n  opaque\n- outside\n",
            "parent https://x.test\n```Rust\nopaque\n```\n- outside\n",
            BlockCommand::Heading(0),
            0,
        ),
    ] {
        let mut session = EditorSession::open(source);
        let before = session.display_text();
        let canonical = EditorSession::open(expected);
        reset();
        let change = session
            .block_command(Revision(0), range(at, at), command, &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(session.source_text(), expected, "{name}");
        assert_eq!(session.display_text(), canonical.display_text());
        let children = child_snapshot();
        assert!(
            children
                .iter()
                .any(|(owner, part)| *owner == name && part.link_metadata_items > 0),
            "{name}: {children:?}"
        );
        eprintln!(
            "CALIBRATION {name}: before={before:?}; public={:?}; children={children:?}",
            change.work
        );
    }
    let mut session = EditorSession::open("-https://x.test");
    reset();
    let change = session
        .replace(Revision(0), range(1, 1), " ", &mut |_| Ok(()))
        .unwrap();
    assert_eq!(session.source_text(), "- https://x.test");
    assert_eq!(session.display_text(), "https://x.test");
    let children = child_snapshot();
    assert!(children
        .iter()
        .any(|(name, part)| *name == "shortcut-remove" && part.link_metadata_items > 0));
    eprintln!(
        "CALIBRATION shortcut-remove: public={:?}; children={children:?}",
        change.work
    );

    let source = "[id]: /target\n\n[one][id]\n\nbody";
    let expected = "[id]: /target\n\n\n\nbody";
    let canonical = EditorSession::open(expected);
    assert_eq!(canonical.display_text(), expected);
    let mut session = EditorSession::open(source);
    assert_eq!(session.display_text(), "one\n\nbody");
    reset();
    let change = session
        .replace(Revision(0), range(0, 3), "", &mut |_| Ok(()))
        .unwrap();
    assert_eq!(session.source_text(), expected);
    assert_eq!(session.display_text(), expected);
    let children = child_snapshot();
    assert!(children
        .iter()
        .any(|(name, part)| *name == "semantic-delimiters" && part.link_metadata_items > 0));
    eprintln!(
        "CALIBRATION semantic-delimiters: public={:?}; children={children:?}",
        change.work
    );
}
