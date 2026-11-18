//! A block command that also removes typed text (a `/` menu's query): the
//! note and caret the removal then the command leave, as one action and one
//! Undo step that gives the typed text back.
use super::super::Engine;
use super::{ok, range};
use crate::{BlockCommand, DisplayRange, InputAction};

const COMMANDS: [BlockCommand; 13] = [
    BlockCommand::Heading(0),
    BlockCommand::Heading(1),
    BlockCommand::Heading(2),
    BlockCommand::Heading(6),
    BlockCommand::ToggleHeading(1),
    BlockCommand::BulletList,
    BlockCommand::OrderedList,
    BlockCommand::TaskList,
    BlockCommand::ToggleTask,
    BlockCommand::Quote,
    BlockCommand::CodeBlock,
    BlockCommand::Divider,
    BlockCommand::Table {
        rows: 3,
        columns: 3,
    },
];

/// `note` with the caret after the last `typed`, and `typed`'s display range.
fn typed_in(note: &str, typed: &str) -> (Engine, DisplayRange) {
    let mut engine = Engine::open(note);
    let start = engine.display_text().rfind(typed).expect("the typed text");
    let end = start + typed.len();
    engine.select(engine.revision(), range(end, end)).unwrap();
    (engine, range(start, end))
}

/// The command with `removed` removed first, as one action; whether it
/// changed the note.
fn removing(engine: &mut Engine, removed: DisplayRange, command: BlockCommand) -> bool {
    let revision = engine.revision();
    let change = engine.block_removing(revision, removed, command, &mut ok);
    change.unwrap().is_some()
}

#[test]
fn the_removal_and_the_command_are_one_undo_step() {
    let notes = [
        ("/hea", "/hea"),
        ("intro\n/hea", "/hea"),
        ("ab /q", "/q"),
        ("ab /q cd", "/q"),
        ("- item /q", "/q"),
        ("> quote /q\nnext", "/q"),
        ("# Title /q", "/q"),
        ("1. one\n2. two /q", "/q"),
        ("| a |\n|---|\n| b /q |", "/q"),
    ];
    for (note, typed) in notes {
        for command in COMMANDS {
            let context = format!("{note:?} {command:?}");
            let (mut engine, removed) = typed_in(note, typed);
            let opening = (engine.selection(), engine.caret_source());
            let (mut steps, _) = typed_in(note, typed);
            let revision = steps.revision();
            steps
                .replace(revision, removed, "", InputAction::Typing, &mut ok)
                .unwrap();
            let (revision, caret) = (steps.revision(), steps.selection());
            steps.block(revision, caret, command, &mut ok).unwrap();

            assert!(removing(&mut engine, removed, command), "{context}");
            let after = (engine.source_text(), engine.selection());
            assert_eq!(after, (steps.source_text(), steps.selection()), "{context}");
            assert_eq!(engine.caret_source(), steps.caret_source(), "{context}");

            engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
            assert_eq!(engine.source_text(), note, "{context}: undo");
            let undone = (engine.selection(), engine.caret_source());
            assert_eq!(undone, opening, "{context}: undo");
            assert!(!engine.can_undo(), "{context}: one undo step");
            engine.redo(engine.revision(), &mut ok).unwrap().unwrap();
            let redone = (engine.source_text(), engine.selection());
            assert_eq!(redone, after, "{context}: redo");
        }
    }
}

/// The note and caret source offset each command leaves on a line that held
/// only the query, and mid-line.
#[test]
fn the_command_runs_at_the_caret_the_removal_leaves() {
    let table = "|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |";
    for (note, typed, command, after, caret) in [
        ("/hea", "/hea", BlockCommand::Heading(1), "# ", 2),
        ("/hea", "/hea", BlockCommand::BulletList, "- ", 2),
        ("/hea", "/hea", BlockCommand::Divider, "---\n", 4),
        (
            "x\n/t\ny",
            "/t",
            BlockCommand::Table {
                rows: 3,
                columns: 3,
            },
            "",
            4,
        ),
        ("ab /q cd", "/q", BlockCommand::Heading(2), "## ab  cd", 6),
        ("ab /q", "/q", BlockCommand::Quote, "> ab ", 5),
    ] {
        let (mut engine, removed) = typed_in(note, typed);
        assert!(
            removing(&mut engine, removed, command),
            "{note:?} {command:?}"
        );
        let want = if after.is_empty() {
            format!("x\n{table}\ny")
        } else {
            after.to_owned()
        };
        assert_eq!(engine.source_text(), want, "{note:?} {command:?}");
        assert_eq!(engine.caret_source(), caret, "{note:?} {command:?}");
    }
}

/// A command that changes nothing where the removal leaves the caret: the
/// removal alone, one Undo step.
#[test]
fn a_command_refused_there_leaves_the_removal_alone() {
    let note = "| a |\n|---|\n| b /q |";
    let (mut engine, removed) = typed_in(note, "/q");
    assert!(removing(&mut engine, removed, BlockCommand::Heading(1)));
    assert_eq!(engine.source_text(), "| a |\n|---|\n| b  |");
    assert_eq!(engine.caret_source(), "| a |\n|---|\n| b ".len());
    engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
    assert_eq!(engine.source_text(), note);
    assert!(!engine.can_undo());
}

/// A range across lines, an image or a wikilink, on a code line or in front
/// matter is refused: nothing removed, no history.
#[test]
fn a_range_that_is_not_typed_text_on_one_line_changes_nothing() {
    for (note, start, end) in [
        ("a\n/b", 0, 4),
        ("```\n/x\n```", 0, 2),
        ("x![a](p.png)/q", 1, 3),
        ("[[note]]/q", 4, 10),
        ("---\nk: v\n---\n/q", 0, 2),
    ] {
        let mut engine = Engine::open(note);
        let revision = engine.revision();
        let shown = engine.display_text();
        let removed = range(start.min(shown.len()), end.min(shown.len()));
        let change = engine
            .block_removing(revision, removed, BlockCommand::Heading(1), &mut ok)
            .unwrap();
        assert!(change.is_none(), "{note:?}");
        assert_eq!(engine.source_text(), note, "{note:?}");
        assert!(!engine.can_undo(), "{note:?}");
    }
}

/// Marked text commits first as its own Undo step, as for every command.
#[test]
fn marked_text_commits_first_as_its_own_undo_step() {
    let mut engine = Engine::open("ab ");
    engine
        .compose(engine.revision(), range(3, 3), "/h")
        .unwrap();
    let revision = engine.revision();
    let change = engine.block_removing(revision, range(3, 5), BlockCommand::Heading(1), &mut ok);
    assert!(change.unwrap().is_some());
    assert_eq!(engine.source_text(), "# ab ");
    engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
    assert_eq!(engine.source_text(), "ab /h");
    engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
    assert_eq!(engine.source_text(), "ab ");
}
