//! The command shape, the guard and the escape rule.
use super::super::command::{kept_line, Command, Edit};
use super::super::Engine;
use super::{ok, range};
use crate::lines::{Carry, Kind};
use crate::{DisplayRange, InputAction};

/// Run a command replacing line `index`'s text (without its ending) with
/// `text`, naming `named` lines; returns whether it changed the note.
fn retext(engine: &mut Engine, index: usize, text: &str, named: std::ops::Range<usize>) -> bool {
    let start = engine.line_start(index);
    let end = start + engine.line(index).body_len();
    let command = Command::new(
        vec![Edit::new(start..end, text)],
        named,
        start + text.len()..start + text.len(),
    );
    engine
        .run(engine.revision(), |_| Ok(Some(command)), &mut ok)
        .unwrap()
        .is_some()
}

#[test]
fn the_guard_cancels_a_command_that_changes_a_line_it_does_not_name() {
    for (source, index, text) in [
        // A delimiter row would make the line above a table header.
        ("a\n| x |\nb", 2, "|---|"),
        // An opening fence would make every later line code.
        ("a\nb\nc", 0, "```"),
        // A closing `---` would make line 1 open front matter.
        ("---\na\nb", 2, "---"),
        // A table header that stops being one leaves its rows plain.
        ("| x |\n|---|\n| 1 |\nz", 1, "plain"),
    ] {
        let mut engine = Engine::open(source);
        let before = engine.selection();
        assert!(
            !retext(&mut engine, index, text, index..index + 1),
            "{source:?}"
        );
        assert_eq!(engine.source_text(), source);
        assert_eq!(engine.selection(), before);
        assert!(
            !engine.can_undo(),
            "{source:?}: a cancelled command leaves no history"
        );
    }
}

#[test]
fn a_command_may_change_the_lines_it_names() {
    let mut engine = Engine::open("a\nb\nc");
    assert!(retext(&mut engine, 0, "```", 0..3));
    assert_eq!(engine.source_text(), "```\nb\nc");
    let mut engine = Engine::open("a\n| x |\nb");
    assert!(retext(&mut engine, 2, "|---|", 1..3));
    assert_eq!(engine.source_text(), "a\n| x |\n|---|");
}

#[test]
fn undo_restores_the_bytes_and_selection_a_command_changed() {
    let mut engine = Engine::open("one\ntwo\nthree");
    super::select(&mut engine, 5, 5, crate::Affinity::Backward);
    let selection = engine.selection();
    assert!(retext(&mut engine, 1, "- two", 1..2));
    assert_eq!(engine.source_text(), "one\n- two\nthree");
    assert_eq!(engine.selection(), range(7, 7));
    engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
    assert_eq!(engine.source_text(), "one\ntwo\nthree");
    assert_eq!(engine.selection(), selection);
    engine.redo(engine.revision(), &mut ok).unwrap().unwrap();
    assert_eq!(engine.source_text(), "one\n- two\nthree");
}

#[test]
fn marked_text_commits_before_a_command_as_its_own_undo_step() {
    let mut engine = Engine::open("ab");
    super::select(&mut engine, 1, 1, crate::Affinity::Backward);
    engine.compose(engine.revision(), range(1, 1), "x").unwrap();
    let change = engine
        .run(
            engine.revision(),
            |engine| {
                assert_eq!(
                    engine.source_text(),
                    "axb",
                    "the command reads the committed text"
                );
                Ok(Some(Command::new(vec![Edit::insert(0, "- ")], 0..1, 5..5)))
            },
            &mut ok,
        )
        .unwrap()
        .unwrap();
    assert_eq!(
        (change.edit.removed.as_str(), change.edit.inserted.as_str()),
        ("a", "- ax")
    );
    assert_eq!(engine.source_text(), "- axb");
    assert!(engine.composition().is_none());
    engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
    assert_eq!(engine.source_text(), "axb");
    engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
    assert_eq!(engine.source_text(), "ab");
}

#[test]
fn a_cancelled_command_still_commits_marked_text() {
    let mut engine = Engine::open("a\n| x |\nb");
    let end = engine.display_len();
    super::select(&mut engine, end, end, crate::Affinity::Backward);
    engine
        .compose(engine.revision(), range(end, end), "c")
        .unwrap();
    let start = engine.line_start(2);
    let change = engine
        .run(
            engine.revision(),
            |_| {
                Ok(Some(Command::new(
                    vec![Edit::new(start..start + 2, "|---|")],
                    2..3,
                    start..start,
                )))
            },
            &mut ok,
        )
        .unwrap()
        .unwrap();
    assert_eq!(change.edit.inserted, "c");
    assert_eq!(engine.source_text(), "a\n| x |\nbc");
}

#[test]
fn typing_is_never_guarded() {
    // A typed delimiter row makes the line above a header: it lands.
    let mut engine = Engine::open("| x |\n");
    let end = engine.display_len();
    engine
        .replace(
            engine.revision(),
            range(end, end),
            "|---|",
            InputAction::Typing,
            &mut ok,
        )
        .unwrap()
        .unwrap();
    assert_eq!(engine.source_text(), "| x |\n|---|");
}

#[test]
fn a_line_keeps_the_block_a_command_intends_with_one_backslash() {
    let carry = Carry::default();
    for (prefix, text, written) in [
        ("", "# todo", "\\# todo"),
        ("", "1. one", "1\\. one"),
        ("", "12) one", "12\\) one"),
        ("", "> quote", "\\> quote"),
        ("", "- [ ] task", "\\- [ ] task"),
        ("", "---", "\\---"),
        ("", "```js", "\\```js"),
        ("", "plain", "plain"),
        ("", "#tag", "#tag"),
        ("  ", "+ x", "  \\+ x"),
        ("> ", "# x", "> \\# x"),
    ] {
        let quote = prefix.matches('>').count();
        let plain = |line: &crate::lines::Line| {
            matches!(line.kind, Kind::Plain { .. }) && line.quote == quote
        };
        assert_eq!(kept_line(&carry, prefix, text, plain), written, "{text:?}");
    }
    // A bullet stays a bullet: nothing to escape.
    let bullet = |line: &crate::lines::Line| matches!(line.kind, Kind::List { .. });
    assert_eq!(kept_line(&carry, "- ", "# todo", bullet), "- # todo");
}

#[test]
fn offsets_map_through_a_commands_edits() {
    let command = Command::new(
        vec![
            Edit::new(2..4, "xyz"),
            Edit::insert(6, "ab"),
            Edit::new(8..8, ""),
        ],
        0..1,
        0..0,
    );
    for (at, after, mapped) in [
        (0, false, 0),
        (2, false, 2),
        (3, false, 2),
        (3, true, 5),
        (4, false, 5),
        (5, false, 6),
        (6, false, 7),
        (6, true, 9),
        (7, false, 10),
    ] {
        assert_eq!(command.map(at, after), mapped, "{at} {after}");
    }
    let _ = DisplayRange::default();
}

#[test]
fn work_counts_do_not_grow_with_the_note() {
    let mut work = Vec::new();
    for count in [20, 20_000] {
        let text = "__word__ rest\r\n\r\n".repeat(count);
        let mut engine = Engine::open(&text);
        let at = (count - 2) * "word rest\r\n\r\n".len() + 2;
        let change = engine
            .input(
                engine.revision(),
                range(at, at),
                "x",
                InputAction::Typing,
                &mut ok,
            )
            .unwrap();
        assert_eq!(change.inserted, "x");
        work.push(change.work);
    }
    assert_eq!(work[0], work[1]);
    let work = work[0];
    assert!(
        work.parsed_source_bytes > 0 && work.parsed_source_bytes < 64,
        "{work:?}"
    );
    assert!(work.materialized_source_bytes < 128, "{work:?}");
    assert!(
        work.link_metadata_items > 0 && work.link_metadata_items < 32,
        "{work:?}"
    );
}

#[test]
fn the_guard_follows_every_unnamed_line_between_many_named_ones() {
    // Name every other line and give each a second line: each unnamed blank
    // line between them moves down by the lines gained above it.
    let lines = 2_000;
    let source = "a\n\n".repeat(lines);
    let command = |engine: &Engine, text: &str| {
        let mut edits = Vec::new();
        let mut named = Vec::new();
        for index in (0..lines * 2).step_by(2) {
            let at = engine.line_start(index) + 1;
            let written = if index == lines { text } else { "\nb" };
            edits.push(Edit::insert(at, written));
            named.push(index..index + 1);
        }
        Command {
            edits,
            lines: named,
            selection: 0..0,
            affinity: None,
            typed: false,
        }
    };
    let mut engine = Engine::open(&source);
    let landed = engine
        .run(
            engine.revision(),
            |engine| Ok(Some(command(engine, "\nb"))),
            &mut ok,
        )
        .unwrap();
    assert!(landed.is_some());
    assert_eq!(engine.source_text(), "a\nb\n\n".repeat(lines));
    // A fence opened halfway turns every unnamed blank line below into code.
    let mut engine = Engine::open(&source);
    let cancelled = engine
        .run(
            engine.revision(),
            |engine| Ok(Some(command(engine, "\n```"))),
            &mut ok,
        )
        .unwrap();
    assert!(cancelled.is_none());
    assert_eq!(engine.source_text(), source);
}

#[test]
fn marked_text_draws_with_the_formats_it_will_commit_with() {
    use crate::InlineFormat::{Bold, Italic};
    // Inside bold, a composed word is bold.
    let mut engine = Engine::open("**ab**");
    super::select(&mut engine, 1, 1, crate::Affinity::Backward);
    assert_eq!(
        engine.marked_runs(range(1, 1), "xy"),
        vec![(0..2, vec![Bold])]
    );
    // Carried formats at the caret win.
    let mut engine = Engine::open("plain");
    super::select(&mut engine, 5, 5, crate::Affinity::Backward);
    engine.formats = Some(vec![Italic]);
    assert_eq!(
        engine.marked_runs(range(5, 5), "x"),
        vec![(0..1, vec![Italic])]
    );
    // Reconverting keeps the shared text's formats; the changed text takes
    // the formats of what it replaces.
    let engine = Engine::open("a **bc** d");
    assert_eq!(
        engine.marked_runs(range(2, 4), "bX"),
        vec![(0..1, vec![Bold]), (1..2, vec![Bold])]
    );
    assert_eq!(engine.marked_runs(range(0, 1), "z"), vec![]);
}

#[test]
fn an_edit_never_leaves_the_caret_pinned_inside_hidden_syntax() {
    // Typing `)` closes a link around text typed earlier: the caret, last
    // at the end of `[l](x`, would sit inside the now hidden destination.
    let mut engine = Engine::open("[l](x");
    let at = engine.source_len();
    engine
        .edit_source(
            engine.revision(),
            crate::SourceRange {
                start: crate::SourceOffset(at),
                end: crate::SourceOffset(at),
            },
            ")",
            &mut ok,
        )
        .unwrap()
        .unwrap();
    // Put the caret back inside the destination, as an edit could.
    engine.caret_at(4);
    assert_eq!(engine.pin, None, "no pin inside a link's destination");
    super::typed(&mut engine, "z");
    assert_eq!(
        engine.display_text(),
        "lz",
        "typed text shows: {:?}",
        engine.source_text()
    );
}
