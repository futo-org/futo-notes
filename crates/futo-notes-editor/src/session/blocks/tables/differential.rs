//! `inspect_tables` against the per-line `inspect_table` loop it replaced, over
//! random notes of tables, near-tables and the blocks that interrupt them.
use super::*;

impl EditorSession {
    /// The per-line loop `inspect_tables` replaced: one `inspect_table` per root line.
    fn inspect_tables_old(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<Vec<TableDescription>, EditorError> {
        self.check_revision(expected)?;
        self.validate_range(range)?;
        let mut tables: Vec<TableDescription> = Vec::new();
        let mut covered = 0;
        for line in self.projection.view_block_lines(range) {
            if line.code
                || line.quote_depth > 0
                || line.list.is_some()
                || line.in_list
                || line.heading > 0
                || line.divider
            {
                continue;
            }
            let at = self.projection.display_at(line.content.start);
            if at < covered {
                continue;
            }
            let at = DisplayRange {
                start: DisplayOffset(at),
                end: DisplayOffset(at),
            };
            if let Some(table) = self.inspect_table(expected, at)? {
                covered = table.display.end.0;
                tables.push(table);
            }
        }
        Ok(tables)
    }
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
        items[self.below(items.len())]
    }
    fn chance(&mut self, pct: usize) -> bool {
        self.below(100) < pct
    }
}

fn cell(rng: &mut Rng) -> String {
    rng.pick(&[
        "a",
        "",
        " ",
        "word here",
        "a \\| b",
        "`x|y`",
        "`a | b`",
        "\\\\",
        "x\\\\|",
        "**b**",
        "[[n|alias]]",
        "😀👩‍👩‍👧",
        "é",
        "\\|",
        "[l](u|v)",
        "-",
        ":-",
        "---",
    ])
    .to_string()
}

fn row(rng: &mut Rng, cells: usize) -> String {
    let lead = rng.chance(70);
    let trail = rng.chance(70);
    let pad = if rng.chance(80) { " " } else { "" };
    let mut s = String::new();
    if rng.chance(10) {
        s.push_str(rng.pick(&[" ", "  ", "   ", "    ", "\t"]));
    }
    if lead {
        s.push('|');
    }
    for i in 0..cells {
        if i > 0 {
            s.push('|');
        }
        s.push_str(pad);
        s.push_str(&cell(rng));
        s.push_str(pad);
    }
    if trail {
        s.push('|');
    }
    if rng.chance(5) {
        s.push_str("  ");
    }
    s
}

fn delim(rng: &mut Rng, cells: usize) -> String {
    let lead = rng.chance(70);
    let trail = rng.chance(70);
    let mut s = String::new();
    if lead {
        s.push('|');
    }
    for i in 0..cells {
        if i > 0 {
            s.push('|');
        }
        s.push_str(rng.pick(&[
            " - ", "-", " --- ", ":-", " :-: ", "-:", " ---: ", " x ", "",
        ]));
    }
    if trail {
        s.push('|');
    }
    s
}

fn block(rng: &mut Rng, out: &mut Vec<String>) {
    match rng.below(14) {
        0..=3 => {
            let cols = 1 + rng.below(4);
            let head_cols = if rng.chance(85) {
                cols
            } else {
                1 + rng.below(4)
            };
            let prefix = if rng.chance(12) {
                rng.pick(&["> ", "- ", "1. ", "  ", ">> ", "* "])
                    .to_string()
            } else {
                String::new()
            };
            out.push(format!("{prefix}{}", row(rng, head_cols)));
            out.push(format!("{prefix}{}", delim(rng, cols)));
            for _ in 0..rng.below(5) {
                let c = if rng.chance(75) { cols } else { rng.below(6) };
                out.push(format!("{prefix}{}", row(rng, c)));
            }
        }
        4 => out.push(
            rng.pick(&[
                "plain text",
                "a | b",
                "x|y",
                "|",
                "||",
                "| |",
                "\\|",
                "`|`",
                "text with `a|b` code",
            ])
            .to_string(),
        ),
        5 => out.push(String::new()),
        6 => out.push(rng.pick(&["", " ", "\t", "  \t"]).to_string()),
        7 => out.push(
            rng.pick(&[
                "- item",
                "- a | b",
                "1. one | two",
                "> quote | x",
                "> plain",
                "# head | x",
                "## h",
                "---",
                "***",
                "___",
                "* | a |",
                "+ x",
            ])
            .to_string(),
        ),
        8 => {
            let fence = rng.pick(&["```", "~~~", "````"]);
            out.push(format!("{fence}{}", rng.pick(&["", "rust"])));
            for _ in 0..rng.below(3) {
                out.push(row(rng, 2));
            }
            if rng.chance(85) {
                out.push(fence.to_string());
            }
        }
        9 => {
            let mut s = String::new();
            let n = 50 + rng.below(400);
            for i in 0..n {
                s.push_str(if i % 37 == 5 && rng.chance(50) {
                    "a | b "
                } else {
                    "word "
                });
            }
            out.push(s);
        }
        10 => out.push(format!("    {}", row(rng, 2))),
        11 => {
            for _ in 0..1 + rng.below(4) {
                out.push(
                    rng.pick(&["para line", "more text", "x | y", "- li", "| a |"])
                        .to_string(),
                );
            }
        }
        12 => out.push(
            rng.pick(&["<div>", "</div>", "$$", "[^1]: note | x", "[ref]: http://x"])
                .to_string(),
        ),
        _ => {
            let c = 1 + rng.below(3);
            out.push(row(rng, c));
        }
    }
}

fn doc(rng: &mut Rng) -> String {
    let mut lines = Vec::new();
    if rng.chance(15) {
        lines.push("---".to_string());
        lines.push(
            rng.pick(&["title: a | b", "tags: [x]", "| a | b |"])
                .to_string(),
        );
        if rng.chance(50) {
            lines.push("| - | - |".to_string());
        }
        lines.push("---".to_string());
    }
    for _ in 0..1 + rng.below(9) {
        block(rng, &mut lines);
    }
    let ending = rng.below(10);
    let mut s = String::new();
    for (i, line) in lines.iter().enumerate() {
        s.push_str(line);
        if i + 1 == lines.len() && rng.chance(25) {
            break;
        }
        s.push_str(match ending {
            0..=5 => "\n",
            6..=7 => "\r\n",
            _ => {
                if rng.chance(50) {
                    "\r\n"
                } else {
                    "\n"
                }
            }
        });
    }
    s
}

fn boundaries(text: &str) -> Vec<usize> {
    let mut v: Vec<usize> = text.char_indices().map(|(i, _)| i).collect();
    v.push(text.len());
    v
}

#[test]
fn inspect_tables_matches_the_per_line_loop_over_random_notes() {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let mut with_tables = 0usize;
    for n in 0..2_000 {
        let raw = doc(&mut rng);
        let mut session = EditorSession::open(&raw);
        let display = session.display_text();
        let bounds = boundaries(&display);
        let mut ranges = vec![(0, display.len())];
        for _ in 0..2 {
            let a = bounds[rng.below(bounds.len())];
            let b = bounds[rng.below(bounds.len())];
            ranges.push((a.min(b), a.max(b)));
        }
        for affinity in [Affinity::Forward, Affinity::Backward] {
            session.affinity = affinity;
            for &(a, b) in &ranges {
                let r = DisplayRange {
                    start: DisplayOffset(a),
                    end: DisplayOffset(b),
                };
                let new = session.inspect_tables(session.revision(), r);
                let old = session.inspect_tables_old(session.revision(), r);
                with_tables += usize::from(old.as_ref().is_ok_and(|t| !t.is_empty()));
                assert_eq!(
                    format!("{new:?}"),
                    format!("{old:?}"),
                    "doc #{n} {raw:?} range {a}..{b} affinity {affinity:?}"
                );
            }
        }
    }
    // The corpus must keep exercising tables, not just near-misses.
    assert!(with_tables > 1_000, "{with_tables}");
}
