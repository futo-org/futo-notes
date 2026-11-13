//! Words: what a double click selects and where Option+Arrow stops.
use futo_notes_editor::{CaretDirection, DisplayOffset, EditorSession, Revision};

fn word_at(source: &str, at: usize) -> String {
    let session = EditorSession::open(source);
    let range = session.word_at(Revision(0), DisplayOffset(at)).unwrap();
    session.display_text()[range.start.0..range.end.0].to_owned()
}

fn stops(source: &str, from: usize, direction: CaretDirection) -> Vec<usize> {
    let session = EditorSession::open(source);
    let mut at = from;
    let mut stops = Vec::new();
    loop {
        let next = session
            .word_stop(Revision(0), DisplayOffset(at), direction)
            .unwrap()
            .0;
        if next == at {
            return stops;
        }
        stops.push(next);
        at = next;
    }
}

#[test]
fn a_double_click_selects_the_word_or_the_run_of_spaces_there() {
    assert_eq!(word_at("one two  three", 5), "two");
    assert_eq!(word_at("one two  three", 8), "  ");
    // On a word's end, the word: a press on its last character's right half lands there.
    assert_eq!(word_at("one two  three", 7), "two");
    // Past the line's end, the line's last word.
    assert_eq!(word_at("one two\nnext", 7), "two");
    assert_eq!(word_at("one\n\nthree", 4), "");
}

#[test]
fn chinese_japanese_and_thai_split_by_dictionary() {
    assert_eq!(word_at("我们在北京", 0), "我们");
    assert_eq!(word_at("我们在北京", 9), "北京");
    assert_eq!(word_at("東京に行きます", 0), "東京");
    assert_eq!(word_at("สวัสดีครับ", 0), "สวัสดี");
}

#[test]
fn option_arrow_stops_at_word_ends_forward_and_starts_backward_across_lines() {
    // The indented line shows as `three  `: its leading whitespace is its indent.
    let text = "one, two\n\n  three  ";
    assert_eq!(stops(text, 0, CaretDirection::Forward), [3, 8, 15, 17]);
    assert_eq!(stops(text, 17, CaretDirection::Backward), [10, 5, 0]);
}

#[test]
fn a_crlf_is_one_line_break_to_words() {
    assert_eq!(word_at("one\r\ntwo", 3), "one");
    assert_eq!(stops("one\r\ntwo", 3, CaretDirection::Forward), [8]);
    assert_eq!(stops("one\r\ntwo", 5, CaretDirection::Backward), [0]);
    // A caret between the CR and the LF acts at the line's end.
    assert_eq!(word_at("one\r\ntwo", 4), "one");
}

#[test]
fn words_read_the_display_across_hidden_syntax_and_lines() {
    // `**` is hidden: the display is `a bold word`.
    assert_eq!(word_at("a **bold** word", 3), "bold");
    // A fence's lines are hidden; the code line is its own display line.
    assert_eq!(
        stops("x\n```\ncode\n```\ny", 0, CaretDirection::Forward),
        [1, 6, 8]
    );
    // A closing fence on the last line hides the line break before it.
    assert_eq!(word_at("x\n```\ncode\n```", 6), "code");
}
