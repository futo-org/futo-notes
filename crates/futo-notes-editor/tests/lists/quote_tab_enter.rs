//! A tab right after a quote's `>` is split between the quote and the list
//! item, which made the parser's item range begin at the `>`. The item's
//! marker was then located on the `>`, so the real marker stayed visible and
//! Enter at the end of the item panicked on the empty marker it had computed.
use super::*;

fn key(raw: &str, caret: usize, key: ParagraphKey) -> String {
    let mut s = EditorSession::open(raw);
    let at = range(caret, caret);
    s.select(s.revision(), at).unwrap();
    s.paragraph_key(s.revision(), at, key, &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    s.source_text().to_owned()
}

#[test]
fn a_tab_after_the_quote_marker_still_hides_the_list_marker() {
    for (raw, display) in [
        (">\t- a", "a"),
        ("> \t- a", "a"),
        (">\t1. a", "a"),
        (">\t- [ ] a", "a"),
        (">>\t- a", "a"),
        ("> >\t- a", "a"),
        (">\t- a\r\n>\t- b", "a\r\nb"),
    ] {
        assert_eq!(EditorSession::open(raw).display_text(), display, "{raw:?}");
    }
}

#[test]
fn enter_at_the_end_of_a_tab_indented_item_in_a_quote_opens_a_sibling() {
    for (raw, expected) in [
        (">\t- a", ">\t- a\n>\t- "),
        ("> \t- a", "> \t- a\n> \t- "),
        (">\t1. a", ">\t1. a\n>\t2. "),
        (">\t- [ ] a", ">\t- [ ] a\n>\t- [ ] "),
        (">>\t- a", ">>\t- a\n>>\t- "),
        ("> >\t- a", "> >\t- a\n> >\t- "),
        (">\t- a\r\n", ">\t- a\r\n>\t- \r\n"),
    ] {
        assert_eq!(key(raw, 1, ParagraphKey::Enter), expected, "{raw:?}");
    }
}

#[test]
fn enter_and_backspace_at_the_start_of_a_tab_indented_item_in_a_quote() {
    assert_eq!(key(">\t- a", 0, ParagraphKey::Enter), ">\t- \n>\t- a");
    assert_eq!(key(">\t1. a", 0, ParagraphKey::Enter), ">\t1. \n>\t2. a");
    assert_eq!(key(">\t- a", 0, ParagraphKey::Backspace), ">\ta");
}
