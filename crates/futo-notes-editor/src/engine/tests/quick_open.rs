//! Opening the start of a large note: the head's whole lines are read alone,
//! and every line it shows reads and shows exactly as in the whole note.
use super::range;
use crate::engine::Engine;
use crate::quick_open::{parsed_len, shown_len, shown_projection, QUICK_OPEN_BYTES};

/// The first `read` bytes of `note`, without a character the read cut, as
/// the store reads them; `None` when the read holds the whole note.
fn head(note: &str, read: usize) -> Option<&str> {
    if read >= note.len() {
        return None;
    }
    let mut end = read;
    while !note.is_char_boundary(end) {
        end -= 1;
    }
    Some(&note[..end])
}

/// The quick open of `note` read to `read` bytes, checked against the whole
/// note: the shown source bytes, or `None` when the note opens whole.
fn checked(note: &str, read: usize) -> Option<usize> {
    let head = head(note, read)?;
    assert!(head.len() <= read && note.is_char_boundary(head.len()));
    let parsed = parsed_len(head)?;
    let engine = Engine::open(&head[..parsed]);
    let shown = shown_len(&engine)?;
    let context = format!("{note:?} read to {read}, shown {shown}");
    // The cut stands right after a line's `\n`: never inside a CRLF or a
    // character, and the line after it was read too.
    assert!(shown > 0 && shown < parsed, "{context}");
    assert!(note.is_char_boundary(shown), "{context}");
    assert_eq!(note.as_bytes()[shown - 1], b'\n', "{context}");
    let full = Engine::open(note);
    let end = engine.display_of(shown);
    assert_eq!(end, full.display_of(shown), "{context}");
    let quick = shown_projection(engine.project(engine.revision(), range(0, end)).unwrap());
    let whole = shown_projection(full.project(full.revision(), range(0, end)).unwrap());
    assert_eq!(quick, whole, "{context}");
    Some(shown)
}

struct Random(u64);

impl Random {
    fn below(&mut self, bound: usize) -> usize {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 % bound.max(1) as u64) as usize
    }

    fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
        items[self.below(items.len())]
    }
}

/// Lines whose reading reaches other lines (fences, front matter, tables)
/// beside ordinary blocks and multi-byte text.
const LINES: &[&str] = &[
    "",
    "   ",
    "plain words",
    "# Heading **b**",
    "- item",
    "  - nested *it*",
    "1. one",
    "- [x] done",
    "> quote",
    "---",
    "***",
    "```",
    "```rust",
    "~~~",
    "| a | b |",
    "|---|:-:|",
    "| 1 | **2** |",
    "|",
    "**open",
    "close**",
    "`code` [t](https://x.y) [[note]] #tag",
    "é 😀 日本",
    "a\rb",
    "\\- kept",
];

fn note(random: &mut Random) -> String {
    let mut out = String::new();
    if random.below(4) == 0 {
        out.push_str("---\n");
    }
    for line in 0..1 + random.below(30) {
        if line > 0 {
            out.push_str(if random.below(4) == 0 { "\r\n" } else { "\n" });
        }
        out.push_str(random.pick(LINES));
    }
    if random.below(2) == 0 {
        out.push('\n');
    }
    out
}

#[test]
fn the_head_shows_its_lines_as_the_whole_note_does() {
    let seed = std::env::var("TYPING_SEED").map_or(0x2545_f491_4f6c_dd1d, |seed| {
        seed.parse().expect("TYPING_SEED")
    });
    let cases: usize =
        std::env::var("TYPING_CASES").map_or(300, |cases| cases.parse().expect("TYPING_CASES"));
    let mut random = Random(seed | 1);
    let (mut reads, mut shown) = (0, 0);
    for _ in 0..cases {
        let note = note(&mut random);
        for _ in 0..8 {
            reads += 1;
            shown += usize::from(checked(&note, random.below(note.len() + 1)).is_some());
        }
    }
    assert!(
        shown * 3 > reads,
        "only {shown} of {reads} reads showed lines"
    );
}

#[test]
fn front_matter_shows_only_when_it_closes_inside_the_read() {
    let body = "line\n".repeat(20);
    let closed = format!("---\ntitle: T\n---\n{body}");
    let read = closed.len() - 10;
    assert_eq!(checked(&closed, read), Some(read - "line\n".len()));
    // The close is past the read: the rest of the note decides what line 1 is.
    let late = format!("---\ntitle: T\n{body}---\nafter\n");
    assert_eq!(checked(&late, 60), None);
    let never = format!("---\n{body}");
    assert_eq!(checked(&never, 60), None);
    // A divider that is not exactly `---` opens nothing.
    let rule = format!("----\n{body}");
    assert!(checked(&rule, 60).is_some());
}

#[test]
fn a_table_at_the_cut_is_left_for_the_whole_open() {
    let note = "a\nb\n| h | i |\n|---|---|\n| 1 | 2 |\nafter\nmore\nend\n";
    let through = |line: &str| note.find(line).unwrap() + line.len();
    // The header's delimiter row is past the cut: the header is read, not shown.
    // Any table line before the cut moves it to the table's start.
    for line in ["| h | i |\n", "|---|---|\n", "| 1 | 2 |\n", "after\n"] {
        assert_eq!(checked(note, through(line) + 2), Some(4), "{line:?}");
    }
    assert_eq!(
        checked(note, through("more\n") + 2),
        Some(through("after\n"))
    );
    // A table from line 1 to the cut shows nothing.
    assert_eq!(checked(&note[4..], 30), None);
}

#[test]
fn the_cut_never_splits_a_crlf_or_a_character() {
    let note = "one\r\ntwo\r\nthree é\r\nfour\r\nfive\r\n";
    let crlf = note.find("two\r\n").unwrap() + 4;
    assert_eq!(checked(note, crlf), None);
    assert_eq!(checked(note, crlf + 1), Some(5));
    let e = note.find('é').unwrap();
    assert_eq!(checked(note, e + 1), Some(5));
    // Every read, every byte.
    for read in 0..note.len() {
        checked(note, read);
    }
}

#[test]
fn an_empty_code_block_at_the_cut_shows_as_in_the_whole_note() {
    let note = "x\n```\n```\nafter\n";
    let shown = checked(note, note.find("after").unwrap()).unwrap();
    assert_eq!(shown, 6);
    let engine = Engine::open(&note[..10]);
    assert_eq!(engine.display_slice(0..engine.display_of(shown)), "x\n\n");
}

/// The head of a 20,000-line note reads about `QUICK_OPEN_BYTES`, however
/// long the note.
#[test]
fn a_long_notes_head_reads_only_its_first_bytes() {
    let note: String = (0..20_000)
        .map(|i| match i % 5 {
            0 => format!("## Section {i}\n"),
            1 => format!("Prose {i} with **bold** and [a link](https://x.test/{i}).\n"),
            2 => format!("- item {i}\n"),
            3 => "| a | b |\n".to_owned(),
            _ => format!("> quote {i}\n"),
        })
        .collect();
    let head = head(&note, QUICK_OPEN_BYTES).unwrap();
    let parsed = parsed_len(head).unwrap();
    let engine = Engine::open(&head[..parsed]);
    let shown = checked(&note, QUICK_OPEN_BYTES).unwrap();
    assert!(parsed <= QUICK_OPEN_BYTES && shown > QUICK_OPEN_BYTES - 200);
    eprintln!(
        "head of 20,000 lines: {} lines, {parsed} bytes read",
        engine.line_count()
    );
    assert!(engine.line_count() < 1_000, "{}", engine.line_count());
    assert_eq!(Engine::open(&note).line_count(), 20_001);
}
