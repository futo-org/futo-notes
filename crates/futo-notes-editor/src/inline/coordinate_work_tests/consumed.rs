//! Public actions retain exact prior work plus independently observed child totals.
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
    let mut missing = Vec::new();
    let mut check =
        |name: &'static str, actual: EditWork, baseline: EditWork, addition: (usize, usize)| {
            let observed = child_snapshot();
            let measured = observed.iter().fold((0, 0), |(items, copied), (_, part)| {
                (
                    items + part.link_metadata_items,
                    copied + part.link_copied_bytes,
                )
            });
            assert_eq!(
                measured, addition,
                "{name}: independently observed child totals={observed:?}"
            );
            let expected = EditWork {
                link_metadata_items: baseline.link_metadata_items + addition.0,
                link_copied_bytes: baseline.link_copied_bytes + addition.1,
                ..baseline
            };
            if actual != expected {
                missing.push((name, actual, expected));
            }
        };
    {
        let (name, source, expected, command, at) = (
            "lift-list",
            "- label https://x.test",
            "# label https://x.test",
            BlockCommand::Heading(1),
            0,
        );
        let mut session = EditorSession::open(source);
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
        let (baseline, addition) = match name {
            "lift-list" => (
                EditWork {
                    materialized_source_bytes: 360,
                    inserted_bytes: 22,
                    parsed_source_bytes: 384,
                    link_metadata_items: 370,
                    link_copied_bytes: 84,
                },
                (257, 70),
            ),
            _ => unreachable!(),
        };
        check(name, change.work, baseline, addition);
    }
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
    check(
        "semantic-delimiters",
        change.work,
        EditWork {
            materialized_source_bytes: 94,
            inserted_bytes: 0,
            parsed_source_bytes: 167,
            link_metadata_items: 289,
            link_copied_bytes: 33,
        },
        (6, 0),
    );
    assert!(
        missing.is_empty(),
        "consumed planning work was dropped: {missing:?}"
    );
}
