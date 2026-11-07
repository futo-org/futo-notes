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

#[test]
fn slack_is_how_far_left_an_insertion_or_deletion_in_a_run_could_equally_sit() {
    // "a" typed into "aa" is reported at the end (2); the same text results at 0, 1 and 2.
    let mut m = DisplayMirror::new("aa");
    let edit = m.apply_change(2, 2, "a", (3, 3)).unwrap();
    assert_eq!(
        (edit.start, edit.end, edit.inserted_utf16, edit.slack),
        (2, 2, 1, 2)
    );
    // A different character has one place only.
    let mut m = DisplayMirror::new("aa");
    assert_eq!(m.apply_change(2, 2, "b", (3, 3)).unwrap().slack, 0);
    // Deleting one of "xaaay" (reported as the last a, bytes 3..4) could be any of the three.
    let mut m = DisplayMirror::new("xaaay");
    let edit = m.apply_change(3, 4, "", (3, 3)).unwrap();
    assert_eq!((edit.start, edit.end, edit.slack), (3, 4, 2));
    // A multi-unit insertion slides by whole scalars: "ab" into "abab|" is the same at 2 and 0.
    let mut m = DisplayMirror::new("abab");
    assert_eq!(m.apply_change(4, 4, "ab", (6, 6)).unwrap().slack, 4);
    // Emoji count as two units.
    let mut m = DisplayMirror::new("\u{1F600}\u{1F600}");
    assert_eq!(
        m.apply_change(8, 8, "\u{1F600}", (12, 12)).unwrap().slack,
        4
    );
    // A replacement is not slid.
    let mut m = DisplayMirror::new("aaa");
    assert_eq!(m.apply_change(1, 2, "b", (2, 2)).unwrap().slack, 0);
}

#[test]
fn a_key_replays_at_the_engines_caret_keeping_its_offset_from_the_views_selection() {
    let m = DisplayMirror::new("hello x");
    // Backspace at the view's caret 5 asks for [4, 5); the engine's caret is at 6 now.
    assert_eq!(m.at_caret((4, 5), (5, 5), (6, 6)), (5, 6));
    // Typing at a caret, forward delete, and typing over a selection the earlier keys replaced.
    assert_eq!(m.at_caret((5, 5), (5, 5), (6, 6)), (6, 6));
    assert_eq!(m.at_caret((5, 6), (5, 5), (2, 2)), (2, 3));
    assert_eq!(m.at_caret((0, 5), (0, 5), (3, 3)), (3, 3));
    assert_eq!(m.at_caret((0, 5), (0, 5), (0, 5)), (0, 5));
    // Clamped to the text, never reversed.
    assert_eq!(m.at_caret((4, 5), (5, 5), (0, 0)), (0, 0));
    assert_eq!(m.at_caret((5, 7), (5, 5), (6, 6)), (6, 7));
}

#[test]
fn a_key_range_shrinks_off_a_split_pair() {
    // "😀x": the view's Backspace over an emoji asked for two units; the engine's caret (3) now
    // follows an "x", so only the "x" is deleted.
    let m = DisplayMirror::new("\u{1F600}x");
    assert_eq!(m.at_caret((3, 5), (5, 5), (3, 3)), (2, 3));
    // "x😀" with the caret at 1: a two-unit forward delete shrinks to the "x"-free boundary.
    let m = DisplayMirror::new("x\u{1F600}");
    assert_eq!(m.at_caret((1, 4), (1, 1), (0, 0)), (0, 3));
}

#[test]
fn every_spelling_within_the_slack_gives_the_same_text() {
    // Random insertions and deletions over a tiny alphabet (so runs and repeats are common):
    // each boundary within `slack` units before the reported start, with the units of the new text
    // there, must rebuild the new display from the old one.
    let alphabet = ["a", "b", "\u{1F600}", "ab"];
    let mut seed = 0x2545_F491_4F6C_DD1Du64;
    let mut next = |n: usize| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed % n as u64) as usize
    };
    let mut slid = 0;
    for _ in 0..3000 {
        let old: String = (0..next(9)).map(|_| alphabet[next(4)]).collect();
        let chars: Vec<(usize, char)> = old.char_indices().collect();
        let at = |i: usize| chars.get(i).map_or(old.len(), |c| c.0);
        let (a, b) = (next(chars.len() + 1), next(chars.len() + 1));
        let (a, b) = (a.min(b), a.max(b));
        let inserted: String = if next(2) == 0 {
            String::new()
        } else {
            alphabet[next(4)].into()
        };
        // The engine's report: the smallest change, the common prefix first.
        let mut new = old.clone();
        new.replace_range(at(a)..at(b), &inserted);
        let prefix = old
            .chars()
            .zip(new.chars())
            .take_while(|(x, y)| x == y)
            .count();
        let (s, e, t) = {
            let (o, n): (Vec<char>, Vec<char>) = (old.chars().collect(), new.chars().collect());
            let suffix = o[prefix..]
                .iter()
                .rev()
                .zip(n[prefix..].iter().rev())
                .take_while(|(x, y)| x == y)
                .count();
            (
                prefix,
                o.len() - suffix,
                n[prefix..n.len() - suffix].iter().collect::<String>(),
            )
        };
        let mut m = DisplayMirror::new(&old);
        let Ok(edit) = m.apply_change(at(s), at(e), &t, (0, 0)) else {
            continue;
        };
        let (old16, new16): (Vec<u16>, Vec<u16>) =
            (old.encode_utf16().collect(), new.encode_utf16().collect());
        let removed = edit.end - edit.start;
        for k in 0..=edit.slack {
            let from = edit.start - k;
            let mut rebuilt = old16.clone();
            rebuilt.splice(
                from..from + removed,
                new16[from..from + edit.inserted_utf16].iter().copied(),
            );
            // Only boundaries matter: a split pair is not a spelling a host can ask for.
            if String::from_utf16(&rebuilt).is_ok() {
                assert_eq!(
                    rebuilt, new16,
                    "{old:?} -> {new:?} at {from} (reported {})",
                    edit.start
                );
            }
        }
        slid += (edit.slack > 0) as usize;
    }
    assert!(slid > 100, "the generator rarely slid: {slid}");
}
