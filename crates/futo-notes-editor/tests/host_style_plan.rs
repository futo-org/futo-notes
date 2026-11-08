use futo_notes_editor::host::{plan_styles, DisplayMirror, ListMarker, StyleSpec};
use futo_notes_editor::*;

fn plan(source: &str) -> (String, Vec<StyleSpec>) {
    let session = EditorSession::open(source);
    let display = session.display_text();
    let slice = session
        .project(
            session.revision(),
            DisplayRange {
                start: DisplayOffset(0),
                end: DisplayOffset(display.len()),
            },
        )
        .unwrap();
    let mirror = DisplayMirror::new(&display);
    let spans = plan_styles(&slice, 0, &mut |b| mirror.byte_to_utf16(b).unwrap());
    (display, spans)
}

#[test]
fn headings_inline_formats_and_lists_are_planned_in_utf16() {
    let (display, spans) = plan("# 日本 **b**\n\n- one\n- [x] two\n\n> q\n");
    assert_eq!(display.lines().next(), Some("日本 b"));
    assert!(spans.contains(&StyleSpec::Heading {
        start: 0,
        end: 5,
        level: 1
    }));
    assert!(spans.iter().any(|s| matches!(
        s,
        StyleSpec::Inline {
            start: 3,
            end: 4,
            bold: true,
            ..
        }
    )));
    let rows: Vec<_> = spans
        .iter()
        .filter_map(|s| match s {
            StyleSpec::ListRow {
                marker,
                checked,
                first: true,
                ..
            } => Some((*marker, *checked, true)),
            _ => None,
        })
        .collect();
    assert_eq!(
        rows,
        vec![
            (ListMarker::Bullet, false, true),
            (ListMarker::Task, true, true)
        ]
    );
    assert!(spans
        .iter()
        .any(|s| matches!(s, StyleSpec::Quote { depth: 1, .. })));
}

#[test]
fn no_span_crosses_a_line() {
    let (display, spans) = plan("> a\n> b\n> c\n");
    let units: Vec<u16> = display.encode_utf16().collect();
    for s in spans {
        let (start, end) = s.range();
        let inside = &units[start..end.saturating_sub(1).max(start)];
        assert!(
            !inside.contains(&10),
            "{s:?} spans a line end in {display:?}"
        );
    }
}

#[test]
fn a_window_planned_with_its_own_offset_matches_the_whole() {
    let source = "intro 日本\n\n## Head\n\ntail **bold**\n";
    let session = EditorSession::open(source);
    let display = session.display_text();
    let mirror = DisplayMirror::new(&display);
    let from = display
        .find("## ")
        .map_or(display.find("Head").unwrap(), |i| i);
    let slice = session
        .project(
            session.revision(),
            DisplayRange {
                start: DisplayOffset(from),
                end: DisplayOffset(display.len()),
            },
        )
        .unwrap();
    let start16 = mirror.byte_to_utf16(from).unwrap();
    let windowed = plan_styles(&slice, start16, &mut |b| mirror.byte_to_utf16(b).unwrap());
    let (_, whole) = plan(source);
    for w in windowed {
        assert!(
            whole.contains(&w),
            "{w:?} missing from the whole plan {whole:?}"
        );
    }
}

fn windowed(session: &EditorSession, mirror: &DisplayMirror, a: usize, b: usize) -> Vec<StyleSpec> {
    let slice = session
        .project(
            session.revision(),
            DisplayRange {
                start: DisplayOffset(a),
                end: DisplayOffset(b),
            },
        )
        .unwrap();
    plan_styles(&slice, mirror.byte_to_utf16(a).unwrap(), &mut |x| {
        mirror.byte_to_utf16(x).unwrap()
    })
}

fn with_range(spec: &StyleSpec, start: usize, end: usize, first: bool) -> StyleSpec {
    let mut out = spec.clone();
    match &mut out {
        StyleSpec::Inline {
            start: s, end: e, ..
        }
        | StyleSpec::Heading {
            start: s, end: e, ..
        }
        | StyleSpec::Quote {
            start: s, end: e, ..
        }
        | StyleSpec::Code { start: s, end: e }
        | StyleSpec::Metadata { start: s, end: e }
        | StyleSpec::Link {
            start: s, end: e, ..
        }
        | StyleSpec::Wikilink {
            start: s, end: e, ..
        }
        | StyleSpec::Divider { start: s, end: e } => (*s, *e) = (start, end),
        StyleSpec::ListRow {
            start: s,
            end: e,
            first: f,
            ..
        } => {
            (*s, *e) = (start, end);
            *f = *f && first;
        }
    }
    out
}

/// The whole-note plan reduced to one window `lo..hi` (UTF-16): each piece clipped to the
/// window, a list row's marker kept only when its piece still starts at the row's own start.
/// Atoms stay whole; empty spans are left out (the engine decides which it projects).
fn restricted(whole: &[StyleSpec], lo: usize, hi: usize) -> Vec<String> {
    let mut out: Vec<String> = whole
        .iter()
        .filter_map(|spec| {
            let (s, e) = spec.range();
            if s >= e {
                return None;
            }
            if matches!(spec, StyleSpec::Wikilink { .. } | StyleSpec::Divider { .. }) {
                return (s < hi && e > lo).then(|| format!("{spec:?}"));
            }
            let (cs, ce) = (s.max(lo), e.min(hi));
            (cs < ce).then(|| format!("{:?}", with_range(spec, cs, ce, s >= lo)))
        })
        .collect();
    out.sort();
    out
}

fn assert_windows_match_the_whole(source: &str) {
    let mut session = EditorSession::open(source);
    let _ = session.update_note_ids(&["known".to_string()]);
    let display = session.display_text();
    let units: Vec<u16> = display.encode_utf16().collect();
    let mirror = DisplayMirror::new(&display);
    let whole = windowed(&session, &mirror, 0, display.len());
    let bounds: Vec<usize> = display
        .char_indices()
        .map(|(i, _)| i)
        .chain([display.len()])
        .collect();
    for (i, &a) in bounds.iter().enumerate() {
        for &b in &bounds[i + 1..] {
            let spans = windowed(&session, &mirror, a, b);
            let (lo, hi) = (
                mirror.byte_to_utf16(a).unwrap(),
                mirror.byte_to_utf16(b).unwrap(),
            );
            for s in &spans {
                let (st, en) = s.range();
                let atom = matches!(s, StyleSpec::Wikilink { .. } | StyleSpec::Divider { .. });
                for p in [st, en] {
                    assert!(
                        p == 0 || p >= units.len() || !(0xDC00..0xE000).contains(&units[p]),
                        "window {a}..{b} of {source:?}: {s:?} splits a surrogate pair"
                    );
                }
                if !atom && st < en {
                    assert!(
                        !units[st..en - 1].contains(&10),
                        "window {a}..{b} of {source:?}: {s:?} crosses a line end"
                    );
                }
            }
            let mut got: Vec<String> = spans
                .iter()
                .filter(|s| s.range().0 < s.range().1)
                .map(|s| format!("{s:?}"))
                .collect();
            got.sort();
            assert_eq!(
                got,
                restricted(&whole, lo, hi),
                "window {a}..{b} of {source:?} differs from the whole plan"
            );
        }
    }
}

#[test]
fn a_heading_that_starts_before_the_window_never_splits_an_emoji() {
    let session = EditorSession::open("# ab😀cd\n");
    let display = session.display_text();
    assert_eq!(display, "ab😀cd\n");
    let mirror = DisplayMirror::new(&display);
    let spans = windowed(&session, &mirror, 6, 9);
    // The window starts at unit 4 (after the emoji); the heading is cut there, not inside it.
    assert_eq!(
        spans,
        vec![StyleSpec::Heading {
            start: 4,
            end: 7,
            level: 1
        }]
    );
}

#[test]
fn a_list_row_straddling_the_window_start_stays_one_piece_without_a_second_marker() {
    let session = EditorSession::open("- abcdefgh\n- x\n");
    let display = session.display_text();
    let mirror = DisplayMirror::new(&display);
    let rows: Vec<_> = windowed(&session, &mirror, 7, 11)
        .into_iter()
        .filter_map(|s| match s {
            StyleSpec::ListRow {
                start, end, first, ..
            } => Some((start, end, first)),
            _ => None,
        })
        .collect();
    // The marker row began before the window: its tail is one piece, not the first; the next row
    // is whole.
    assert_eq!(rows, vec![(7, 9, false), (9, 11, true)]);
}

#[test]
fn every_window_of_a_mixed_note_matches_the_whole_plan() {
    assert_windows_match_the_whole(
        "# H 😀 *em* **b** `c`\n\n- abc 😀 def\n  continued 😀 here\n- [x] done [😀](http://x)\n  1. nested\n\n> quote 😀\n> - in quote **x**\n\n```rust\nlet 😀 = 1;\n\nfn a() {}\n```\n\nsee [[known]] and [[nope]]\r\ncrlf **line** 日本\r\n\r\n---\n",
    );
}
