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

#[test]
fn mixed_case_www_has_live_timing_only_from_actual_input_not_loaded_explicit_source() {
    let inner = "WwW.x.test/PaTh";
    let source = "<[WwW.x.test/PaTh](<http://WwW.x.test/PaTh>)> ";
    let target = expected(inner, "http://WwW.x.test/PaTh", source);
    let loaded = EditorSession::open(source.trim_end());
    assert_eq!(
        loaded.inspect_link(Revision(0), range(1, 2)).unwrap(),
        Some(target.clone())
    );
    let mut typed = EditorSession::open("");
    for ch in format!("<{inner}>").chars() {
        let at = typed.display_text().len();
        typed
            .replace(
                typed.revision(),
                range(at, at),
                &ch.to_string(),
                &mut |_| Ok(()),
            )
            .unwrap();
        assert!(typed
            .project(typed.revision(), range(0, at + ch.len_utf8()))
            .unwrap()
            .links
            .is_empty());
    }
    let fresh = EditorSession::open(&typed.source_text());
    assert_eq!(
        fresh.inspect_link(Revision(0), range(1, 2)).unwrap(),
        Some(target.clone())
    );
    let at = typed.display_text().len();
    typed
        .replace(typed.revision(), range(at, at), " ", &mut |_| Ok(()))
        .unwrap();
    assert_eq!(
        typed.inspect_link(typed.revision(), range(1, 2)).unwrap(),
        Some(target)
    );
}

#[test]
fn completed_marked_https_input_uses_the_same_clean_committed_capsule() {
    let inner = "HTTPS://x.test/PaTh";
    let target = expected(inner, inner, "<<HTTPS://x.test/PaTh>> ");
    let text = "<HTTPS://x.test/PaTh> ";
    let mut editor = EditorSession::open("");
    editor.compose(Revision(0), range(0, 0), text).unwrap();
    assert_eq!(editor.source_text(), "");
    let mut accepted = 0;
    let change = editor
        .commit_composition(Revision(0), None, &mut |_| {
            accepted += 1;
            Ok(())
        })
        .unwrap()
        .unwrap();
    assert_eq!(accepted, 1);
    assert_eq!(change.selection, range(text.len(), text.len()));
    assert!(editor.composition().is_none());
    assert_eq!(editor.display_text(), text);
    assert_eq!(
        editor.inspect_link(Revision(1), range(1, 2)).unwrap(),
        Some(target.clone())
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

fn paragraph_word_end(
    text: &str,
    inner: &str,
    destination: &str,
    source: &str,
    key: futo_notes_editor::ParagraphKey,
) {
    raw_library_link(inner, destination);
    let standard = EditorSession::open(source);
    let shown = format!("{text}\n");
    assert_eq!(standard.display_text(), shown);
    let expected = standard
        .inspect_link(Revision(0), range(1, 2))
        .unwrap()
        .unwrap();
    assert_eq!(expected.range, range(1, inner.len() + 1));
    assert_eq!(expected.destination, destination);
    let mut editor = EditorSession::open("");
    for ch in text.chars() {
        let at = editor.display_text().len();
        editor
            .replace(
                editor.revision(),
                range(at, at),
                &ch.to_string(),
                &mut |_| Ok(()),
            )
            .unwrap();
    }
    assert!(editor
        .inspect_link(editor.revision(), range(1, 2))
        .unwrap()
        .is_none());
    let original = editor.source_text();
    editor.select(editor.revision(), range(0, 0)).unwrap();
    editor
        .select(editor.revision(), range(text.len(), text.len()))
        .unwrap();
    let mut accepted = 0;
    let change = editor
        .paragraph_key(
            editor.revision(),
            range(text.len(), text.len()),
            key,
            &mut |_| {
                accepted += 1;
                Ok(())
            },
        )
        .unwrap()
        .unwrap();
    assert_eq!(accepted, 1);
    assert_eq!(change.selection, range(shown.len(), shown.len()));
    assert_eq!(editor.display_text(), shown);
    assert_eq!(
        editor.inspect_link(editor.revision(), range(1, 2)).unwrap(),
        Some(expected.clone()),
        "actualsource={:?}",
        editor.source_text()
    );
    let saved = editor.source_text();
    let fresh = EditorSession::open(&saved);
    assert_eq!(fresh.display_text(), shown);
    assert_eq!(
        fresh.inspect_link(Revision(0), range(1, 2)).unwrap(),
        Some(expected)
    );
    editor
        .undo(editor.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(editor.source_text(), original);
    assert!(editor
        .inspect_link(editor.revision(), range(1, 2))
        .unwrap()
        .is_none());
    editor
        .redo(editor.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(editor.source_text(), saved);
}

#[test]
fn actual_enter_ends_an_unclosed_www_word_without_inventing_a_closer() {
    paragraph_word_end(
        "<www.x.test/path",
        "www.x.test/path",
        "http://www.x.test/path",
        "<[www.x.test/path](<http://www.x.test/path>)\n",
        futo_notes_editor::ParagraphKey::Enter,
    );
}
#[test]
fn actual_shift_enter_ends_a_closed_http_word_as_one_lf() {
    paragraph_word_end(
        "<https://x.test/path>",
        "https://x.test/path",
        "https://x.test/path",
        "<<https://x.test/path>>\n",
        futo_notes_editor::ParagraphKey::ShiftEnter,
    );
}

#[test]
fn completed_http_marked_input_ending_in_lf_keeps_clean_canonical_meaning() {
    let inner = "HTTPS://x.test/PaTh";
    raw_library_link(inner, inner);
    let text = "<HTTPS://x.test/PaTh>\n";
    let standard = EditorSession::open("<<HTTPS://x.test/PaTh>>\n");
    assert_eq!(standard.display_text(), text);
    let expected = standard
        .inspect_link(Revision(0), range(1, 2))
        .unwrap()
        .unwrap();
    assert_eq!(expected.range, range(1, 20));
    assert_eq!(expected.destination, inner);
    let mut editor = EditorSession::open("");
    editor.compose(Revision(0), range(0, 0), text).unwrap();
    assert_eq!(editor.source_text(), "");
    let mut accepted = 0;
    let change = editor
        .commit_composition(Revision(0), None, &mut |_| {
            accepted += 1;
            Ok(())
        })
        .unwrap()
        .unwrap();
    assert_eq!(accepted, 1);
    assert_eq!(change.selection, range(text.len(), text.len()));
    assert_eq!(editor.display_text(), text);
    assert_eq!(
        editor.inspect_link(Revision(1), range(1, 2)).unwrap(),
        Some(expected.clone()),
        "source={:?}",
        editor.source_text()
    );
    let saved = editor.source_text();
    let fresh = EditorSession::open(&saved);
    assert_eq!(fresh.display_text(), text);
    assert_eq!(
        fresh.inspect_link(Revision(0), range(1, 2)).unwrap(),
        Some(expected)
    );
    editor.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(editor.source_text(), "");
    editor.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(editor.source_text(), saved);
}

#[test]
fn completed_committed_word_uses_the_actual_single_tab_or_unicode_separator() {
    let inner = "HTTPS://x.test/PaTh";
    raw_library_link(inner, inner);
    for separator in ["\t", "\u{a0}"] {
        let text = format!("<{inner}>{separator}");
        let standard = EditorSession::open(&format!("<<{inner}>>{separator}"));
        assert_eq!(standard.display_text(), text);
        let expected = standard
            .inspect_link(Revision(0), range(1, 2))
            .unwrap()
            .unwrap();
        assert_eq!(expected.destination, inner);
        assert_eq!(expected.range, range(1, inner.len() + 1));
        let mut editor = EditorSession::open("");
        editor.compose(Revision(0), range(0, 0), &text).unwrap();
        let mut accepted = 0;
        let change = editor
            .commit_composition(Revision(0), None, &mut |_| {
                accepted += 1;
                Ok(())
            })
            .unwrap()
            .unwrap();
        assert_eq!(accepted, 1);
        assert_eq!(change.selection, range(text.len(), text.len()));
        assert_eq!(editor.display_text(), text);
        assert_eq!(
            editor.inspect_link(Revision(1), range(1, 2)).unwrap(),
            Some(expected.clone()),
            "separator={separator:?}; source={:?}",
            editor.source_text()
        );
        let saved = editor.source_text();
        let fresh = EditorSession::open(&saved);
        assert_eq!(fresh.display_text(), text);
        assert_eq!(
            fresh.inspect_link(Revision(0), range(1, 2)).unwrap(),
            Some(expected)
        );
        editor.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap();
        assert_eq!(editor.source_text(), "");
        editor.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap();
        assert_eq!(editor.source_text(), saved);
    }
}

#[test]
fn committed_multiple_separators_do_not_trim_back_into_a_completed_capsule() {
    let inner = "HTTPS://x.test/PaTh";
    for separator in ["\r\n", "  "] {
        let text = format!("<{inner}>{separator}");
        let literal = format!("\\<HTTPS\\://x.test/PaTh\\>{separator}");
        let standard = EditorSession::open(&literal);
        assert_eq!(standard.display_text(), text);
        assert!(standard
            .project(Revision(0), range(0, text.len()))
            .unwrap()
            .links
            .is_empty());
        let mut editor = EditorSession::open("");
        editor.compose(Revision(0), range(0, 0), &text).unwrap();
        editor
            .commit_composition(Revision(0), None, &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(editor.display_text(), text);
        assert!(
            editor
                .project(Revision(1), range(0, text.len()))
                .unwrap()
                .links
                .is_empty(),
            "multiple ending={separator:?}; source={:?}",
            editor.source_text()
        );
        let saved = editor.source_text();
        let fresh = EditorSession::open(&saved);
        assert_eq!(fresh.display_text(), text);
        assert!(fresh
            .project(Revision(0), range(0, text.len()))
            .unwrap()
            .links
            .is_empty());
        editor.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap();
        assert_eq!(editor.source_text(), "");
        editor.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap();
        assert_eq!(editor.source_text(), saved);
    }
}
