//! An outside change on a line next to text typed since the note opened:
//! a line break between the two is a hard boundary, so the history rebases.
//! Every note repeats a word across its lines, which the word merge alone
//! refuses to place.
use super::super::super::Engine;
use super::super::properties::check_fresh;
use super::super::{select_source_range, typed};
use super::{adopt, redo, undo};
use crate::EditorError;

/// `typing` typed one character at a time at source offset `at` of `base`,
/// then `outside` (old line, new line pairs) applied to the result.
struct Neighbours<'a> {
    base: &'a str,
    at: usize,
    typing: &'a str,
    outside: &'a [(&'a str, &'a str)],
}

impl Neighbours<'_> {
    fn outside_of(&self, text: &str) -> String {
        let mut text = text.to_owned();
        for (old, new) in self.outside {
            assert_eq!(text.matches(old).count(), 1, "{old:?} once in {text:?}");
            text = text.replacen(old, new, 1);
        }
        text
    }

    fn typed(&self) -> Engine {
        let mut engine = Engine::open(self.base);
        select_source_range(&mut engine, self.at..self.at);
        for character in self.typing.chars() {
            typed(&mut engine, &character.to_string());
        }
        engine
    }

    /// Adopted in place: the caret stays after the typed text, Undo takes
    /// back only the typing and leaves the outside version, Redo restores it.
    fn adopts(&self) {
        let mut engine = self.typed();
        let local = engine.source_text();
        let caret = engine.source_bounds(engine.selection().end.0).1;
        let marked = format!("{}|{}", &local[..caret], &local[caret..]);
        let merged = self.outside_of(&local);
        adopt(&mut engine, &merged).unwrap_or_else(|error| panic!("{error:?} for {merged:?}"));
        assert_eq!(engine.source_text(), merged);
        let caret = engine.source_bounds(engine.selection().end.0).1;
        assert_eq!(Some(caret), self.outside_of(&marked).find('|'), "caret");
        check_fresh(&engine, "adopted");
        while undo(&mut engine) {}
        assert_eq!(engine.source_text(), self.outside_of(self.base), "undone");
        while redo(&mut engine) {}
        assert_eq!(engine.source_text(), merged, "redone");
    }

    fn refuses(&self, merged: &str) {
        let mut engine = self.typed();
        let local = engine.source_text();
        assert_eq!(
            adopt(&mut engine, merged).err(),
            Some(EditorError::UnrepresentableFormat)
        );
        assert_eq!(engine.source_text(), local);
    }
}

const LINES: &str = "alpha line\nbeta line\ngamma line\ndelta from shell";
const ALPHA: (&str, &str) = ("alpha line\n", "ALPHA LINE from shell\n");
const GAMMA: (&str, &str) = ("gamma line\n", "GAMMA LINE\n");

#[test]
fn an_outside_change_on_the_line_above_typing_is_taken_in_place() {
    let at = "alpha line\nbeta".len();
    let typing = " word";
    for outside in [&[ALPHA][..], &[GAMMA], &[ALPHA, GAMMA]] {
        Neighbours {
            base: LINES,
            at,
            typing,
            outside,
        }
        .adopts();
    }
    // The same typing two lines away was always taken in.
    let at = LINES.len();
    Neighbours {
        base: LINES,
        at,
        typing,
        outside: &[ALPHA],
    }
    .adopts();
}

#[test]
fn the_first_and_last_lines_take_a_change_next_to_them() {
    let typing = "new ";
    Neighbours {
        base: LINES,
        at: 0,
        typing,
        outside: &[("beta line", "BETA LINE")],
    }
    .adopts();
    let base = "alpha line\nbeta line\ngamma line";
    let at = base.len();
    let outside = &[("beta line\n", "BETA LINE\n")];
    Neighbours {
        base,
        at,
        typing: "!",
        outside,
    }
    .adopts();
}

#[test]
fn crlf_lines_list_items_and_code_fences_take_a_change_next_to_them() {
    let base = "alpha line\r\nbeta line\r\ngamma line\r\n";
    let outside = &[
        ("alpha line\r\n", "ALPHA LINE\r\n"),
        ("gamma line", "GAMMA"),
    ];
    Neighbours {
        base,
        at: "alpha line\r\nbeta".len(),
        typing: " word",
        outside,
    }
    .adopts();
    let base = "- one item\n- two item\n- three item\n";
    let outside = &[
        ("- one item\n", "- ONE item\n"),
        ("- three item", "- 3 item"),
    ];
    let at = "- one item\n- two".len();
    Neighbours {
        base,
        at,
        typing: " more",
        outside,
    }
    .adopts();
    let base = "code line\n```\nlet line = 1;\n```\nafter line\n";
    let outside = &[("```\nlet", "```rust\nlet"), ("```\nafter", "~~~\nafter")];
    let at = "code line\n```\nlet line = 1".len();
    Neighbours {
        base,
        at,
        typing: "0",
        outside: &outside[..1],
    }
    .adopts();
    let at = "code line".len();
    Neighbours {
        base,
        at,
        typing: "s",
        outside: &outside[..1],
    }
    .adopts();
}

#[test]
fn two_steps_on_adjacent_lines_both_rebase() {
    let mut engine = Engine::open(LINES);
    select_source_range(&mut engine, 15..15);
    typed(&mut engine, " word");
    let gamma = "alpha line\nbeta word line\ngamma".len();
    select_source_range(&mut engine, gamma..gamma);
    typed(&mut engine, " more");
    let local = engine.source_text();
    let merged = local.replacen("alpha line", "ALPHA LINE", 1);
    adopt(&mut engine, &merged).unwrap();
    assert!(undo(&mut engine));
    assert_eq!(engine.source_text(), merged.replacen(" more", "", 1));
    assert!(undo(&mut engine));
    assert_eq!(
        engine.source_text(),
        "ALPHA LINE\nbeta line\ngamma line\ndelta from shell"
    );
    assert!(redo(&mut engine) && redo(&mut engine));
    assert_eq!(engine.source_text(), merged);
}

#[test]
fn an_outside_change_to_the_typed_line_itself_is_still_refused() {
    let at = "alpha line\nbeta".len();
    let neighbours = Neighbours {
        base: LINES,
        at,
        typing: " word",
        outside: &[],
    };
    // Both sides wrote at the same place in the line.
    neighbours.refuses("ALPHA LINE\nbeta from shell word line\ngamma line\ndelta from shell");
    // Appending a line below a last line that has no line ending changes
    // that line: the line break is the outside change's own.
    let at = LINES.len();
    let neighbours = Neighbours {
        base: LINES,
        at,
        typing: " word",
        outside: &[],
    };
    neighbours.refuses("alpha line\nbeta line\ngamma line\ndelta from shell word\nnew line");
}

#[test]
fn a_new_line_typed_after_a_line_the_outside_rewrites_is_taken_in_place() {
    // Enter at the end of `beta line` adds a line break inside that line;
    // it is the same edit as a new line after it, which the rewrite spares.
    let at = "alpha line\nbeta line".len();
    let outside = &[("beta line\n", "BETA LINE\n")];
    Neighbours {
        base: LINES,
        at,
        typing: "\nnew line",
        outside,
    }
    .adopts();
    let outside = &[("gamma line\n", "GAMMA LINE\n")];
    Neighbours {
        base: LINES,
        at,
        typing: "\nnew line",
        outside,
    }
    .adopts();
}

#[test]
fn lines_the_outside_writes_where_a_typed_line_stands_are_refused() {
    // Both sides wrote a new line after `beta line`: which comes first is
    // unknown.
    let at = "alpha line\nbeta line\n".len();
    let neighbours = Neighbours {
        base: LINES,
        at,
        typing: "typed line\n",
        outside: &[],
    };
    neighbours
        .refuses("alpha line\nbeta line\ntyped line\nshell line\ngamma line\ndelta from shell");
}
