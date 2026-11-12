//! Random notes and positions for the property run.
use super::*;

pub(super) struct Random(pub(super) u64);

impl Random {
    pub(super) fn from_env() -> Self {
        let seed = std::env::var("TYPING_SEED").map_or(0x9e37_79b9_7f4a_7c15, |seed| {
            seed.parse().expect("TYPING_SEED")
        });
        Self(seed | 1)
    }

    pub(super) fn below(&mut self, bound: usize) -> usize {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 % bound.max(1) as u64) as usize
    }

    pub(super) fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
        items[self.below(items.len())]
    }
}

pub(super) fn cases() -> usize {
    std::env::var("TYPING_CASES").map_or(300, |cases| cases.parse().expect("TYPING_CASES"))
}

pub(super) const LINE_STARTS: &[&str] = &[
    "", "", "# ", "## ", "- ", "* ", "+ ", "1. ", "3) ", "- [ ] ", "- [x] ", "> ", "> - ", ">",
    "  ", "    - ", "\t", "  1. ", "-", "#", ">>", "|", "| ",
];

pub(super) const LINES: &[&str] = &[
    "---",
    "***",
    "___",
    "```",
    "```js",
    "~~~",
    "````",
    "| a | b |",
    "|---|:-:|",
    "| x | y | z |",
    "- - -",
    "",
    "   ",
    "> ",
];

pub(super) const INLINE: &[&str] = &[
    "a",
    "b",
    "word",
    " ",
    "  ",
    "\t",
    "*",
    "**",
    "_",
    "__",
    "~~",
    "`",
    "``",
    "[",
    "]",
    "(",
    ")",
    "](u)",
    "[t](https://x.y)",
    "![alt](p.png)",
    "<https://x.y>",
    "https://x.y",
    "[[note]]",
    "#tag",
    "\\",
    "\\*",
    "|",
    "\\|",
    "é",
    "e\u{301}",
    "😀",
    "日本",
    "\u{fffc}",
    "\r",
    "&amp;",
    "snake_case_word",
];

pub(super) const TYPED: &[&str] = &[
    "a", "b", " ", "*", "_", "~", "`", "#", "-", "+", ">", "|", "[", "]", "(", ")", "!", "\\", "1",
    ".", "\n", "\r\n", "\t", "é", "😀", "\u{301}", "---", "```", "- ", "# ", "> ", "x\ny", "**",
    "| a |", "|---|", "\r",
];

pub(super) fn note(random: &mut Random) -> String {
    let mut out = String::new();
    if random.below(8) == 0 {
        out.push_str("---\nkey: v\n");
        if random.below(2) == 0 {
            out.push_str("---\n");
        }
    }
    for line in 0..random.below(12) {
        if line > 0 {
            out.push_str(if random.below(5) == 0 { "\r\n" } else { "\n" });
        }
        if random.below(4) == 0 {
            out.push_str(random.pick(LINES));
            continue;
        }
        out.push_str(random.pick(LINE_STARTS));
        for _ in 0..random.below(6) {
            out.push_str(random.pick(INLINE));
        }
    }
    if random.below(3) == 0 {
        out.push('\n');
    }
    out
}

/// A random display offset that is a character boundary.
pub(super) fn display_offset(engine: &Engine, random: &mut Random) -> usize {
    let display = engine.display_text();
    let mut at = random.below(display.len() + 1);
    while !display.is_char_boundary(at) {
        at -= 1;
    }
    at
}
