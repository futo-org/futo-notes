//! One long line of inline marks opens and takes a key in time linear in its
//! length. Each shape below made the inline reading or the projection
//! quadratic in the marks on the line: a key in a 256 KiB bold line took
//! seconds, `[[a` 100,000 times about as long, and a 1 MB line of links never
//! finished. The bound is generous (the cost now is tens of milliseconds, in
//! release and in the test profile alike).
use futo_notes_editor::{DisplayOffset, DisplayRange, EditorSession};
use std::time::{Duration, Instant};

fn caret(at: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(at),
        end: DisplayOffset(at),
    }
}

/// Open `line`, type `x` in the middle of its display and undo it, all inside
/// a second and a half; the undo restores the exact source.
fn opens_and_takes_a_key_quickly(name: &str, line: &str) {
    let started = Instant::now();
    let mut session = EditorSession::open(line);
    let shown = session.display_text();
    let middle = (0..=shown.len() / 2)
        .rev()
        .find(|&at| shown.is_char_boundary(at))
        .unwrap();
    session
        .replace(session.revision(), caret(middle), "x", &mut |_| Ok(()))
        .unwrap();
    assert!(session.source_text().contains('x'), "{name}");
    session.undo(session.revision(), &mut |_| Ok(())).unwrap();
    assert_eq!(session.source_text(), line, "{name}");
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_millis(1_500),
        "{name}: {elapsed:?}"
    );
}

#[test]
fn a_line_of_many_formatted_spans_takes_a_key_quickly() {
    opens_and_takes_a_key_quickly("bold", &"**bold** plain ".repeat(17_500));
    opens_and_takes_a_key_quickly("code", &"`code` plain ".repeat(20_000));
}

#[test]
fn a_line_of_many_links_opens_quickly() {
    opens_and_takes_a_key_quickly("links", &"[a](https://e.com/x) ".repeat(50_000));
    opens_and_takes_a_key_quickly("bold links", &"**[a](u)** ".repeat(25_000));
    opens_and_takes_a_key_quickly("images", &"![a](p.png) ".repeat(25_000));
    opens_and_takes_a_key_quickly(
        "open brackets then links",
        &format!("{}{}", "[".repeat(40_000), "[a](u)".repeat(40_000)),
    );
}

#[test]
fn a_line_of_unclosed_openers_opens_quickly() {
    opens_and_takes_a_key_quickly("wikilink openers", &"[[a".repeat(100_000));
    opens_and_takes_a_key_quickly("bracket openers", &"[".repeat(300_000));
    opens_and_takes_a_key_quickly("angle openers", &"<a ".repeat(100_000));
}
