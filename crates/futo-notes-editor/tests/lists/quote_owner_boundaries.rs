use super::*;

fn quote_boundary_case(raw: &str, before: &str) {
    for ending in ["\n", "\r\n"] {
        quote_boundary_ending(
            &raw.replace('\n', ending),
            &before.replace('\n', ending),
            ending,
        );
    }
}

fn quote_boundary_ending(raw: &str, before: &str, ending: &str) {
    let expected = "parent\n> ```\n> opaque\n\n> - outside".replace('\n', ending);
    let shown = "parent\nopaque\n\noutside".replace('\n', ending);
    let opening = EditorSession::open(&expected);
    assert_eq!(opening.source_text(), expected);
    assert_eq!(opening.display_text(), shown);
    let p = opening
        .project(opening.revision(), range(0, shown.len()))
        .unwrap();
    assert!(p
        .blocks
        .iter()
        .filter(|b| b.code)
        .all(|b| b.quote_depth == 1 && b.list.is_none()));
    assert!(p
        .blocks
        .last()
        .unwrap()
        .list
        .as_ref()
        .is_some_and(|l| l.depth == 1 && l.first));
    for caret in [0, 3] {
        for affinity in [Affinity::Backward, Affinity::Forward] {
            let mut s = EditorSession::open(raw);
            assert_eq!(s.display_text(), before);
            let mut view = ReferenceView::new(before);
            let selected = range(caret, caret);
            s.select_with_affinity(s.revision(), selected, affinity)
                .unwrap();
            let mut rejected = 0;
            assert!(matches!(
                s.block_command(
                    s.revision(),
                    selected,
                    BlockCommand::Heading(0),
                    &mut |_| {
                        rejected += 1;
                        Err("rejected".into())
                    }
                ),
                Err(EditorError::Persistence(_))
            ));
            assert_eq!(rejected, 1);
            assert_eq!(s.source_text(), raw);
            assert_eq!(s.display_text(), before);
            assert_eq!(s.selection(), selected);
            assert_eq!(s.affinity(), affinity);
            assert_eq!(s.revision(), Revision(0));
            let mut accepted = 0;
            view.apply(
                s.block_command(
                    s.revision(),
                    selected,
                    BlockCommand::Heading(0),
                    &mut |_| {
                        accepted += 1;
                        Ok(())
                    },
                )
                .unwrap()
                .unwrap(),
            );
            assert_eq!(accepted, 1);
            assert_eq!(s.source_text(), expected, "{raw:?}");
            assert_eq!(view.text, shown);
            assert_eq!(s.selection(), selected);
            assert_eq!(s.affinity(), affinity);
            let outside = s
                .project(
                    s.revision(),
                    range(shown.find("outside").unwrap(), shown.len()),
                )
                .unwrap();
            assert!(outside.blocks.iter().all(|b| !b.code
                && b.quote_depth == 1
                && b.list.as_ref().is_some_and(|l| l.first && l.depth == 1)));
            view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
            assert_eq!(s.source_text(), raw);
            assert_eq!(view.text, before);
            assert_eq!(s.selection(), selected);
            assert_eq!(s.affinity(), affinity);
            view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
            assert_eq!(s.source_text(), expected);
            assert_eq!(view.text, shown);
            assert_eq!(s.selection(), selected);
        }
    }
}

#[test]
fn full_text_creates_the_minimum_boundary_between_inner_and_foreign_quote_owners() {
    quote_boundary_case(
        "- parent\n  > ```\n  > opaque\n> - outside",
        "parent\nopaque\noutside",
    );
}

#[test]
fn full_text_preserves_the_existing_unquoted_boundary_without_a_duplicate() {
    quote_boundary_case(
        "- parent\n  > ```\n  > opaque\n\n> - outside",
        "parent\nopaque\n\noutside",
    );
}
