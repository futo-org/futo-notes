//! The toolbar's `allowed`: for random notes and selections (a caret, a
//! range, a code block selected as one object, a caret carrying a toggled
//! format), each command is allowed exactly when running it changes the
//! source, the selection or the formats a caret carries.
use super::*;
use crate::{BlockCommand, InlineFormat, ToolbarCommand};

const COMMANDS: [ToolbarCommand; 14] = [
    ToolbarCommand::Bold,
    ToolbarCommand::Italic,
    ToolbarCommand::Strike,
    ToolbarCommand::Code,
    ToolbarCommand::Link,
    ToolbarCommand::Heading,
    ToolbarCommand::Quote,
    ToolbarCommand::BulletList,
    ToolbarCommand::OrderedList,
    ToolbarCommand::TaskList,
    ToolbarCommand::CodeBlock,
    ToolbarCommand::Divider,
    ToolbarCommand::Table,
    ToolbarCommand::Image,
];

const FORMATS: [InlineFormat; 4] = [
    InlineFormat::Bold,
    InlineFormat::Italic,
    InlineFormat::Strike,
    InlineFormat::Code,
];

/// How the selection is made: a caret or a range (display offsets and
/// affinity), a code block selected at an offset, or a caret that toggles a
/// format.
#[derive(Clone, Copy, Debug)]
enum Setup {
    Select(usize, usize, Affinity),
    Block(usize),
    Carrying(usize, InlineFormat),
}

fn prepared(note: &str, setup: Setup) -> Engine {
    let mut engine = Engine::open(note);
    let revision = engine.revision();
    match setup {
        Setup::Select(start, end, affinity) => {
            engine
                .select_with_affinity(revision, range(start, end), affinity)
                .unwrap();
        }
        Setup::Block(at) => {
            let _ = engine.select_code_block(revision, DisplayOffset(at));
        }
        Setup::Carrying(at, format) => {
            engine.select(revision, range(at, at)).unwrap();
            engine
                .toggle_format_view(revision, format, &mut ok)
                .unwrap();
        }
    }
    engine
}

fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

/// The block command a toolbar button runs, for the commands that are one.
fn block_of(command: ToolbarCommand, level: u8) -> Option<BlockCommand> {
    Some(match command {
        ToolbarCommand::Heading => BlockCommand::ToggleHeading(level),
        ToolbarCommand::Quote => BlockCommand::Quote,
        ToolbarCommand::BulletList => BlockCommand::BulletList,
        ToolbarCommand::OrderedList => BlockCommand::OrderedList,
        ToolbarCommand::TaskList => BlockCommand::TaskList,
        ToolbarCommand::CodeBlock => BlockCommand::CodeBlock,
        ToolbarCommand::Divider => BlockCommand::Divider,
        ToolbarCommand::Table => BlockCommand::Table {
            rows: 3,
            columns: 3,
        },
        _ => return None,
    })
}

/// Run `command` the way a toolbar does; errors change nothing.
fn press(engine: &mut Engine, command: ToolbarCommand, level: u8) {
    let (revision, selection) = (engine.revision(), engine.selection());
    if let Some(block) = block_of(command, level) {
        let _ = engine.block(revision, selection, block, &mut ok);
        return;
    }
    if command == ToolbarCommand::Image {
        let _ = engine.insert_image(revision, "image.png", "", &mut ok);
        return;
    }
    if command == ToolbarCommand::Link {
        // A web address the link there, if any, does not have.
        let link = engine.inspect_link(revision, selection).unwrap();
        let destination = match link {
            Some(link) if link.destination == "https://example.com" => "https://example.org",
            _ => "https://example.com",
        };
        let _ = engine.set_link_view(revision, selection, destination, &mut ok);
        return;
    }
    // The first four commands are the four formats, in order.
    let at = COMMANDS.iter().position(|each| *each == command);
    let format = FORMATS[at.expect("a format command")];
    let _ = engine.toggle_toolbar_format_view(revision, format, &mut ok);
}

/// Whether `command`'s own builder writes edits there that change bytes,
/// which the guard then cancels when running it changes nothing.
fn builds_edits(engine: &Engine, command: ToolbarCommand, level: u8) -> bool {
    if command == ToolbarCommand::Link {
        return true;
    }
    let Some(block) = block_of(command, level) else {
        return false;
    };
    let built = engine.block_command(engine.selection(), block);
    let Ok(Some(built)) = built else {
        return false;
    };
    let source = engine.source_text();
    built
        .edits
        .iter()
        .any(|edit| source[edit.range.clone()] != edit.text)
}

type Seen = (
    String,
    DisplayRange,
    Option<DisplayRange>,
    Option<Vec<InlineFormat>>,
);

fn seen(engine: &Engine) -> Seen {
    (
        engine.source_text(),
        engine.selection(),
        engine.selected_block(),
        engine.formats.clone(),
    )
}

/// A command the toolbar allows that changes nothing has had the edits its
/// builder wrote cancelled by the guard (`command.rs`): they would have made
/// a line it did not name read as another block, as an item's marker taken
/// off a `|` line above a delimiter row makes it a table header. That is
/// the command's own refusal, not the toolbar's; the run reports each one
/// it meets (a link's or a block command's whose builder wrote edits) and
/// allows no other disagreement.
#[test]
fn a_toolbar_command_is_allowed_exactly_when_it_would_act() {
    let mut random = Random::from_env();
    let mut cancelled = Vec::new();
    let mut checked = 0;
    for case in 0..cases() {
        let original = note(&mut random);
        let probe = Engine::open(&original);
        let a = display_offset(&probe, &mut random);
        let b = display_offset(&probe, &mut random);
        let affinity = if random.below(2) == 0 {
            Affinity::Forward
        } else {
            Affinity::Backward
        };
        let setup = match random.below(6) {
            0 => Setup::Block(a),
            1 => Setup::Carrying(a, FORMATS[random.below(4)]),
            2 | 3 => Setup::Select(a, a, affinity),
            _ => Setup::Select(a.min(b), a.max(b), affinity),
        };
        let engine = prepared(&original, setup);
        let allowed = engine.toolbar().allowed;
        let before = seen(&engine);
        for command in COMMANDS {
            let levels: &[u8] = if command == ToolbarCommand::Heading {
                &[1, 2, 3, 4, 5, 6]
            } else {
                &[0]
            };
            for &level in levels {
                let mut pressed = prepared(&original, setup);
                press(&mut pressed, command, level);
                let acted = seen(&pressed) != before;
                checked += 1;
                let context =
                    format!("case {case}: {command:?} {level} on {original:?} after {setup:?}");
                if allowed.contains(&command) && !acted && builds_edits(&engine, command, level) {
                    cancelled.push(context);
                    continue;
                }
                assert_eq!(
                    acted,
                    allowed.contains(&command),
                    "{context}: wrote {:?}",
                    pressed.source_text()
                );
            }
        }
    }
    eprintln!(
        "{} of {checked} allowed commands cancelled by the guard:\n{}",
        cancelled.len(),
        cancelled.join("\n")
    );
}

/// The states hosts showed buttons in that did nothing: a caret in code and
/// a code block selected allow only the code block command (which takes
/// the code out of its block), so no image; a selected divider no heading,
/// quote, list or format, but an image in its place; table lines alone only the formats and link (each cell's
/// text); a code block with a line outside it no code block command.
#[test]
fn only_the_commands_that_act_are_allowed_in_code_dividers_and_tables() {
    use ToolbarCommand::*;
    let forward = Affinity::Forward;
    let code = "a\n```\ncode\n```\nb";
    for (note, setup, want) in [
        (code, Setup::Select(4, 4, forward), vec![CodeBlock]),
        (code, Setup::Block(4), vec![CodeBlock]),
        (
            "a\n---\nb",
            Setup::Select(2, 5, forward),
            vec![CodeBlock, Divider, Table, Image],
        ),
        (
            "| a |\n|---|\n| b |",
            Setup::Select(0, 5, forward),
            vec![Bold, Italic, Strike, Code, Link],
        ),
        (
            "x\n```\ncode\n```",
            Setup::Select(0, 4, forward),
            vec![
                Bold,
                Italic,
                Strike,
                Code,
                Link,
                Heading,
                Quote,
                BulletList,
                OrderedList,
                TaskList,
            ],
        ),
    ] {
        let toolbar = prepared(note, setup).toolbar();
        assert_eq!(toolbar.allowed, want, "{note:?} {setup:?}");
        let heading = toolbar.allowed.contains(&Heading);
        assert_eq!(toolbar.heading_allowed, heading, "{note:?} {setup:?}");
    }
    // Image insertion: refused in inline code, taken in a cell or on text.
    for (note, at, want) in [
        ("a `code` b", 4, false),
        ("| a |\n|---|\n| b |", 2, true),
        ("a b", 1, true),
    ] {
        let toolbar = prepared(note, Setup::Select(at, at, forward)).toolbar();
        assert_eq!(toolbar.allowed.contains(&Image), want, "{note:?} at {at}");
    }
}
