use futo_notes_editor::host::{plan_quick_open, plan_styles, plan_tables, DisplayMirror};
use futo_notes_editor::{
    may_define_reference, quick_open, DisplayOffset, DisplayRange, EditorSession,
};

/// The render-slice rule written out on UTF-16 units, the way a platform string holds them.
fn naive(units: &[u16], from: usize, chars: usize) -> usize {
    let target = from + chars;
    if target >= units.len() {
        return units.len();
    }
    let blank = (target - 1..units.len() - 1).find(|&i| units[i] == 10 && units[i + 1] == 10);
    if let Some(blank) = blank {
        if blank + 1 - target <= chars * 10 {
            return blank + 1;
        }
    }
    (target..units.len())
        .find(|&i| units[i] == 10)
        .map_or(units.len(), |i| i + 1)
}

fn check(text: &str, from: usize, chars: usize) {
    let units: Vec<u16> = text.encode_utf16().collect();
    let m = DisplayMirror::new(text);
    let end = m.slice_end(from, chars).unwrap();
    assert_eq!(
        end,
        naive(&units, from, chars),
        "{from}+{chars} of {text:?}"
    );
    // Always a place a platform can cut at: a scalar boundary.
    assert!(
        m.utf16_to_byte(end).is_ok(),
        "{from}+{chars}: {end} splits a character"
    );
}

#[test]
fn a_slice_ends_after_the_line_before_the_next_blank_line() {
    let text = "alpha\nbeta\n\ngamma\ndelta\n\nomega";
    let m = DisplayMirror::new(text);
    // The target falls inside "beta": the slice ends where the blank line starts.
    assert_eq!(m.slice_end(0, 8), Ok("alpha\nbeta\n".len()));
    assert_eq!(&text[..11], "alpha\nbeta\n");
    // From the blank line on, the next block ends before its own blank line.
    assert_eq!(
        m.slice_end(11, 8),
        Ok("alpha\nbeta\n\ngamma\ndelta\n".len())
    );
    // Past the end is the end.
    assert_eq!(m.slice_end(0, 1_000), Ok(text.len()));
    assert_eq!(m.slice_end(text.len(), 5), Ok(text.len()));
}

#[test]
fn a_text_with_no_blank_line_in_reach_cuts_at_a_line_end() {
    // One table-free block of lines, no blank line: whole lines only.
    let text = "line\n".repeat(400);
    let m = DisplayMirror::new(&text);
    // The first line end at or after the target (unit 50 is the first unit past a line end).
    assert_eq!(m.slice_end(0, 49), Ok(50));
    assert_eq!(m.slice_end(0, 50), Ok(55));
    assert_eq!(m.slice_end(0, 52), Ok(55));
    // A single line longer than a slice has no line end to cut at but its own.
    let long = format!("{}\nrest", "x".repeat(300));
    assert_eq!(DisplayMirror::new(&long).slice_end(0, 20), Ok(301));
}

#[test]
fn slices_match_the_rule_on_mixed_text_and_never_split_a_pair() {
    let mut text = String::new();
    for i in 0..300 {
        text.push_str(&format!("## 日本 {i}\n\nbody \u{1F600} line {i}\nmore\n\n"));
        if i % 7 == 0 {
            text.push_str("| a | b |\n|---|---|\n| 1 | 2 |\n");
        }
    }
    for chars in [1, 2, 3, 7, 40, 500, 6_000] {
        for from in (0..text.encode_utf16().count()).step_by(97) {
            // A start inside a surrogate pair is the host's mistake; start on boundaries.
            let m = DisplayMirror::new(&text);
            if m.utf16_to_byte(from).is_err() {
                continue;
            }
            check(&text, from, chars);
        }
    }
    assert_eq!(
        DisplayMirror::new("abc").slice_end(4, 1),
        Err(futo_notes_editor::host::MirrorError::OutOfRange)
    );
}

#[test]
fn the_display_begins_with_a_prefix_only_byte_for_byte() {
    let m = DisplayMirror::new("e\u{301}x tail");
    // "é" precomposed is canonically equal but not the same text.
    assert_eq!(m.begins_with("\u{e9}"), None);
    assert_eq!(m.begins_with("e\u{301}x"), Some(3));
    assert_eq!(m.begins_with(""), Some(0));
    assert_eq!(m.begins_with("e\u{301}x tail and more"), None);
    // A prefix that ends inside a scalar of the display is not a prefix.
    assert_eq!(DisplayMirror::new("\u{e9}").begins_with("\u{c3}"), None);
}

fn long_note(blocks: usize) -> String {
    let mut doc = String::new();
    for i in 0..blocks {
        doc.push_str(&format!(
            "## Section {i}\n\nBody *line* {i} with **bold** and `code`.\n\n"
        ));
        if i % 9 == 0 {
            doc.push_str("- one\n- [x] two\n\n> quoted\n\n| a | b |\n|:--|--:|\n| 1 | 2 |\n\n");
        }
    }
    doc
}

#[test]
fn the_quick_plan_is_the_whole_notes_plan_of_the_same_range() {
    let doc = long_note(400);
    let mut end = 16 * 1024;
    while !doc.is_char_boundary(end) {
        end -= 1;
    }
    let rest = &doc.as_bytes()[end.saturating_sub(1)..];
    let quick = quick_open(&doc[..end], || may_define_reference(rest), Vec::new)
        .expect("a quick open stands");
    let planned = plan_quick_open(&quick);
    assert!(!planned.is_empty());

    let session = EditorSession::open(&doc);
    let display = session.display_text();
    assert!(display.starts_with(&quick.display));
    let range = DisplayRange {
        start: DisplayOffset(0),
        end: DisplayOffset(quick.display.len()),
    };
    let mirror = DisplayMirror::new(&display);
    let mut to_utf16 = |byte: usize| mirror.byte_to_utf16(byte).unwrap();
    let slice = session.project(session.revision(), range).unwrap();
    let mut whole = plan_styles(&slice, 0, &mut to_utf16);
    whole.extend(plan_tables(
        &session.inspect_tables(session.revision(), range).unwrap(),
        &mut to_utf16,
    ));
    let shown_units = quick.display.encode_utf16().count();
    // The whole plan also holds the block starting at the cut (its spans lie past the quick
    // display); within the quick display the two agree.
    whole.retain(|spec| spec.range().0 < shown_units);
    assert_eq!(planned, whole);
}

#[test]
fn queued_edits_map_ranges_the_way_replaying_them_in_order_needs() {
    use futo_notes_editor::host::PendingEdits;
    let mut q = PendingEdits::new();
    // Two characters typed at the same caret (5) reach the engine in order: the second after
    // the first, though the view still shows neither.
    assert_eq!(q.push(5, 5, 1), (5, 5));
    assert_eq!(q.push(5, 5, 1), (6, 6));
    // A tap before the typing is where it was; one after it moves by what was typed.
    assert_eq!(q.map(2, 2), (2, 2));
    assert_eq!(q.map(5, 5), (7, 7));
    assert_eq!(q.map(9, 9), (11, 11));
    // A deletion of the view's [8, 9) replays at [10, 11); positions inside a replaced range
    // collapse onto it.
    assert_eq!(q.push(8, 9, 0), (10, 11));
    assert_eq!(q.map(8, 12), (10, 13));
    assert_eq!(q.push(3, 7, 2), (3, 9));
    // The range [5, 6) lies inside the replaced [3, 9): it collapses onto its replacement.
    assert_eq!(q.map(5, 6), (3, 5));
    assert_eq!(q.len(), 4);
    q.clear();
    assert!(q.is_empty());
    assert_eq!(q.map(9, 3), (3, 9));
}

#[test]
fn a_range_ending_where_an_insertion_was_queued_stays_before_it() {
    use futo_notes_editor::host::PendingEdits;
    let mut q = PendingEdits::new();
    // "x" typed at the frozen caret 5 of "hello"; the view still shows "hello|", so a Backspace
    // asks for [4, 5): the text before the caret, not the insertion that sits at 5.
    assert_eq!(q.push(5, 5, 1), (5, 5));
    assert_eq!(q.push(4, 5, 0), (4, 5));
    // Its start, or a collapsed range, at the insertion point still goes after it.
    let mut q = PendingEdits::new();
    q.record(5, 5, 1);
    assert_eq!(q.map(5, 5), (6, 6));
    assert_eq!(q.map(5, 8), (6, 9));
    assert_eq!(q.map(4, 5), (4, 5));
    // A caret stays a caret: a tap at or inside a replacement is not a selection of it.
    let mut q = PendingEdits::new();
    q.record(6, 11, 1);
    assert_eq!(q.map(6, 6), (6, 6));
    assert_eq!(q.map(8, 8), (6, 6));
    assert_eq!(q.map(11, 11), (7, 7));
    // A range ending where a replacement starts does not take the replacement in.
    assert_eq!(q.map(0, 6), (0, 6));
    assert_eq!(q.map(6, 6), (6, 6));
    // A deletion's end is not an insertion point: a range ending there follows the deletion.
    let mut q = PendingEdits::new();
    assert_eq!(q.push(3, 5, 0), (3, 5));
    assert_eq!(q.map(2, 5), (2, 3));
}

#[test]
fn an_edit_in_a_run_is_recorded_where_the_host_asked_for_it() {
    use futo_notes_editor::host::PendingEdits;
    // "a" typed into "aa" is reported at 2 with slack 2: the same text results from an insertion
    // at 0, 1 or 2. A tap at 1 (between the original a's) is at 2 once the typed "a" is before it.
    for (near, tap_lands) in [(0, 2), (1, 2), (2, 1), (9, 1)] {
        let mut q = PendingEdits::new();
        q.record_near(2, 2, 1, 2, near);
        assert_eq!(q.map(1, 1), (tap_lands, tap_lands), "asked for {near}");
    }
    // Without slack, or for a replacement, the engine's report stands.
    let mut q = PendingEdits::new();
    q.record_near(2, 2, 1, 0, 0);
    let mut plain = PendingEdits::new();
    plain.record(2, 2, 1);
    assert_eq!(q, plain);
    let mut q = PendingEdits::new();
    q.record_near(2, 3, 1, 2, 0);
    let mut plain = PendingEdits::new();
    plain.record(2, 3, 1);
    assert_eq!(q, plain);
    // A slack larger than the edit's own position cannot slide it before the text.
    let mut q = PendingEdits::new();
    q.record_near(1, 1, 1, 5, 0);
    assert_eq!(q.map(0, 0), (1, 1));
}

#[test]
fn replaying_queued_edits_on_the_engine_text_equals_applying_them_to_the_view_text() {
    use futo_notes_editor::host::PendingEdits;
    // Edits as a user makes them on a view that does not change; the engine replays them mapped.
    let base: Vec<u16> = "0123456789".encode_utf16().collect();
    let edits: [(usize, usize, &str); 5] = [
        (4, 4, "ab"),
        (4, 4, "c"),
        (0, 2, "X"),
        (9, 10, ""),
        (6, 6, "ZZ"),
    ];
    let mut q = PendingEdits::new();
    let mut engine = base.clone();
    for (start, end, text) in edits {
        let units: Vec<u16> = text.encode_utf16().collect();
        let (s, e) = q.push(start, end, units.len());
        engine.splice(s..e, units);
    }
    // The text a user who typed "ab", then "c" after it, then replaced the first two digits, and
    // so on, would have: each edit on the previous result at the mapped place.
    assert_eq!(String::from_utf16(&engine).unwrap(), "X23abc45ZZ678");
}
