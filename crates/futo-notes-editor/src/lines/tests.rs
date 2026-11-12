use super::*;

/// One line as the fixture file spells it: `q1 bullet d0 - : text [bold **b**]`.
pub(super) fn describe(source: &str, line: &Line, spans: &[Span]) -> String {
    let mut out = String::new();
    if line.quote > 0 {
        out.push_str(&format!("q{} ", line.quote));
    }
    let at = |indent: &usize| {
        if *indent == 0 {
            String::new()
        } else {
            format!(" i{indent}")
        }
    };
    let mut content = true;
    match &line.kind {
        Kind::Plain { indent } => out.push_str(&format!("plain{}", at(indent))),
        Kind::Blank => {
            out.push_str("blank");
            content = false;
        }
        Kind::Heading { level } => out.push_str(&format!("h{level}")),
        Kind::List {
            indent, text, task, ..
        } => {
            let marker = &source[text.clone()];
            match (task, marker.ends_with(['.', ')'])) {
                (Some(checked), _) => {
                    let mark = source[line.marker.end - 3..line.marker.end - 2].to_owned();
                    let mark = if *checked { mark } else { " ".into() };
                    out.push_str(&format!("task i{indent} {marker} [{mark}]"))
                }
                (None, true) => out.push_str(&format!("number i{indent} {marker}")),
                (None, false) => out.push_str(&format!("bullet i{indent} {marker}")),
            }
        }
        Kind::Divider => {
            out.push_str("divider");
            content = false;
        }
        Kind::FrontMatter(role) => {
            out.push_str(match role {
                FrontMatterRole::Open => "front-open",
                FrontMatterRole::Body => "front",
                FrontMatterRole::Close => "front-close",
            });
            content = false;
        }
        Kind::Fence {
            role,
            indent,
            language,
        } => {
            let name = match role {
                FenceRole::Open => "fence-open",
                FenceRole::Code => "code",
                FenceRole::Close => "fence-close",
            };
            out.push_str(&format!("{name}{}", at(indent)));
            if let Some(language) = language {
                out.push_str(&format!(" {}", &source[language.clone()]));
            }
            content = *role == FenceRole::Code;
        }
        Kind::Table { role, columns } => {
            let name = match role {
                TableRole::Header => "table-header",
                TableRole::Delimiter => "table-delimiter",
                TableRole::Row => "table-row",
            };
            out.push_str(&format!("{name} {columns}"));
            content = *role != TableRole::Delimiter;
        }
    }
    if content {
        out.push_str(" : ");
        out.push_str(&source[line.content.clone()]);
    }
    for span in spans {
        let kind = match span.kind {
            SpanKind::Bold => "bold",
            SpanKind::Italic => "italic",
            SpanKind::Strike => "strike",
            SpanKind::Code => "code",
            SpanKind::Link { .. } => "link",
            SpanKind::Url { .. } => "url",
            SpanKind::Image { .. } => "image",
            SpanKind::Wikilink { .. } => "wikilink",
            SpanKind::Tag => "tag",
            SpanKind::Escape => "escape",
        };
        out.push_str(&format!(" [{kind} {}]", &source[span.range.clone()]));
    }
    out
}

fn described(source: &str) -> Vec<String> {
    let reading = Reading::new(source);
    reading
        .lines
        .iter()
        .zip(&reading.spans)
        .map(|(line, spans)| describe(source, line, spans))
        .collect()
}

#[derive(serde::Deserialize)]
struct Fixtures {
    cases: Vec<Case>,
}

#[derive(serde::Deserialize)]
struct Case {
    name: String,
    input: String,
    lines: Vec<String>,
}

fn fixtures() -> Vec<Case> {
    [
        include_str!("../../tests/fixtures/linedown/blocks.json"),
        include_str!("../../tests/fixtures/linedown/lists-and-quotes.json"),
        include_str!("../../tests/fixtures/linedown/code-and-tables.json"),
        include_str!("../../tests/fixtures/linedown/inline.json"),
        include_str!("../../tests/fixtures/linedown/not-in-version-1.json"),
    ]
    .into_iter()
    .flat_map(|text| serde_json::from_str::<Fixtures>(text).unwrap().cases)
    .collect()
}

#[test]
fn every_fixture_reads_as_written() {
    let cases = fixtures();
    assert!(cases.len() >= 100, "{} cases", cases.len());
    let mut failures = Vec::new();
    for case in &cases {
        let actual = described(&case.input);
        if actual != case.lines {
            failures.push(format!(
                "{}\n  input:    {:?}\n  expected: {:#?}\n  actual:   {:#?}",
                case.name, case.input, case.lines, actual
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

#[test]
fn lines_are_whole_and_in_order() {
    for case in fixtures() {
        let reading = Reading::new(&case.input);
        let mut at = 0;
        for line in &reading.lines {
            assert_eq!(line.range.start, at, "{}", case.name);
            assert!(line.marker.end <= line.range.end || line.marker.is_empty());
            at = line.end();
        }
        assert_eq!(at, case.input.len(), "{}", case.name);
    }
}

/// A line's reading never depends on a line after it, except a header on the
/// delimiter row below: appending text never changes an earlier line.
#[test]
fn appending_never_changes_an_earlier_line() {
    for case in fixtures() {
        let source = &case.input;
        let mut ends: Vec<usize> = source.match_indices('\n').map(|(at, _)| at + 1).collect();
        ends.push(source.len());
        for end in ends {
            let prefix = &source[..end];
            let before = Reading::new(prefix);
            let after = Reading::new(source);
            let settled = before.lines.len().saturating_sub(2);
            for index in 0..settled {
                // The two later-line cases: a table header, and front matter
                // that a closing `---` below opens on line 1.
                if matches!(
                    after.lines[index].kind,
                    Kind::Table {
                        role: TableRole::Header,
                        ..
                    } | Kind::FrontMatter(_)
                ) {
                    continue;
                }
                assert_eq!(
                    before.lines[index], after.lines[index],
                    "{}: line {index} changed when text was added below it",
                    case.name
                );
            }
        }
    }
}

const INSERTS: &[&str] = &[
    "\n", "\r\n", "-", " ", "  ", "\t", "|", "|---|", "```", "~~~", "---", "x", "> ", "# ", "1. ",
    "[ ] ", "*", "`", "\n\n",
];

/// Incremental re-reading equals reading the edited note from scratch.
#[test]
fn update_matches_a_fresh_read() {
    let mut checked = 0;
    for case in fixtures() {
        let source = case.input.clone();
        let boundaries: Vec<usize> = (0..=source.len())
            .filter(|&at| source.is_char_boundary(at))
            .collect();
        for &at in &boundaries {
            for insert in INSERTS {
                check_edit(&source, at, at, insert);
                checked += 1;
            }
        }
        for (index, &from) in boundaries.iter().enumerate() {
            for &to in boundaries.iter().skip(index + 1).take(4) {
                check_edit(&source, from, to, "");
                check_edit(&source, from, to, "\n");
                checked += 2;
            }
        }
    }
    assert!(checked > 10_000, "{checked}");
}

fn check_edit(source: &str, from: usize, to: usize, insert: &str) {
    let mut reading = Reading::new(source);
    let edited = format!("{}{insert}{}", &source[..from], &source[to..]);
    reading.update(&edited, from, to - from, insert.len());
    let fresh = Reading::new(&edited);
    assert_eq!(
        reading, fresh,
        "edit {from}..{to} -> {insert:?} on {source:?}"
    );
}

/// A note that only grows at the end re-reads only its last lines.
#[test]
fn typing_at_the_end_rereads_little() {
    let mut source = String::new();
    for index in 0..2_000 {
        source.push_str(&format!("- item {index}\n"));
    }
    let mut reading = Reading::new(&source);
    let at = source.len();
    source.push('x');
    let read = reading.update(&source, at, 0, 1);
    assert!(read.len() <= 2, "{read:?}");
    let at = 10;
    source.insert(at, 'y');
    let read = reading.update(&source, at, 0, 1);
    assert!(read.len() <= 3, "{read:?}");
    assert_eq!(reading, Reading::new(&source));
}

/// No list state is carried: indenting one bullet re-reads that line and the
/// one above it (the table-header look-back), and nothing below.
#[test]
fn indenting_a_bullet_settles_on_the_same_line() {
    let mut source = String::new();
    for index in 0..2_000 {
        source.push_str(&format!("- item {index}\n"));
    }
    let mut reading = Reading::new(&source);
    let at = source.find("- item 1000").unwrap();
    source.insert_str(at, "    ");
    let read = reading.update(&source, at, 0, 4);
    assert!(read.len() <= 2, "{read:?}");
    assert_eq!(reading, Reading::new(&source));
    assert!(matches!(
        reading.lines[1000].kind,
        Kind::List { indent: 4, .. }
    ));
    assert!(matches!(
        reading.lines[1001].kind,
        Kind::List { indent: 0, .. }
    ));
}
