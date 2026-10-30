use super::*;

#[test]
fn divider_command_leaves_one_editable_paragraph_and_exact_undo() {
    let mut s = EditorSession::open("");
    let mut v = ReferenceView::new("");
    v.apply(
        s.block_command(
            s.revision(),
            range(0, 0),
            BlockCommand::Divider,
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), "---\n");
    assert_eq!(v.text, "\u{fffc}\n");
    assert_eq!(s.selection(), range(4, 4));
    v.apply(
        s.replace(s.revision(), s.selection(), "X", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(s.source_text(), "---\nX");
    assert_eq!(v.text, "\u{fffc}\nX");
    v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "---\n");
    v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "");
}
#[test]
fn divider_caret_edges_create_text_paragraphs_and_deleting_the_atom_undoes_exactly() {
    for (at, expected, shown, caret) in [
        (0, "X\n* * *\r\nend", "X\n\u{fffc}\r\nend", 1),
        (3, "* * *\nX\r\nend", "\u{fffc}\nX\r\nend", 5),
    ] {
        let mut s = EditorSession::open("* * *\r\nend");
        let mut v = ReferenceView::new("\u{fffc}\r\nend");
        v.apply(
            s.replace(s.revision(), range(at, at), "X", &mut |_| Ok(()))
                .unwrap(),
        );
        assert_eq!(s.source_text(), expected);
        assert_eq!(v.text, shown);
        assert_eq!(s.selection(), range(caret, caret));
        v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), "* * *\r\nend");
        v.apply(
            s.replace(s.revision(), range(0, 3), "X", &mut |_| Ok(()))
                .unwrap(),
        );
        assert_eq!(s.source_text(), "X\r\nend");
        v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), "* * *\r\nend");
    }
}
#[test]
fn typing_before_a_dash_divider_keeps_it_a_divider_instead_of_a_setext_heading() {
    let mut s = EditorSession::open("---\r\nend");
    s.replace(s.revision(), range(0, 0), "X", &mut |_| Ok(()))
        .unwrap();
    assert_eq!(s.source_text(), "X\n***\r\nend");
    assert_eq!(s.display_text(), "X\n\u{fffc}\r\nend");
    s.undo(s.revision(), &mut |_| Ok(())).unwrap();
    assert_eq!(s.source_text(), "---\r\nend");
}
#[test]
fn divider_selection_preserves_surviving_heading_closers_and_inline_runs() {
    for (raw, selection, expected, shown) in [
        (
            "## __ab__ ##\r\nend",
            range(1, 1),
            "## __a__ ##\n***\n\n## __b__ ##\r\nend",
            "a\n\u{fffc}\n\nb\r\nend",
        ),
        (
            "## __ab__ ##\r\n### __cd__ ###\r\nend",
            range(1, 5),
            "## __a__ ##\n***\n\n### __d__ ###\r\nend",
            "a\n\u{fffc}\n\nd\r\nend",
        ),
        (
            "> __ab__",
            range(1, 1),
            "> __a__\n> ***\n> \n> __b__",
            "a\n\u{fffc}\n\nb",
        ),
    ] {
        let mut s = EditorSession::open(raw);
        let mut v = ReferenceView::new(match raw {
            "## __ab__ ##\r\nend" => "ab\r\nend",
            "## __ab__ ##\r\n### __cd__ ###\r\nend" => "ab\r\ncd\r\nend",
            "> __ab__" => "ab",
            _ => unreachable!(),
        });
        v.apply(
            s.block_command(s.revision(), selection, BlockCommand::Divider, &mut |_| {
                Ok(())
            })
            .unwrap()
            .unwrap(),
        );
        assert_eq!(s.source_text(), expected, "{raw:?}");
        assert_eq!(v.text, shown);
        v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
    }
}
