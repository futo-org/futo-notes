//! Tags in the host style plan: coloured ranges, nothing else.
use futo_notes_editor::host::{plan_styles, DisplayMirror, StyleSpec};
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

/// tags.md: a tag is decorated with colour only. iOS drew `#todo` as plain
/// text because neither the projection nor the plan named it.
#[test]
fn tags_are_planned_as_coloured_ranges_and_code_holds_none() {
    let (display, spans) = plan("# 日本 #todo\n- #work, `#no` x#no\n```\n#no\n```\n");
    let tags: Vec<_> = spans
        .iter()
        .filter_map(|s| match s {
            StyleSpec::Tag { start, end } => {
                let units: Vec<u16> = display.encode_utf16().collect();
                Some(String::from_utf16(&units[*start..*end]).unwrap())
            }
            _ => None,
        })
        .collect();
    assert_eq!(tags, ["#todo", "#work"]);
}
