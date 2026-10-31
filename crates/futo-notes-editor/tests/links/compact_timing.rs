//! Compact delimiter and action representatives from the shipping public oracle.
use super::*;
use futo_notes_editor::{InlineFormat, InputAction};

#[test]
fn uppercase_www_delimiter_waits_for_the_actual_word_ending() {
    let pending = "x \\*b WWW.x.test/a*";
    let complete = "x *b WWW.x.test/a* ";
    let canonical = EditorSession::open(complete);
    assert_eq!(canonical.display_text(), "x b WWW.x.test/a ");
    let linked = canonical
        .inspect_link(Revision(0), range(4, 5))
        .unwrap()
        .unwrap();
    assert_eq!(linked.range, range(4, 16));
    assert_eq!(linked.destination, "http://WWW.x.test/a");
    assert_eq!(
        EditorSession::open(pending).display_text(),
        "x *b WWW.x.test/a*"
    );

    let mut editor = EditorSession::open("");
    let mut view = ReferenceView::new("");
    let mut typed = String::new();
    for ch in "x *b WWW.x.test/a*".chars() {
        let at = view.text.len();
        typed.push(ch);
        view.apply(
            editor
                .replace(
                    editor.revision(),
                    range(at, at),
                    &ch.to_string(),
                    &mut |_| Ok(()),
                )
                .unwrap(),
        );
        assert_eq!(view.text, typed, "source={:?}", editor.source_text());
        let projected = editor
            .project(editor.revision(), range(0, typed.len()))
            .unwrap();
        assert!(projected.links.is_empty());
        assert!(projected.runs.iter().all(|run| run.formats.is_empty()));
    }
    assert_eq!(editor.source_text(), pending);
    let at = view.text.len();
    editor.select(editor.revision(), range(0, 0)).unwrap();
    editor.select(editor.revision(), range(at, at)).unwrap();
    view.apply(
        editor
            .replace(editor.revision(), range(at, at), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(editor.source_text(), complete);
    assert_eq!(view.text, canonical.display_text());
    assert_eq!(
        editor.inspect_link(editor.revision(), range(4, 5)).unwrap(),
        Some(linked.clone())
    );
    view.apply(
        editor
            .undo(editor.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(editor.source_text(), pending);
    assert_eq!(view.text, "x *b WWW.x.test/a*");
    assert!(editor
        .inspect_link(editor.revision(), range(5, 6))
        .unwrap()
        .is_none());
    view.apply(
        editor
            .redo(editor.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(editor.source_text(), complete);
    assert_eq!(view.text, "x b WWW.x.test/a ");
    assert_eq!(
        EditorSession::open(&editor.source_text())
            .inspect_link(Revision(0), range(4, 5))
            .unwrap(),
        Some(linked)
    );
}

#[test]
fn underscore_ownership_survives_a_source_shift_and_uri_continuation_before_word_end() {
    let final_source = "p x _b https://x.test/a_b_ ";
    let fresh = EditorSession::open(final_source);
    assert_eq!(fresh.display_text(), "p x b https://x.test/a_b ");
    assert_eq!(
        fresh
            .inspect_link(Revision(0), range(6, 7))
            .unwrap()
            .unwrap()
            .destination,
        "https://x.test/a_b"
    );
    let mut editor = EditorSession::open("");
    let mut view = ReferenceView::new("");
    for ch in "x _b https://x.test/a_".chars() {
        let at = view.text.len();
        view.apply(
            editor
                .replace(
                    editor.revision(),
                    range(at, at),
                    &ch.to_string(),
                    &mut |_| Ok(()),
                )
                .unwrap(),
        );
        let pending = editor
            .project(editor.revision(), range(0, view.text.len()))
            .unwrap();
        assert!(pending.links.is_empty());
        assert!(pending.runs.iter().all(|run| run.formats.is_empty()));
    }
    // An isolated edit before the owned opener shifts source coordinates;
    // it does not authorize or end the distant URI word.
    view.apply(
        editor
            .replace_action(
                editor.revision(),
                range(0, 0),
                "p ",
                InputAction::Isolated,
                &mut |_| Ok(()),
            )
            .unwrap(),
    );
    assert_eq!(view.text, "p x _b https://x.test/a_");
    let end = view.text.len();
    editor.select(editor.revision(), range(end, end)).unwrap();
    view.apply(
        editor
            .replace(editor.revision(), range(end, end), "b_", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "p x _b https://x.test/a_b_");
    let pending_source = editor.source_text();
    assert_eq!(
        EditorSession::open(&pending_source).display_text(),
        view.text
    );
    let end = view.text.len();
    editor.select(editor.revision(), range(0, 0)).unwrap();
    editor.select(editor.revision(), range(end, end)).unwrap();
    view.apply(
        editor
            .replace(editor.revision(), range(end, end), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "p x b https://x.test/a_b ");
    assert_eq!(editor.source_text(), final_source);
    let styled = editor
        .project(editor.revision(), range(0, view.text.len()))
        .unwrap();
    let italic: String = styled
        .runs
        .iter()
        .filter(|run| run.formats.contains(&InlineFormat::Italic))
        .map(|run| &view.text[run.range.start.0..run.range.end.0])
        .collect();
    assert_eq!(italic, "b https://x.test/a_b");
    assert_eq!(styled.links.len(), 1);
    assert_eq!(styled.links[0].range, range(6, 24));
    assert_eq!(styled.links[0].destination, "https://x.test/a_b");
    view.apply(
        editor
            .undo(editor.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(editor.source_text(), pending_source);
    assert_eq!(view.text, "p x _b https://x.test/a_b_");
    assert!(editor
        .project(editor.revision(), range(0, view.text.len()))
        .unwrap()
        .links
        .is_empty());
    view.apply(
        editor
            .redo(editor.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(editor.source_text(), final_source);
    assert_eq!(view.text, "p x b https://x.test/a_b ");
}

#[test]
fn strike_url_closers_stay_literal_until_word_end_and_roundtrip_exactly() {
    let expected = "x ~~b https://x.test/a~~ ";
    let fresh = EditorSession::open(expected);
    assert_eq!(fresh.display_text(), "x b https://x.test/a ");
    let mut editor = EditorSession::open("");
    let mut view = ReferenceView::new("");
    for ch in "x ~~b https://x.test/a~~".chars() {
        let at = view.text.len();
        view.apply(
            editor
                .replace(
                    editor.revision(),
                    range(at, at),
                    &ch.to_string(),
                    &mut |_| Ok(()),
                )
                .unwrap(),
        );
        let pending = editor
            .project(editor.revision(), range(0, view.text.len()))
            .unwrap();
        assert!(pending.links.is_empty());
        assert!(pending.runs.iter().all(|run| run.formats.is_empty()));
    }
    assert_eq!(view.text, "x ~~b https://x.test/a~~");
    let pending = editor.source_text();
    assert_eq!(EditorSession::open(&pending).display_text(), view.text);
    let end = view.text.len();
    editor.select(editor.revision(), range(0, 0)).unwrap();
    editor.select(editor.revision(), range(end, end)).unwrap();
    view.apply(
        editor
            .replace(editor.revision(), range(end, end), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "x b https://x.test/a ");
    assert_eq!(editor.source_text(), expected);
    let styled = editor
        .project(editor.revision(), range(0, view.text.len()))
        .unwrap();
    let strike: String = styled
        .runs
        .iter()
        .filter(|run| run.formats.contains(&InlineFormat::Strike))
        .map(|run| &view.text[run.range.start.0..run.range.end.0])
        .collect();
    assert_eq!(strike, "b https://x.test/a");
    assert_eq!(styled.links.len(), 1);
    assert_eq!(styled.links[0].range, range(4, 20));
    assert_eq!(styled.links[0].destination, "https://x.test/a");
    view.apply(
        editor
            .undo(editor.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(editor.source_text(), pending);
    assert_eq!(view.text, "x ~~b https://x.test/a~~");
    assert!(editor
        .project(editor.revision(), range(0, view.text.len()))
        .unwrap()
        .links
        .is_empty());
    view.apply(
        editor
            .redo(editor.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(editor.source_text(), expected);
}

#[test]
fn a_partial_www_word_end_links_its_canonical_prefix_and_keeps_the_period_literal() {
    let candidate = "<[www.x.test/[[Old]]/path](<http://www.x.test/[[Old]]/path>). ";
    let fresh = EditorSession::open(candidate);
    assert_eq!(fresh.display_text(), "<www.x.test/[[Old]]/path. ");
    let expected_link = fresh
        .inspect_link(Revision(0), range(1, 2))
        .unwrap()
        .unwrap();
    assert_eq!(expected_link.range, range(1, 24));
    assert_eq!(expected_link.destination, "http://www.x.test/[[Old]]/path");
    let mut editor = EditorSession::open("");
    let mut view = ReferenceView::new("");
    view.apply(
        editor
            .replace(
                Revision(0),
                range(0, 0),
                "<www.x.test/[[Old]]/path.",
                &mut |_| Ok(()),
            )
            .unwrap(),
    );
    assert_eq!(view.text, "<www.x.test/[[Old]]/path.");
    let pending = editor.source_text();
    assert!(editor
        .project(Revision(1), range(0, 25))
        .unwrap()
        .links
        .is_empty());
    editor.select(Revision(1), range(0, 0)).unwrap();
    editor.select(Revision(1), range(25, 25)).unwrap();
    view.apply(editor.replace(Revision(1), range(25,25), " ", &mut |_| Ok(())).expect("the actual typed candidate must end with its canonical prefix linked and punctuation literal"));
    assert_eq!(view.text, "<www.x.test/[[Old]]/path. ");
    let linked = editor
        .inspect_link(Revision(2), range(1, 2))
        .unwrap()
        .unwrap();
    assert_eq!(linked.range, expected_link.range);
    assert_eq!(linked.destination, expected_link.destination);
    let reopened = EditorSession::open(&editor.source_text());
    assert_eq!(reopened.display_text(), view.text);
    assert_eq!(
        reopened
            .inspect_link(Revision(0), range(1, 2))
            .unwrap()
            .unwrap()
            .destination,
        expected_link.destination
    );
    view.apply(editor.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(editor.source_text(), pending);
    assert_eq!(view.text, "<www.x.test/[[Old]]/path.");
    assert!(editor
        .project(Revision(3), range(0, 25))
        .unwrap()
        .links
        .is_empty());
    view.apply(editor.redo(Revision(3), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(view.text, "<www.x.test/[[Old]]/path. ");
}

#[test]
fn a_typed_closer_preserves_partial_uri_punctuation_and_waits_for_word_end() {
    let candidate = "<[www.x.test/[[Old]]/path](<http://www.x.test/[[Old]]/path>).>";
    let fresh = EditorSession::open(candidate);
    assert_eq!(fresh.display_text(), "<www.x.test/[[Old]]/path.>");
    let loaded_link = fresh
        .inspect_link(Revision(0), range(1, 2))
        .unwrap()
        .unwrap();
    assert_eq!(loaded_link.range, range(1, 24));
    assert_eq!(loaded_link.destination, "http://www.x.test/[[Old]]/path");
    let mut editor = EditorSession::open("");
    let mut view = ReferenceView::new("");
    view.apply(
        editor
            .replace(
                Revision(0),
                range(0, 0),
                "<www.x.test/[[Old]]/path.",
                &mut |_| Ok(()),
            )
            .unwrap(),
    );
    view.apply(editor.replace(Revision(1), range(25,25), ">", &mut |_| Ok(())).expect("a real typed closer must hand off only the canonical URI prefix and preserve the period"));
    assert_eq!(view.text, "<www.x.test/[[Old]]/path.>");
    let pending = editor.source_text();
    assert!(editor
        .project(Revision(2), range(0, 26))
        .unwrap()
        .links
        .is_empty());
    let before_reopen = EditorSession::open(&pending);
    assert_eq!(before_reopen.display_text(), view.text);
    assert_eq!(
        before_reopen
            .inspect_link(Revision(0), range(1, 2))
            .unwrap()
            .unwrap()
            .destination,
        loaded_link.destination
    );
    editor.select(Revision(2), range(0, 0)).unwrap();
    editor.select(Revision(2), range(26, 26)).unwrap();
    view.apply(
        editor
            .replace(Revision(2), range(26, 26), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "<www.x.test/[[Old]]/path.> ");
    let linked = editor
        .inspect_link(Revision(3), range(1, 2))
        .unwrap()
        .unwrap();
    assert_eq!(linked.range, loaded_link.range);
    assert_eq!(linked.destination, loaded_link.destination);
    view.apply(editor.undo(Revision(3), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(editor.source_text(), pending);
    assert!(editor
        .project(Revision(4), range(0, 26))
        .unwrap()
        .links
        .is_empty());
    view.apply(editor.undo(Revision(4), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(editor.source_text(), "<www.x.test/[[Old]]/path.");
    assert_eq!(view.text, "<www.x.test/[[Old]]/path.");
    view.apply(editor.redo(Revision(5), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(editor.source_text(), pending);
    assert!(editor
        .project(Revision(6), range(0, 26))
        .unwrap()
        .links
        .is_empty());
    view.apply(editor.redo(Revision(6), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(view.text, "<www.x.test/[[Old]]/path.> ");
    assert_eq!(
        editor
            .inspect_link(Revision(7), range(1, 2))
            .unwrap()
            .unwrap()
            .destination,
        loaded_link.destination
    );
}

#[test]
fn a_typed_http_partial_closer_saves_a_clean_prefix_href_before_word_end() {
    let candidate = "<<https://x.test/a>.>";
    let canonical = EditorSession::open(candidate);
    assert_eq!(canonical.display_text(), "<https://x.test/a.>");
    let expected = canonical
        .inspect_link(Revision(0), range(1, 2))
        .unwrap()
        .unwrap();
    assert_eq!(expected.range, range(1, 17));
    assert_eq!(expected.destination, "https://x.test/a");
    let mut editor = EditorSession::open("");
    let mut view = ReferenceView::new("");
    view.apply(
        editor
            .replace(Revision(0), range(0, 0), "<https://x.test/a.", &mut |_| {
                Ok(())
            })
            .unwrap(),
    );
    assert_eq!(view.text, "<https://x.test/a.");
    assert!(editor
        .project(Revision(1), range(0, 18))
        .unwrap()
        .links
        .is_empty());
    editor.select(Revision(1), range(0, 0)).unwrap();
    editor.select(Revision(1), range(18, 18)).unwrap();
    view.apply(
        editor
            .replace(Revision(1), range(18, 18), ">", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "<https://x.test/a.>");
    assert!(editor
        .project(Revision(2), range(0, 19))
        .unwrap()
        .links
        .is_empty());
    let pending_source = editor.source_text();
    let reopened = EditorSession::open(&pending_source);
    assert_eq!(reopened.display_text(), view.text);
    let loaded = reopened
        .inspect_link(Revision(0), range(1, 2))
        .unwrap()
        .unwrap();
    assert_eq!(
        loaded.range, expected.range,
        "pending source={pending_source:?}"
    );
    assert_eq!(
        loaded.destination, expected.destination,
        "pending source={pending_source:?}"
    );
    editor.select(Revision(2), range(0, 0)).unwrap();
    editor.select(Revision(2), range(19, 19)).unwrap();
    view.apply(
        editor
            .replace(Revision(2), range(19, 19), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "<https://x.test/a.> ");
    let active = editor
        .inspect_link(Revision(3), range(1, 2))
        .unwrap()
        .unwrap();
    assert_eq!(active.range, expected.range);
    assert_eq!(active.destination, expected.destination);
    view.apply(editor.undo(Revision(3), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(editor.source_text(), pending_source);
    assert!(editor
        .project(Revision(4), range(0, 19))
        .unwrap()
        .links
        .is_empty());
    view.apply(editor.redo(Revision(4), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(view.text, "<https://x.test/a.> ");
    assert_eq!(
        editor
            .inspect_link(Revision(5), range(1, 2))
            .unwrap()
            .unwrap()
            .destination,
        expected.destination
    );
}
