//! Random tables: commands and keys keep untouched cells exact.
use super::super::super::Engine;
use super::super::ok;
use super::run;

/// A small deterministic generator (xorshift), seeded by `TABLE_SEED`.
struct Random(u64);

impl Random {
    fn below(&mut self, bound: usize) -> usize {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 % bound as u64) as usize
    }

    fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
        items[self.below(items.len())]
    }
}

/// A random note holding one table: uneven rows, extra cells, a lone pipe,
/// a last cell with no closing pipe, escaped pipes, inline marks, CRLF.
fn random_table(random: &mut Random) -> String {
    const CELLS: [&str; 10] = [
        " a ", "  ", "b", " **c** ", " d\\|e ", "\té ", " `f` ", "", " [g](u) ", "h  ",
    ];
    const RULES: [&str; 5] = ["---", ":--", ":-:", "--:", " - "];
    let eol = if random.below(4) == 0 { "\r\n" } else { "\n" };
    let row = |random: &mut Random, cells: usize| -> String {
        let mut line = String::from("|");
        for at in 0..cells {
            line.push_str(random.pick(&CELLS));
            if at + 1 < cells || random.below(5) != 0 {
                line.push('|');
            }
        }
        if random.below(6) == 0 {
            line.push_str("  ");
        }
        line
    };
    let mut lines = Vec::new();
    if random.below(2) == 0 {
        lines.push(
            random
                .pick(&["intro", "", "- item", "| not a header |"])
                .to_owned(),
        );
    }
    let columns = 1 + random.below(4);
    let mut header = String::from("|");
    for _ in 0..columns {
        header.push_str(random.pick(&CELLS));
        header.push('|');
    }
    lines.push(header);
    let mut rule = String::from("|");
    for _ in 0..columns {
        rule.push_str(random.pick(&RULES));
        rule.push('|');
    }
    lines.push(rule);
    for _ in 0..random.below(5) {
        let cells = random.below(6);
        lines.push(row(random, cells));
    }
    if random.below(2) == 0 {
        lines.push(random.pick(&["after", "", "> quote", "a | b"]).to_owned());
    }
    let mut note = lines.join(eol);
    if random.below(2) == 0 {
        note.push_str(eol);
    }
    note
}

/// Each line of the table at line `index`, as its cells' exact bytes.
fn grid(engine: &Engine, index: usize) -> Vec<Vec<String>> {
    let table = engine.table_at(index).expect("a table");
    table
        .lines
        .iter()
        .map(|line| {
            line.cells
                .iter()
                .map(|cell| engine.source_slice(cell.clone()))
                .collect()
        })
        .collect()
}

/// The cells `name` leaves at `(row, column)` of a table `before` (each
/// line's cells, delimiter row second), given the cells `now` for the keys,
/// which may only add cells or rows, or edit the focused cell.
fn expected_grid(
    name: &str,
    before: &[Vec<String>],
    now: &[Vec<String>],
    (row, column): (usize, usize),
    width: usize,
    context: &str,
) -> Vec<Vec<String>> {
    let blank = |cell: &str| -> Vec<String> { vec![cell.to_owned(); width] };
    let mut want = before.to_vec();
    match name {
        "InsertRowAbove" => want.insert(row + 1, blank("  ")),
        "InsertRowBelow" => want.insert(if row == 0 { 2 } else { row + 2 }, blank("  ")),
        "DeleteRow" => {
            want.remove(row + 1);
        }
        "InsertColumnLeft" | "InsertColumnRight" => {
            let at = column + usize::from(name == "InsertColumnRight");
            for (index, cells) in want.iter_mut().enumerate() {
                let count = cells.len();
                if at < count || (at == count && count == width) {
                    cells.insert(at, if index == 1 { " --- " } else { "  " }.to_owned());
                }
            }
        }
        "DeleteColumn" => {
            for (index, cells) in want.iter_mut().enumerate() {
                if column < cells.len() {
                    if cells.len() > 1 {
                        cells.remove(column);
                    } else if index != 1 {
                        cells[0] = "  ".to_owned();
                    }
                }
            }
        }
        "key Backspace" | "key Delete" => {
            // A deletion stays inside the focused cell.
            let at = if row == 0 { 0 } else { row + 1 };
            assert_eq!(now.len(), want.len(), "{context}");
            if now[at].len() == want[at].len() {
                want[at][column] = now[at][column].clone();
            } else {
                // Emptying a last cell with no closing pipe leaves a
                // blank tail, which is no cell: the row is padded.
                assert_eq!(column + 1, want[at].len(), "{context}");
                want[at].pop();
            }
        }
        _ => {
            // Keys only add cells after a row's last, or a row at the end.
            assert!(now.len() >= want.len(), "{context}");
            for (old, new) in want.iter().zip(now) {
                assert_eq!(&new[..old.len()], &old[..], "{context}: kept cells");
            }
            want = now.to_vec();
        }
    }
    want
}

/// Random table commands and keys keep every cell they do not touch byte
/// for byte, show what a fresh read shows, and undo exactly.
#[test]
fn table_commands_keep_untouched_cells_exact_over_random_tables() {
    let seed = std::env::var("TABLE_SEED").map_or(0x5eed_7ab1e, |seed| seed.parse().unwrap());
    let cases: usize = std::env::var("TABLE_CASES").map_or(3_000, |cases| cases.parse().unwrap());
    let mut random = Random(seed | 1);
    let mut commanded = 0;
    for case in 0..cases {
        let source = random_table(&mut random);
        let mut engine = Engine::open(&source);
        let header = (0..engine.line_count())
            .find(|&index| {
                matches!(
                    engine.line(index).line.kind,
                    crate::lines::Kind::Table { .. }
                )
            })
            .expect("the generated table");
        let table = engine.table_at(header).unwrap();
        let before = grid(&engine, header);
        let row = random.below(table.rows());
        let line = table.row(row);
        if line.cells.is_empty() {
            continue;
        }
        let column = random.below(line.cells.len());
        let content = line.contents[column].clone();
        let selection = match random.below(3) {
            0 => content.start..content.start,
            1 => content.end..content.end,
            _ => content.clone(),
        };
        engine.land(selection, None);
        let opened = engine.selection();
        let width = table.width;
        let controls = table.controls(row);
        let name = [
            "InsertRowAbove",
            "InsertRowBelow",
            "DeleteRow",
            "InsertColumnLeft",
            "InsertColumnRight",
            "DeleteColumn",
            "Tab",
            "ShiftTab",
            "Enter",
            "ModEnter",
            "key Backspace",
            "key Delete",
        ][random.below(12)];
        let context = format!("case {case}: {name} at ({row}, {column}) in {source:?}");
        let edited = run(&mut engine, name).unwrap_or_else(|error| panic!("{context}: {error:?}"));
        let after = engine.source_text();
        assert_eq!(
            engine.display_text(),
            Engine::open(&after).display_text(),
            "{context}: display"
        );
        let applies = match name {
            "InsertRowAbove" => controls.insert_row_above,
            "DeleteRow" => controls.delete_row,
            "DeleteColumn" => controls.delete_column,
            "InsertRowBelow" | "InsertColumnLeft" | "InsertColumnRight" => true,
            _ => edited,
        };
        assert_eq!(edited, applies, "{context}: the command applies");
        if !edited {
            assert_eq!(after, source, "{context}: unchanged");
            continue;
        }
        commanded += 1;
        let now = grid(&engine, header);
        let want = expected_grid(name, &before, &now, (row, column), width, &context);
        assert_eq!(now, want, "{context}: cells");
        // Outside the table nothing changed, unless Delete at the last
        // row's end joined the line after it, as it does on any line.
        let old_start = table.lines[0].start;
        assert_eq!(after[..old_start], source[..old_start], "{context}: before");
        let old_end = table.last().end;
        assert!(
            after.ends_with(&source[old_end..]) || name == "key Delete",
            "{context}: after"
        );
        engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
        assert_eq!(engine.source_text(), source, "{context}: undo");
        assert_eq!(engine.selection(), opened, "{context}: undo selection");
        engine.redo(engine.revision(), &mut ok).unwrap().unwrap();
        assert_eq!(engine.source_text(), after, "{context}: redo");
    }
    assert!(commanded > cases / 3, "{commanded} of {cases} edited");
}
