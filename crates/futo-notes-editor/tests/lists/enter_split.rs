//! Enter splits that move an item's later rows into the new item.
use super::*;

/// Each display line's list role: `1.2` opens a depth-1 item numbered 2, `-1`
/// a depth-1 bullet, `1` continues a depth-1 item, `p` is outside any list.
fn list_rows(s: &EditorSession) -> Vec<String> {
    let text = s.display_text();
    let blocks = s
        .project(s.revision(), range(0, text.len()))
        .unwrap()
        .blocks;
    let mut at = 0;
    text.split('\n')
        .map(|line| {
            let block = blocks
                .iter()
                .find(|block| block.range.start.0 <= at && at <= block.range.end.0);
            at += line.len() + 1;
            match block.and_then(|block| block.list.as_ref()) {
                None => "p".to_owned(),
                Some(list) if !list.first => list.depth.to_string(),
                Some(list) => match list.number {
                    Some(number) => format!("{}.{number}", list.depth),
                    None => format!("-{}", list.depth),
                },
            }
        })
        .collect()
}

#[test]
fn enter_before_a_lazy_continuation_keeps_it_and_the_later_items_in_the_list() {
    // (source, caret at the end of this display line, expected source, list rows)
    for (raw, line, expected, rows) in [
        // The minimal repro: `3. b` became paragraph text.
        (
            "1. a\nlazy\n1. b",
            0,
            "1. a\n2. \n   lazy\n3. b",
            &["1.1", "1.2", "1", "1.3"][..],
        ),
        // A later `1.` after a blank line stays an item of the edited list.
        (
            "1. a\n2. b\nlazy\n\n1. one",
            1,
            "1. a\n2. b\n3. \n   lazy\n\n4. one",
            &["1.1", "1.2", "1.3", "1", "1", "1.4"][..],
        ),
        // The caret on a continuation line, and a bullet list.
        (
            "1. a\nlazy\nlazy2\n1. b",
            1,
            "1. a\nlazy\n2. \n   lazy2\n3. b",
            &["1.1", "1", "1.2", "1", "1.3"][..],
        ),
        (
            "- a\nlazy\n- b",
            0,
            "- a\n- \n  lazy\n- b",
            &["-1", "-1", "1", "-1"][..],
        ),
        // Quoted and nested lists.
        (
            "> 1. a\n> lazy\n> 1. b",
            0,
            "> 1. a\n> 2. \n>    lazy\n> 3. b",
            &["1.1", "1.2", "1", "1.3"][..],
        ),
        (
            "> 1. a\nlazy\n> 1. b",
            0,
            "> 1. a\n> 2. \n>    lazy\n> 3. b",
            &["1.1", "1.2", "1", "1.3"][..],
        ),
        (
            "1. x\n   1. a\n   lazy\n   1. b\n2. y",
            1,
            "1. x\n   1. a\n   2. \n      lazy\n   3. b\n2. y",
            &["1.1", "2.1", "2.2", "2", "2.3", "1.2"][..],
        ),
        // A marker that grows a digit moves the item's indented rows with it.
        (
            "9. a\n   cont\n1. b",
            0,
            "9. a\n10. \n    cont\n11. b",
            &["1.9", "1.10", "1", "1.11"][..],
        ),
        (
            "9. a\n   - nest\n1. b",
            0,
            "9. a\n10. \n    - nest\n11. b",
            &["1.9", "1.10", "-2", "1.11"][..],
        ),
    ] {
        let mut s = EditorSession::open(raw);
        let display = s.display_text();
        let mut view = ReferenceView::new(&display);
        let at = display
            .split('\n')
            .take(line + 1)
            .map(|l| l.len() + 1)
            .sum::<usize>()
            - 1;
        view.apply(
            s.paragraph_key(
                s.revision(),
                range(at, at),
                ParagraphKey::Enter,
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
        );
        assert_eq!(s.source_text(), expected, "{raw:?}");
        assert_eq!(list_rows(&s), rows, "{raw:?}");
        assert_eq!(view.text, s.display_text(), "{raw:?}");
        assert_eq!(s.selection(), range(at + 1, at + 1), "{raw:?}");
        assert_eq!(
            EditorSession::open(expected).display_text(),
            s.display_text()
        );
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw, "{raw:?} undo");
        assert_eq!(view.text, display);
    }
}

#[test]
fn enter_that_would_strand_an_items_later_blocks_is_refused() {
    // An empty item cannot begin with a blank line followed by its content.
    let raw = "1. a\n\n   more\n2. b";
    let mut s = EditorSession::open(raw);
    let revision = s.revision();
    assert!(matches!(
        s.paragraph_key(revision, range(1, 1), ParagraphKey::Enter, &mut |_| Ok(())),
        Err(EditorError::UnrepresentableFormat)
    ));
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.revision(), revision);
}
