use futo_notes_editor::host::{DisplayMirror, MirrorError};

// A mirror kept in step by `apply_change` must equal the engine's display after
// every change, and convert coordinates the way a UTF-16 host needs them.
const TEXT: &str = "a日本\u{1F600}b\nline two é\n";

#[test]
fn converts_both_ways_across_multibyte_and_surrogate_pairs() {
    let m = DisplayMirror::new(TEXT);
    assert_eq!(m.byte_len(), TEXT.len());
    assert_eq!(m.utf16_len(), TEXT.encode_utf16().count());
    for (byte, _) in TEXT.char_indices().chain([(TEXT.len(), ' ')]) {
        let unit = TEXT[..byte].encode_utf16().count();
        assert_eq!(m.byte_to_utf16(byte), Ok(unit));
        assert_eq!(m.utf16_to_byte(unit), Ok(byte));
    }
}

#[test]
fn refuses_split_characters_and_out_of_range() {
    let m = DisplayMirror::new(TEXT);
    assert_eq!(m.byte_to_utf16(2), Err(MirrorError::SplitCharacter));
    assert_eq!(m.utf16_to_byte(4), Err(MirrorError::SplitCharacter)); // inside the emoji pair
    assert_eq!(m.byte_to_utf16(10_000), Err(MirrorError::OutOfRange));
    assert_eq!(m.utf16_to_byte(10_000), Err(MirrorError::OutOfRange));
    assert_eq!(m.slice_utf16(3, 1), Err(MirrorError::Reversed));
}

#[test]
fn apply_change_matches_a_string_replacement_and_reports_utf16() {
    let mut m = DisplayMirror::new(TEXT);
    let mut expected = TEXT.to_string();
    // Replace "本😀" (bytes 4..11) with "xy", caret after it.
    let edit = m.apply_change(4, 11, "xy", (6, 6)).unwrap();
    expected.replace_range(4..11, "xy");
    assert_eq!(m.text(), expected);
    assert_eq!((edit.start, edit.end, edit.inserted_utf16), (2, 5, 2));
    assert_eq!((edit.selection_start, edit.selection_end), (4, 4));
    assert_eq!(m.slice_utf16(0, 4).unwrap(), "a日xy");
}

#[test]
fn a_refused_selection_leaves_the_mirror_unchanged() {
    let mut m = DisplayMirror::new(TEXT);
    assert_eq!(
        m.apply_change(0, 1, "", (99_999, 99_999)),
        Err(MirrorError::OutOfRange)
    );
    assert_eq!(m.text(), TEXT);
    assert_eq!(
        m.apply_change(2, 3, "z", (0, 0)),
        Err(MirrorError::SplitCharacter)
    );
    assert_eq!(m.text(), TEXT);
}

#[test]
fn a_long_note_stays_in_step_through_many_edits() {
    let mut m = DisplayMirror::new(&"é line\n".repeat(20_000));
    let mut expected = m.text();
    for i in 0..500usize {
        let at = expected.char_indices().nth(i * 37 % 100_000).unwrap().0;
        let insert = if i % 2 == 0 { "\u{1F600}" } else { "" };
        let end = expected[at..]
            .chars()
            .next()
            .map_or(at, |c| at + c.len_utf8());
        m.apply_change(at, end, insert, (at, at)).unwrap();
        expected.replace_range(at..end, insert);
    }
    assert_eq!(m.text(), expected);
}
