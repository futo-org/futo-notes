//! Case stays user data; canonical GFM grammar and input ownership are separate.
use super::*;
use futo_notes_editor::InputAction;

fn raw_library_link(inner: &str, destination: &str) {
    // The exact maintained-library options of the existing bare-link owner,
    // before its cheap trigger or any editor adaptation can affect the result.
    let tree = markdown::to_mdast(
        inner,
        &markdown::ParseOptions {
            constructs: markdown::Constructs {
                gfm_autolink_literal: true,
                ..Default::default()
            },
            ..Default::default()
        },
    )
    .unwrap();
    let paragraph = &tree.children().unwrap()[0];
    let node = &paragraph.children().unwrap()[0];
    let markdown::mdast::Node::Link(link) = node else {
        panic!("canonical raw parser did not recognize {inner:?}: {tree:?}");
    };
    assert_eq!(link.url, destination);
    assert_eq!(
        link.children
            .iter()
            .map(ToString::to_string)
            .collect::<String>(),
        inner
    );
}
fn expected(inner: &str, destination: &str, source: &str) -> futo_notes_editor::LinkDescription {
    raw_library_link(inner, destination);
    let standard = EditorSession::open(source);
    assert_eq!(standard.display_text(), format!("<{inner}> "));
    let link = standard
        .inspect_link(Revision(0), range(1, 2))
        .unwrap()
        .unwrap();
    assert_eq!(link.range, range(1, inner.len() + 1));
    assert_eq!(link.destination, destination);
    link
}

#[test]
fn uppercase_www_bare_source_uses_the_canonical_raw_parser_extent_and_meaning() {
    let inner = "WWW.x.test/path";
    raw_library_link(inner, "http://WWW.x.test/path");
    let loaded = EditorSession::open(inner);
    assert_eq!(loaded.display_text(), inner);
    let link = loaded
        .inspect_link(Revision(0), range(0, 1))
        .unwrap()
        .expect("a cheap trigger must not suppress a maintained-parser URI");
    assert_eq!(link.range, range(0, inner.len()));
    assert_eq!(link.destination, "http://WWW.x.test/path");
}

#[test]
fn uppercase_www_character_input_keeps_case_and_ends_its_actual_angle_word() {
    let inner = "WWW.x.test/path";
    let target = expected(
        inner,
        "http://WWW.x.test/path",
        "<[WWW.x.test/path](<http://WWW.x.test/path>)> ",
    );
    let mut editor = EditorSession::open("");
    for ch in format!("<{inner}>").chars() {
        let at = editor.display_text().len();
        editor
            .replace(
                editor.revision(),
                range(at, at),
                &ch.to_string(),
                &mut |_| Ok(()),
            )
            .unwrap();
        assert!(editor
            .project(editor.revision(), range(0, at + ch.len_utf8()))
            .unwrap()
            .links
            .is_empty());
    }
    let before = editor.source_text();
    let at = inner.len() + 2;
    editor.select(editor.revision(), range(0, 0)).unwrap();
    editor.select(editor.revision(), range(at, at)).unwrap();
    editor
        .replace(editor.revision(), range(at, at), " ", &mut |_| Ok(()))
        .unwrap();
    let linked = editor.inspect_link(editor.revision(), range(1, 2)).unwrap();
    assert_eq!(
        linked,
        Some(target.clone()),
        "source={:?}",
        editor.source_text()
    );
    let saved = editor.source_text();
    editor
        .undo(editor.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(editor.source_text(), before);
    editor
        .redo(editor.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(editor.source_text(), saved);
    let fresh = EditorSession::open(&saved);
    assert_eq!(
        fresh.inspect_link(Revision(0), range(1, 2)).unwrap(),
        Some(target)
    );
}

#[test]
fn completed_https_paste_keeps_literal_angles_and_clean_case_preserving_href() {
    let inner = "HTTPS://x.test/path";
    let target = expected(inner, inner, "<<HTTPS://x.test/path>> ");
    let bare = EditorSession::open(inner);
    assert_eq!(
        bare.inspect_link(Revision(0), range(0, 1))
            .unwrap()
            .unwrap()
            .destination,
        inner
    );
    let text = format!("<{inner}> ");
    let mut editor = EditorSession::open("");
    let mut accepted = 0;
    editor
        .replace_action(
            Revision(0),
            range(0, 0),
            &text,
            InputAction::Isolated,
            &mut |_| {
                accepted += 1;
                Ok(())
            },
        )
        .unwrap_or_else(|error| {
            panic!("completed paste must accept; accepted={accepted}; error={error:?}")
        });
    assert_eq!(accepted, 1);
    assert_eq!(editor.display_text(), text);
    assert_eq!(
        editor.inspect_link(Revision(1), range(1, 2)).unwrap(),
        Some(target.clone()),
        "source={:?}",
        editor.source_text()
    );
    let saved = editor.source_text();
    let fresh = EditorSession::open(&saved);
    assert_eq!(fresh.display_text(), text);
    assert_eq!(
        fresh.inspect_link(Revision(0), range(1, 2)).unwrap(),
        Some(target)
    );
    editor.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(editor.source_text(), "");
    editor.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(editor.source_text(), saved);
}
