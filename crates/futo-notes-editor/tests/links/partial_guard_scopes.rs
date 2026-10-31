//! A valid structural cut owns its field policy, not an equal foreign word.
use super::*;
use futo_notes_editor::{BlockCommand, InlineFormat};

fn check_cut(offset: usize, spelling: &str, suffix: &str) {
    let foreign = "<https\\://x.test`/path`>\n\n";
    let prefix = format!("{foreign}pre ");
    let prefix_view = "<https://x.test/path>\n\npre ";
    let base = prefix_view.len();
    let candidate_source = format!("{foreign}{spelling}");
    let expected_view = format!("<https://x.test/path>\n\npre {suffix}");
    let canonical = EditorSession::open(&candidate_source);
    assert_eq!(canonical.display_text(), expected_view);
    let expected_runs = canonical
        .project(Revision(0), range(0, expected_view.len()))
        .unwrap()
        .runs;
    assert!(canonical
        .project(Revision(0), range(0, expected_view.len()))
        .unwrap()
        .links
        .is_empty());
    let mut editor = EditorSession::open(&prefix);
    let mut view = ReferenceView::new(prefix_view);
    view.apply(
        editor
            .replace(
                Revision(0),
                range(base, base),
                "<https://x.test/path",
                &mut |_| Ok(()),
            )
            .unwrap(),
    );
    view.apply(
        editor
            .replace(Revision(1), range(base + 20, base + 20), ">", &mut |_| {
                Ok(())
            })
            .unwrap(),
    );
    editor
        .select(Revision(2), range(base + 15, base + 20))
        .unwrap();
    view.apply(
        editor
            .toggle_format(Revision(2), InlineFormat::Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    let guarded = editor.source_text();
    assert!(guarded.starts_with(foreign));
    assert_eq!(view.text, format!("{prefix_view}<https://x.test/path>"));
    let cut = range(base + offset, base + offset);
    // Loading the same canonical source has no transient owner. Its successful
    // command independently separates standard representability from lifetime.
    let mut loaded = EditorSession::open(&guarded);
    loaded
        .block_command(Revision(0), cut, BlockCommand::Divider, &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(loaded.display_text(), expected_view);
    assert!(loaded
        .project(Revision(1), range(0, expected_view.len()))
        .unwrap()
        .links
        .is_empty());
    let mut accepted = 0;
    view.apply(editor.block_command(Revision(3), cut, BlockCommand::Divider, &mut |_| { accepted += 1; Ok(()) }).unwrap_or_else(|error| panic!("valid loaded/standard cut rejected; accepted={accepted}; source={guarded:?}; error={error:?}")).unwrap());
    assert_eq!(accepted, 1);
    assert_eq!(view.text, expected_view);
    assert_eq!(
        editor
            .project(Revision(4), range(0, expected_view.len()))
            .unwrap()
            .runs,
        expected_runs
    );
    assert_eq!(editor.source_text(), loaded.source_text());
    assert!(editor.source_text().starts_with(foreign));
    let divided = editor.source_text();
    view.apply(editor.undo(Revision(4), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(editor.source_text(), guarded);
    view.apply(editor.redo(Revision(5), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(editor.source_text(), divided);
    assert_eq!(EditorSession::open(&divided).display_text(), expected_view);
}

#[test]
fn divider_inside_a_live_code_word_accepts_the_same_literal_cut_as_loaded_source() {
    check_cut(
        15,
        "pre <https\\://x.test\n***\n\n`/path`>",
        "<https://x.test\n\u{fffc}\n\n/path>",
    );
}
#[test]
fn divider_inside_code_retains_both_actual_code_fragments_without_uri_authority() {
    check_cut(
        17,
        "pre <https\\://x.test`/p`\n***\n\n`ath`>",
        "<https://x.test/p\n\u{fffc}\n\nath>",
    );
}
