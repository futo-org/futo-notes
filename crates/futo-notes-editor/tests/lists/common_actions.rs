//! Everyday list actions stay accepted on the generic list edit (none refuse).
use super::*;

fn accepted(
    source: &str,
    at: DisplayRange,
    act: impl FnOnce(&mut EditorSession, DisplayRange) -> Option<ViewChange>,
) -> String {
    let mut s = EditorSession::open(source);
    s.select(s.revision(), at).unwrap();
    let change = act(&mut s, at).expect("accepted");
    let mut view = ReferenceView::new(&EditorSession::open(source).display_text());
    view.apply(change);
    assert_eq!(view.text, s.display_text());
    assert_eq!(
        EditorSession::open(&s.source_text()).display_text(),
        s.display_text()
    );
    let after = s.source_text();
    s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(s.source_text(), source);
    after
}

fn command(c: BlockCommand) -> impl FnOnce(&mut EditorSession, DisplayRange) -> Option<ViewChange> {
    move |s, at| {
        s.block_command(s.revision(), at, c, &mut |_| Ok(()))
            .unwrap()
    }
}

fn key(k: ParagraphKey) -> impl FnOnce(&mut EditorSession, DisplayRange) -> Option<ViewChange> {
    move |s, at| {
        s.paragraph_key(s.revision(), at, k, &mut |_| Ok(()))
            .unwrap()
    }
}

#[test]
fn tab_and_shift_tab_move_items_through_two_and_three_levels() {
    let source = "- a\n- b\n  - c\n- d\n";
    assert_eq!(
        accepted(source, range(2, 2), command(BlockCommand::Indent)),
        "- a\n\t- b\n\t\t- c\n- d\n"
    );
    assert_eq!(
        accepted(source, range(6, 6), command(BlockCommand::Indent)),
        "- a\n- b\n  - c\n  - d\n"
    );
    assert_eq!(
        accepted(source, range(4, 4), command(BlockCommand::Outdent)),
        "- a\n- b\n- c\n- d\n"
    );
    let deep = "- a\n  - b\n    - c\n";
    assert_eq!(
        accepted(deep, range(4, 4), command(BlockCommand::Outdent)),
        "- a\n  - b\n  - c\n"
    );
}

#[test]
fn enter_and_backspace_at_item_starts() {
    assert_eq!(
        accepted("- a\n- b\n", range(1, 1), key(ParagraphKey::Enter)),
        "- a\n- \n- b\n"
    );
    assert_eq!(
        accepted("- a\n- b\n", range(2, 2), key(ParagraphKey::Backspace)),
        "- ab\n"
    );
    assert_eq!(
        accepted("- a\n  - b\n", range(2, 2), key(ParagraphKey::Backspace)),
        "- a\n  b\n"
    );
    assert_eq!(
        accepted("- a\n", range(0, 0), key(ParagraphKey::Backspace)),
        "a\n"
    );
}

#[test]
fn checkbox_toggles_and_paragraphs_convert_to_lists_and_back() {
    assert_eq!(
        accepted("- [ ] a\n", range(0, 0), command(BlockCommand::ToggleTask)),
        "- [x] a\n"
    );
    assert_eq!(
        accepted("- [x] a\n", range(0, 0), command(BlockCommand::ToggleTask)),
        "- [ ] a\n"
    );
    for (kind, listed) in [
        (BlockCommand::BulletList, "- a\n- b\n"),
        (BlockCommand::OrderedList, "1. a\n2. b\n"),
        (BlockCommand::TaskList, "- [ ] a\n- [ ] b\n"),
    ] {
        assert_eq!(accepted("a\nb\n", range(0, 3), command(kind)), listed);
        assert_eq!(
            accepted(listed, range(0, 3), command(BlockCommand::Heading(0))),
            "a\nb\n"
        );
        assert_eq!(accepted(listed, range(0, 3), command(kind)), "a\nb\n");
    }
}

#[test]
fn quoted_lists_indent_and_outdent() {
    assert_eq!(
        accepted("> - a\n> - b\n", range(2, 2), command(BlockCommand::Indent)),
        "> - a\n> \t- b\n"
    );
    assert_eq!(
        accepted(
            "> - a\n> \t- b\n",
            range(2, 2),
            command(BlockCommand::Outdent)
        ),
        "> - a\n> - b\n"
    );
}

#[test]
fn enter_on_an_empty_item_exits_the_list() {
    assert_eq!(
        accepted("- a\n- \n", range(2, 2), key(ParagraphKey::Enter)),
        // A blank line separates the list from the paragraph the user types
        // next; written straight under the item it would be a lazy
        // continuation of it (maintainer decision 2026-11-02).
        "- a\n\n\n"
    );
    assert_eq!(
        accepted("- a\n  - b\n  - \n", range(4, 4), key(ParagraphKey::Enter)),
        "- a\n  - b\n- \n"
    );
}
