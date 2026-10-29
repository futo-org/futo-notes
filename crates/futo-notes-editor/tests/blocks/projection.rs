use super::*;

#[test]
fn opening_blocks_hides_markers_and_preserves_their_exact_bytes() {
    let raw = "### Head ###\r\n> > **deep**\r\n> lazy\r\n\r\n* * *\r\nend";
    let session = EditorSession::open(raw);
    assert_eq!(session.source_text(), raw);
    assert_eq!(
        session.display_text(),
        "Head\r\ndeep\r\nlazy\r\n\r\n\u{fffc}\r\nend"
    );
}
#[test]
fn typing_in_a_heading_keeps_neighboring_quote_and_marker_spelling() {
    let mut session = EditorSession::open("### A ###\r\n> **B**\r\n");
    let mut view = ReferenceView::new("A\r\nB\r\n");
    let change = session
        .replace(Revision(0), range(1, 1), "x", &mut |_| Ok(()))
        .unwrap();
    view.apply(change);
    assert_eq!(session.source_text(), "### Ax ###\r\n> **B**\r\n");
    assert_eq!(view.text, "Ax\r\nB\r\n");
    assert_eq!(session.selection(), range(2, 2));
}
#[test]
fn setext_headings_keep_their_spelling_when_typing_and_change_locally_by_command() {
    let mut s = EditorSession::open("Title\r\n=====\r\nnext\r\n");
    let mut v = ReferenceView::new("Title\r\nnext\r\n");
    assert_eq!(s.display_text(), v.text);
    v.apply(
        s.replace(s.revision(), range(5, 5), "X", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(s.source_text(), "TitleX\r\n=====\r\nnext\r\n");
    v.apply(
        s.block_command(
            s.revision(),
            range(0, 0),
            BlockCommand::Heading(3),
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), "### TitleX\r\nnext\r\n");
    assert_eq!(v.text, "TitleX\r\nnext\r\n");
    v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "TitleX\r\n=====\r\nnext\r\n");
}

#[test]
fn editing_a_multiline_quote_run_preserves_untouched_markers_and_prefix_bytes() {
    let mut s = EditorSession::open("> __a\r\n> b__\r\n");
    let mut v = ReferenceView::new("a\r\nb\r\n");
    v.apply(
        s.replace(s.revision(), range(4, 4), "X", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(s.source_text(), "> __a\r\n> bX__\r\n");
    assert_eq!(v.text, "a\r\nbX\r\n");
}
