//! Quick open shows a long note's first screens before its whole-note session
//! exists; the handover must change nothing on screen. Every fixture is opened
//! both ways, at every read length, and the first screens compared byte for
//! byte and style for style.
use futo_notes_editor::{
    may_define_reference, quick_open, quick_open_cut, shown_projection, DisplayOffset,
    DisplayRange, EditorSession, QuickOpen,
};

const IDS: [&str; 3] = ["Alpha", "Projects/Beta", "Archive/Beta"];

fn ids() -> Vec<String> {
    IDS.iter().map(|id| (*id).to_owned()).collect()
}

/// The quick open of `doc` read to `limit` bytes, as a host reads it.
fn quick(doc: &str, limit: usize) -> Option<QuickOpen> {
    let mut end = limit.min(doc.len());
    while !doc.is_char_boundary(end) {
        end -= 1;
    }
    let head = &doc[..end];
    let rest = &doc.as_bytes()[end.saturating_sub(1)..];
    quick_open(head, || may_define_reference(rest), ids)
}

struct Whole {
    session: EditorSession,
    display: String,
}

fn whole(doc: &str) -> Whole {
    let mut session = EditorSession::open(doc);
    session.update_note_ids(&ids());
    let display = session.display_text();
    Whole { session, display }
}

/// The quick open at `limit` is the whole note's first screen; true when it showed one.
fn agrees(name: &str, doc: &str, full: &Whole, limit: usize) -> bool {
    let Some(quick) = quick(doc, limit) else {
        return false;
    };
    assert!(
        full.display.starts_with(&quick.display),
        "{name} @{limit}: display differs\nquick: {:?}\nwhole: {:?}",
        quick.display,
        &full.display[..quick.display.len().min(full.display.len())]
    );
    let range = DisplayRange {
        start: DisplayOffset(0),
        end: DisplayOffset(quick.display.len()),
    };
    let revision = full.session.revision();
    let mut projection = shown_projection(full.session.project(revision, range).unwrap());
    projection.revision = quick.projection.revision;
    assert_eq!(
        projection, quick.projection,
        "{name} @{limit}: styles differ for {:?}",
        quick.display
    );
    // A table starting at the cut is the next screen's.
    let starting = |mut tables: Vec<futo_notes_editor::TableDescription>| {
        tables.retain(|table| table.display.start.0 < range.end.0);
        tables
    };
    assert_eq!(
        starting(full.session.inspect_tables(revision, range).unwrap()),
        starting(quick.tables),
        "{name} @{limit}: tables differ"
    );
    assert!(quick.source_len <= limit);
    true
}

/// Every read length; returns how many showed a first screen.
fn every_length(name: &str, doc: &str) -> usize {
    let full = whole(doc);
    (0..=doc.len())
        .filter(|&limit| agrees(name, doc, &full, limit))
        .count()
}

fn pad() -> String {
    "para\n\n".repeat(5)
}

/// The shapes the desktop chunk planner's tests and census found it cutting
/// inside (markdownChunks*.test.ts), placed before, at and after a cut.
fn census_shapes() -> Vec<(&'static str, String)> {
    let shapes: Vec<(&str, &str)> = vec![
        ("html comment over a blank", "<!-- a\n\nb -->\n\nafter\n"),
        ("pre over a blank", "<pre>\na\n\nb\n</pre>\n\nafter\n"),
        ("bare inline tag", "<span>x</span>\n\nafter\n"),
        (
            "fence under html",
            "<div>\n```\n\ntext\n\n````\n# c\n\nmore\n````\n\nafter\n",
        ),
        (
            "fence indented one",
            " ```\ncode\n```\n\ntext\n ```\n# c\n\nmore\n```\n\nafter\n",
        ),
        ("fence on a list item line", "- ~~~\n  code\n\n\n\nafter\n"),
        (
            "fence inside a list item",
            "1. see:\n   ```bash\n   x\n   ```\n\nafter\n",
        ),
        ("fence inside a quote", "> ```\n> x\n\n\nafter\n"),
        ("lone CR", "para\r```\n\n# in code\n\n```\n\nafter\n"),
        ("NBSP-only line", "para\n\n\u{a0}\n2. not a list\n\nafter\n"),
        (
            "ideographic-space line",
            "para\n\n\u{3000}\n2. not a list\n\nafter\n",
        ),
        ("form-feed line", "para\n\n\u{c}\n2. not a list\n\nafter\n"),
        ("U+2028", "para\u{2028}```\n\nafter\n"),
        ("comment in a list item", "- <!--\n\ntext\n\n- b\n"),
        (
            "pre in a list item",
            "- <pre>\n\n  foo\n\n# h\n</pre>\n\nafter\n",
        ),
        ("pre in a quote", "> <pre>\n\nfoo\n\n# h\n</pre>\n\nafter\n"),
        ("pre in an ordered item", "1. <pre>\n\n# h\n\nafter\n"),
        ("script in a nested item", "  * <script>\n\n# h\n\nafter\n"),
        (
            "mid-note U+FEFF",
            "para\n\n\u{feff}# not a heading\n\nafter\n",
        ),
        (
            "definition in a list item",
            "- [a]: https://e.com/x\n\nafter [a]\n",
        ),
        (
            "definition in a quote",
            "> [a]: https://e.com/x\n\nafter [a]\n",
        ),
        (
            "escaped bracket label",
            "[si\\]te]: https://e.com/x\nmore\n\nafter [si\\]te]\n",
        ),
        (
            "two-line label",
            "[my\nsite]: https://e.com/x\nmore\n\nafter [my site]\n",
        ),
        (
            "footnote in a list item",
            "- [^n]: note body\n\nafter[^n]\n",
        ),
        (
            "autolink in a list item",
            "- <https://example.com/x>\n\nafter\n",
        ),
        (
            "fenced definition",
            "```\n<div>\n[a]: not a definition\n```\n\n",
        ),
        ("unclosed fence", "```\ncode\n\nmore\n"),
        ("blank in a fence", "```\nx\n\ny\n```\n\nafter\n"),
        ("tilde fence", "~~~\nx\n\ny\n~~~\n\nafter\n"),
        ("longer fence", "````\n```\n\nstill code\n````\n\nafter\n"),
        ("loose bullet list", "- a\n\n- b\n\nafter\n"),
        ("loose ordered list", "1. a\n\n2. b\n\nafter\n"),
        ("item continuation", "- a\n\n  still the item\n\nafter\n"),
        ("indented code", "    code\n\n    more code\n\nafter\n"),
        ("space-only line", "para\n \nafter\n\ntail\n"),
        ("list after para", "para\n\n- a\n- b\n\nafter\n"),
        ("para after list", "- a\n\npara\n\nafter\n"),
        ("empty item", "## A\n\n- \n\n## B\n"),
        ("empty ordered item", "## A\n\n1.\n\n## B\n"),
        ("dash rule", "## A\n\n---\n\ntail\n"),
        ("long rule", "## A\n\n----\n\ntail\n"),
        ("setext", "para\n---\n\nnext\n===\n\ntail\n"),
        (
            "backtick info",
            "a\n\n```toml`\nb = 1\n\nstill a paragraph\n\ntail\n",
        ),
        (
            "weird tilde info",
            "a\n\n~~~`weird`\ncode\n\nmore code\n~~~\n\ntail\n",
        ),
        ("CRLF", "a\r\n\r\n# b\r\n\r\n- c\r\n- d\r\n\r\ntail\r\n"),
        ("table", "| a | b |\n|---|---|\n| 1 | 2 |\n\nafter\n"),
        (
            "table under para",
            "para\n| a | b |\n|---|---|\n| 1 | 2 |\n\nafter\n",
        ),
        ("quote lazy line", "> quote\nlazy\n\nafter\n"),
        (
            "nested list",
            "- a\n  - b\n    - c\n\n1. x\n   1. y\n\nafter\n",
        ),
        ("tasks", "- [ ] todo\n- [x] done\n\nafter\n"),
        ("image", "![pic](attachments/pic.png)\n\nafter\n"),
        (
            "wikilinks",
            "see [[Beta]] and [[Alpha|a]] and [[Missing]]\n\nafter #tag\n",
        ),
        (
            "emphasis",
            "**bold** *it* ~~gone~~ `code` <https://x.test>\n\nafter\n",
        ),
        ("html block", "<div>\nhtml\n</div>\n\nafter\n"),
        ("hard break", "line  \nnext\\\nlast\n\nafter\n"),
    ];
    shapes
        .into_iter()
        .flat_map(|(name, shape)| {
            [
                (name, format!("{}{shape}{}", pad(), pad())),
                (name, format!("{shape}{}", pad())),
                (name, format!("{}{shape}", pad())),
            ]
        })
        .collect()
}

#[test]
fn every_census_shape_shows_the_whole_notes_first_screen() {
    let mut shown = 0;
    for (name, doc) in census_shapes() {
        shown += every_length(name, &doc);
    }
    assert!(shown > 1000, "only {shown} reads showed a first screen");
}

#[test]
fn front_matter_shows_only_once_it_closes_inside_the_read() {
    let doc = format!("---\ntitle: T\n\nb: 2\n---\n\n## A\n\ntext\n\n{}", pad());
    let full = whole(&doc);
    assert!(
        !agrees("open", &doc, &full, 12),
        "an unclosed front matter is declined"
    );
    assert!(every_length("front matter", &doc) > 0);
    let bom = format!("\u{feff}{doc}");
    every_length("bom", &bom);
}

/// CommonMark only: the core reads no reference definitions (Linedown).
#[cfg(not(feature = "engine"))]
#[test]
fn a_definition_after_the_cut_declines_when_the_first_screen_can_use_it() {
    let tail = "para\n\n".repeat(200);
    for doc in [
        format!("see [foo]\n\n{tail}[foo]: https://example.com\n"),
        format!("text[^1]\n\n{tail}[^1]: the note\n"),
    ] {
        assert!(quick(&doc, 600).is_none());
        every_length("late definition", &doc);
    }
    // Without a bracket on screen, nothing it shows can reach a definition.
    let doc = format!("plain\n\n{tail}[foo]: https://example.com\n");
    assert!(quick(&doc, 600).is_some());
}

/// The large notes the app opens: the measured perf note, the progressive-open
/// instrumentation note, and a note with no blank line at all.
#[test]
fn long_notes_show_a_first_screen_that_matches() {
    let sections: String = (0..1000)
        .map(|i| format!("## Section {i}\n\nBody line {i} with **bold**.\n\n"))
        .collect();
    let mixed: String = (0..300)
        .map(|i| {
            format!(
                "## Section {i}\n\nProse with **bold**, *italic*, `code` and a [link](https://example.com/{i}).\n\n\
                 - item one\n- item two\n  - nested\n- [ ] todo {i}\n- [x] done\n\n\
                 | a | b |\n|---|---|\n| {i} | x |\n| 2 | y |\n\n![pic {i}](attachments/pic{i}.png)\n\n\
                 > quote {i}\n\n```\ncode {i}\n\nmore\n```\n\n"
            )
        })
        .collect();
    let lines: String = (0..1000)
        .map(|i| match i % 4 {
            0 => format!("paragraph {i} with **bold** and [a link](https://example.test/{i})\n"),
            1 => format!("- list item {i}\n"),
            2 => format!("> quoted line {i}\n"),
            _ => format!("`inline code {i}`\n"),
        })
        .collect();
    for (name, doc) in [("sections", &sections), ("mixed", &mixed)] {
        let full = whole(doc);
        let at = futo_notes_editor::QUICK_OPEN_BYTES;
        assert!(agrees(name, doc, &full, at), "{name} shows a first screen");
        let cut = quick_open_cut(&doc[..at]).unwrap();
        assert!(cut > at - 600, "{name} cuts near the read: {cut}");
        for limit in (0..at * 2).step_by(97) {
            agrees(name, doc, &full, limit);
        }
    }
    let at = futo_notes_editor::QUICK_OPEN_BYTES;
    if cfg!(feature = "engine") {
        // Every line ending is a cut.
        assert!(agrees("lines", &lines, &whole(&lines), at));
    } else {
        // No empty line to cut after: the whole open shows it.
        assert!(quick(&lines, at).is_none());
    }
}

/// Census over a note corpus, one JSON object per line with the body under
/// `body`, `content` or `text`: `QUICK_OPEN_CORPUS=notes.jsonl cargo test
/// --release -p futo-notes-editor --test quick_open -- --ignored`.
#[test]
#[ignore]
fn corpus_census() {
    let path = std::env::var("QUICK_OPEN_CORPUS").expect("QUICK_OPEN_CORPUS");
    let corpus = std::fs::read_to_string(path).unwrap();
    let (mut notes, mut reads, mut shown) = (0, 0, 0);
    for line in corpus.lines() {
        let value: serde_json::Value = serde_json::from_str(line).unwrap();
        let Some(doc) = ["body", "content", "text"]
            .iter()
            .find_map(|key| value.get(key).and_then(|body| body.as_str()))
        else {
            continue;
        };
        notes += 1;
        let full = whole(doc);
        let step = (doc.len() / 24).max(1);
        for limit in (step..doc.len()).step_by(step) {
            reads += 1;
            shown += usize::from(agrees("corpus", doc, &full, limit));
        }
    }
    eprintln!("{notes} notes, {reads} reads, {shown} showed a first screen that matched");
}
