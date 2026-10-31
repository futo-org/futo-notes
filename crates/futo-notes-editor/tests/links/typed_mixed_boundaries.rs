//! Public layout/lifetime boundaries, with shipping intent and canonical source.
use super::*;
const PREFIX: &str = "<www.x.test/";
#[derive(Clone, Copy)]
enum Exit {
    Unfinished,
    Ordinary,
    TwoSpaces,
    NonterminalCloser,
}
fn boundary(exit: Exit) {
    let inserted = match exit {
        Exit::Unfinished => "prefix <www.x.test/path",
        Exit::Ordinary => "prefix ordinary ",
        Exit::TwoSpaces => "prefix <www.x.test/path>  ",
        Exit::NonterminalCloser => "prefix <www.x.test/path>x",
    };
    let before_text = format!("{PREFIX}{inserted}");
    let plain = EditorSession::open(&before_text);
    assert_eq!(plain.display_text(), before_text);
    assert!(plain
        .project(Revision(0), range(0, before_text.len()))
        .unwrap()
        .links
        .is_empty());
    let suffix = if matches!(exit, Exit::NonterminalCloser) {
        ">x"
    } else {
        ""
    };
    let bare_word = format!("www.x.test/path{suffix}");
    let bare = EditorSession::open(&bare_word);
    let full = bare
        .inspect_link(Revision(0), range(0, 1))
        .unwrap()
        .unwrap();
    assert_eq!(full.range, range(0, bare_word.len()));
    assert_eq!(full.destination, format!("http://{bare_word}"));
    let destination_source = if matches!(exit, Exit::NonterminalCloser) {
        r"http://www.x.test/path\>x"
    } else {
        "http://www.x.test/path"
    };
    let candidate = format!("{PREFIX}prefix <[{bare_word}](<{destination_source}>) ");
    let canonical = EditorSession::open(&candidate);
    let target = canonical
        .inspect_link(Revision(0), range(PREFIX.len() + 8, PREFIX.len() + 9))
        .unwrap()
        .unwrap();
    assert_eq!(target.destination, full.destination);
    assert_eq!(
        target.range,
        range(PREFIX.len() + 8, PREFIX.len() + 8 + bare_word.len())
    );
    let mut editor = EditorSession::open("");
    editor
        .replace(Revision(0), range(0, 0), PREFIX, &mut |_| Ok(()))
        .unwrap();
    let mut accepts = 0;
    editor
        .replace(
            Revision(1),
            range(PREFIX.len(), PREFIX.len()),
            inserted,
            &mut |_| {
                accepts += 1;
                Ok(())
            },
        )
        .unwrap();
    assert_eq!(accepts, 1);
    assert_eq!(editor.display_text(), before_text);
    assert!(editor
        .project(Revision(2), range(0, before_text.len()))
        .unwrap()
        .links
        .is_empty());
    let before_source = editor.source_text();
    let fresh = EditorSession::open(&before_source);
    assert_eq!(fresh.display_text(), before_text);
    // A nonterminal >x must not be mistaken for completed angle syntax.
    assert!(fresh
        .project(Revision(0), range(0, before_text.len()))
        .unwrap()
        .links
        .is_empty());
    if matches!(exit, Exit::Ordinary) {
        // Consume the retired OLD boundary, rather than merely observing the
        // distant final caret. Equal loaded bytes have no old identity there.
        let mut loaded = EditorSession::open(&before_source);
        for (index, input) in [">", " "].into_iter().enumerate() {
            let at = PREFIX.len() + index;
            editor.select(editor.revision(), range(0, 0)).unwrap();
            editor.select(editor.revision(), range(at, at)).unwrap();
            editor
                .replace(editor.revision(), range(at, at), input, &mut |_| Ok(()))
                .unwrap();
            loaded
                .replace(loaded.revision(), range(at, at), input, &mut |_| Ok(()))
                .unwrap();
            assert_eq!(editor.source_text(), loaded.source_text());
            assert_eq!(editor.display_text(), loaded.display_text());
            assert!(editor
                .project(editor.revision(), range(0, editor.display_text().len()))
                .unwrap()
                .links
                .is_empty());
        }
        return;
    }
    editor.select(Revision(2), range(0, 0)).unwrap();
    editor
        .select(Revision(2), range(before_text.len(), before_text.len()))
        .unwrap();
    editor
        .replace(
            Revision(2),
            range(before_text.len(), before_text.len()),
            " ",
            &mut |_| Ok(()),
        )
        .unwrap();
    let shown = format!("{before_text} ");
    assert_eq!(editor.display_text(), shown);
    let expected = if matches!(exit, Exit::TwoSpaces) {
        Vec::new()
    } else {
        vec![target]
    };
    assert_eq!(
        editor
            .project(Revision(3), range(0, shown.len()))
            .unwrap()
            .links,
        expected
    );
    let after_source = editor.source_text();
    let fresh = EditorSession::open(&after_source);
    assert_eq!(fresh.display_text(), shown);
    assert_eq!(
        fresh
            .project(Revision(0), range(0, shown.len()))
            .unwrap()
            .links,
        expected
    );
    editor.undo(Revision(3), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(editor.source_text(), before_source);
    editor.undo(Revision(4), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(editor.source_text(), PREFIX);
    editor.redo(Revision(5), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(editor.source_text(), before_source);
    editor.redo(Revision(6), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(editor.source_text(), after_source);
    assert_eq!(
        editor
            .project(Revision(7), range(0, shown.len()))
            .unwrap()
            .links,
        expected
    );
}
#[test]
fn mixed_unfinished_last_seed_remains_owned_until_a_real_word_end() {
    boundary(Exit::Unfinished);
}
#[test]
fn mixed_ordinary_last_word_retires_the_old_boundary_identity() {
    boundary(Exit::Ordinary);
}
#[test]
fn two_trailing_spaces_do_not_trim_back_to_an_earlier_angle_word() {
    boundary(Exit::TwoSpaces);
}
#[test]
fn nonterminal_closer_remains_uri_data_until_the_actual_word_ends() {
    boundary(Exit::NonterminalCloser);
}
