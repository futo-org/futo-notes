use futo_notes_editor::host::toolbar_highlights;
use futo_notes_editor::*;

fn state(source: &str, start: usize, end: usize) -> ToolbarState {
    let mut session = EditorSession::open(source);
    let rev = session.revision();
    session
        .select(
            rev,
            DisplayRange {
                start: DisplayOffset(start),
                end: DisplayOffset(end),
            },
        )
        .unwrap();
    session.toolbar_state()
}

#[test]
fn a_bold_word_in_a_heading_lights_both_and_dims_what_cannot_run() {
    let h = toolbar_highlights(&state("## **hi** there\n", 0, 2));
    assert_eq!(h.active, vec!["bold", "heading-2"]);
    assert!(
        h.disabled.contains(&"undo")
            && h.disabled.contains(&"outdent")
            && !h.disabled.contains(&"indent")
    );
    assert!(!h.disabled.contains(&"bold"));
}

#[test]
fn plain_text_lights_paragraph_and_a_list_lights_its_kind() {
    assert_eq!(
        toolbar_highlights(&state("plain\n", 0, 0)).active,
        vec!["paragraph"]
    );
    assert_eq!(
        toolbar_highlights(&state("- item\n", 0, 0)).active,
        vec!["bullet-list"]
    );
}

#[test]
fn code_dims_inline_formats() {
    let h = toolbar_highlights(&state("```\nx\n```\n", 0, 1));
    assert!(h.active.contains(&"code-block"));
    assert!(h.disabled.contains(&"bold"));
}
