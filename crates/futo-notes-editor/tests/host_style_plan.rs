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

#[test]
fn an_image_is_one_unbroken_span_with_the_engines_classification() {
    let (display, spans) = plan("日本 ![a b](pic 1.png) x ![](https://e.com/p.png)\n![](my.png)\n");
    let units: Vec<u16> = display.encode_utf16().collect();
    let text = |s: usize, e: usize| String::from_utf16(&units[s..e]).unwrap();
    let images: Vec<_> = spans
        .iter()
        .filter_map(|s| match s {
            StyleSpec::Image {
                start,
                end,
                destination,
                alt,
                vault,
                remote,
            } => Some((
                text(*start, *end),
                destination.clone(),
                alt.clone(),
                *vault,
                *remote,
            )),
            _ => None,
        })
        .collect();
    assert_eq!(images.len(), 2, "{spans:?}");
    // `pic 1.png` has a space, so only the angle spelling is an image; the bare one is text.
    assert_eq!(
        images[0],
        (
            "![](https://e.com/p.png)".into(),
            "https://e.com/p.png".into(),
            "".into(),
            false,
            true
        )
    );
    assert_eq!(
        images[1],
        (
            "![](my.png)".into(),
            "my.png".into(),
            "".into(),
            true,
            false
        )
    );
}

#[test]
fn an_image_atom_stays_whole_when_split_at_lines() {
    let (_, spans) = plan("a ![alt](x.png) b\nsecond\n");
    let image: Vec<_> = spans
        .iter()
        .filter(|s| matches!(s, StyleSpec::Image { .. }))
        .collect();
    assert_eq!(image.len(), 1);
    assert_eq!(image[0].range(), (2, 15));
}
