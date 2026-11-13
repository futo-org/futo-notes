//! The ported seam cases `editor_seams.rs` runs.
use futo_notes_ffi::EditorInlineFormat;

#[derive(Clone, Copy)]
pub enum Mode {
    /// `replace_utf16_action` as `Isolated`.
    Typing,
    Os,
    /// Two marked updates and a cancel, then the text marked and committed.
    Commit,
    /// The text marked over the range, then explicit runs.
    MarkedRuns,
    /// `!` marked at a caret, then a text service's replacement of the range.
    MarkedOs(u64),
    /// Explicit runs, or one run over the range.
    Runs,
    /// One input after another at the caret, the format toggled first.
    Sequence(Option<EditorInlineFormat>),
}

#[derive(Clone, Copy)]
pub struct Seam {
    pub name: &'static str,
    pub source: &'static str,
    pub mode: Mode,
    pub range: (u64, u64),
    pub text: &'static str,
    pub runs: &'static [(u64, u64, &'static str)],
    /// (`Isolated`, text) per input of a sequence.
    pub inputs: &'static [(bool, &'static str)],
    pub expected: &'static str,
    pub caret: u64,
    pub redo_caret: Option<u64>,
    pub history: u64,
}

const BASE: Seam = Seam {
    name: "",
    source: "",
    mode: Mode::Typing,
    range: (0, 0),
    text: "",
    runs: &[],
    inputs: &[],
    expected: "",
    caret: 0,
    redo_caret: None,
    history: 1,
};

const QUOTE: &str = "> > \n> ab\n> ===";
const SELECTED: &str = "> > !\n> \n> ab\n> ===";
const SPACED: &str = "a  b c";
const TYPED: &[(bool, &str)] = &[(false, "!"), (false, "?")];
const ISOLATED_FIRST: &[(bool, &str)] = &[(true, "!"), (false, "?")];

pub const CASES: &[Seam] = &[
    // Typed text lands as typed: `\!` is an escape now, nothing is encoded.
    Seam {
        name: "literal-backslash-input",
        source: "__ab\\c__",
        range: (3, 3),
        text: "!",
        expected: "__ab\\!c__",
        caret: 3,
        ..BASE
    },
    // A text service's runs keep the hidden quote markers between them.
    Seam {
        name: "multi-run-os",
        source: QUOTE,
        mode: Mode::Os,
        range: (0, 3),
        text: "!\nAC",
        expected: "> > !\n> AC\n> ===",
        caret: 4,
        ..BASE
    },
    Seam {
        name: "unchanged-os-tail",
        source: QUOTE,
        mode: Mode::Os,
        range: (0, 3),
        text: "!\nab",
        expected: "> > !\n> ab\n> ===",
        caret: 4,
        ..BASE
    },
    Seam {
        name: "blank-spaces-os",
        source: "> >  \n> ab\n> ===",
        mode: Mode::Os,
        range: (0, 4),
        text: "! \nAC",
        expected: "> > ! \n> AC\n> ===",
        caret: 5,
        ..BASE
    },
    Seam {
        name: "unicode-os",
        source: "> > \n> 猫🦊\n> ===",
        mode: Mode::Os,
        range: (0, 4),
        text: "!\n犬🐈",
        expected: "> > !\n> 犬🐈\n> ===",
        caret: 5,
        ..BASE
    },
    Seam {
        name: "raw-marked-cancel-commit",
        source: QUOTE,
        mode: Mode::Commit,
        text: "日本",
        expected: "> > 日本\n> ab\n> ===",
        caret: 2,
        ..BASE
    },
    // Marked text, then a text service's replacement: the marked text
    // commits and the replacement's runs keep the quote markers, as they do
    // with nothing marked (multi-run-os).
    Seam {
        name: "raw-marked-whole-os",
        source: QUOTE,
        mode: Mode::MarkedOs(0),
        range: (0, 4),
        text: "!\nAC",
        expected: "> > !\n> AC\n> ===",
        caret: 4,
        history: 2,
        ..BASE
    },
    Seam {
        name: "earlier-and-later-raw-marked-os-targets",
        source: "one\n\ntwo\n\nthree\n\n> > \n> ab\n> ===",
        mode: Mode::MarkedOs(17),
        range: (0, 21),
        text: "One\n\ntwo\n\nthree\n\n!\nAC",
        expected: "One\n\ntwo\n\nthree\n\n> > !\n> AC\n> ===",
        caret: 21,
        history: 2,
        ..BASE
    },
    Seam {
        name: "same-body-and-later-runs",
        source: "> >   \n> ab\n> ===",
        mode: Mode::Runs,
        runs: &[(0, 1, "!"), (1, 2, "?"), (3, 5, "AC")],
        expected: "> > !?\n> AC\n> ===",
        caret: 5,
        ..BASE
    },
    // Explicit runs while text is marked.
    Seam {
        name: "explicit-marked-space",
        source: SPACED,
        mode: Mode::MarkedRuns,
        range: (5, 6),
        text: "C",
        runs: &[(1, 2, ""), (3, 4, "B")],
        expected: "a B C",
        caret: 3,
        history: 2,
        ..BASE
    },
    Seam {
        name: "explicit-unchanged-marked-space",
        source: SPACED,
        mode: Mode::MarkedRuns,
        range: (5, 6),
        text: "c",
        runs: &[(1, 2, ""), (3, 4, "B")],
        expected: "a B c",
        caret: 3,
        ..BASE
    },
    Seam {
        name: "explicit-marked-escaped-scalar",
        source: "a!\\! b c",
        mode: Mode::MarkedRuns,
        range: (6, 7),
        text: "C",
        runs: &[(1, 2, ""), (4, 5, "B")],
        expected: "a\\! B C",
        caret: 4,
        history: 2,
        ..BASE
    },
    Seam {
        name: "explicit-marked-quote",
        source: "> > \n> a  b\n> =",
        mode: Mode::MarkedRuns,
        text: "!",
        runs: &[(3, 4, ""), (5, 6, "B")],
        expected: "> > !\n> a B\n> =",
        caret: 5,
        history: 2,
        ..BASE
    },
    Seam {
        name: "explicit-marked-distant-both-sides",
        source: "遠方😀\n\none\n\ntwo\n\na  b\n\n> > \n> c  d\n> =",
        mode: Mode::MarkedRuns,
        range: (22, 22),
        text: "!",
        runs: &[(17, 18, ""), (19, 20, "B"), (25, 26, ""), (27, 28, "D")],
        expected: "遠方😀\n\none\n\ntwo\n\na B\n\n> > !\n> c D\n> =",
        caret: 26,
        history: 2,
        ..BASE
    },
    Seam {
        name: "explicit-marked-noop-run",
        source: SPACED,
        mode: Mode::MarkedRuns,
        range: (5, 6),
        text: "C",
        runs: &[(1, 2, " ")],
        expected: "a  b C",
        caret: 2,
        redo_caret: Some(6),
        ..BASE
    },
    Seam {
        name: "explicit-marked-unchanged-final-run",
        source: SPACED,
        mode: Mode::MarkedRuns,
        range: (5, 6),
        text: "C",
        runs: &[(1, 2, ""), (3, 4, "B"), (5, 6, "C")],
        expected: "a B C",
        caret: 5,
        history: 2,
        ..BASE
    },
    // One run over lines: the text after it joins the line it starts on.
    Seam {
        name: "selected-source-one-line",
        source: "> > !\n> \n> ab\n> ===\n\n__untouched__ &amp; tail\n",
        mode: Mode::Runs,
        range: (0, 5),
        text: "AC",
        expected: "> > AC\n> ===\n\n__untouched__ &amp; tail\n",
        caret: 2,
        ..BASE
    },
    Seam {
        name: "selected-source-tail-keeps-its-quote",
        source: SELECTED,
        mode: Mode::Runs,
        range: (3, 5),
        text: "AC",
        expected: "> > !\n> \n> AC\n> ===",
        caret: 5,
        ..BASE
    },
    Seam {
        name: "selected-source-crlf-direct",
        source: "prefix!\r\n\r\n> > !\r\n> \r\n> ab\r\n> ===\r\n\r\nuntouched tail\r\n",
        range: (11, 18),
        text: "!\r\nAC",
        expected: "prefix!\r\n\r\n> > !\r\n> AC\r\n> ===\r\n\r\nuntouched tail\r\n",
        caret: 16,
        ..BASE
    },
    // One run while text is marked commits it as typing does: a typed line
    // break in a quote starts a plain line.
    Seam {
        name: "selected-source-changed-mark-explicit",
        source: QUOTE,
        mode: Mode::MarkedRuns,
        text: "!",
        runs: &[(0, 4, "!\nAC")],
        expected: "> > !\nAC\n> ===",
        caret: 4,
        history: 2,
        ..BASE
    },
    Seam {
        name: "selected-source-marked-explicit",
        source: SELECTED,
        mode: Mode::MarkedRuns,
        range: (0, 5),
        text: "!\n\nab",
        runs: &[(0, 5, "!\nAC")],
        expected: "> > !\nAC\n> ===",
        caret: 4,
        ..BASE
    },
    // Typing sequences group as typing; an isolated first input does not.
    Seam {
        name: "ordinary-typing-plain-control",
        source: "ab",
        mode: Mode::Sequence(None),
        inputs: TYPED,
        expected: "!?ab",
        caret: 2,
        ..BASE
    },
    Seam {
        name: "ordinary-typing-quote",
        source: QUOTE,
        mode: Mode::Sequence(None),
        inputs: TYPED,
        expected: "> > !?\n> ab\n> ===",
        caret: 2,
        ..BASE
    },
    Seam {
        name: "isolated-first-quote",
        source: QUOTE,
        mode: Mode::Sequence(None),
        inputs: ISOLATED_FIRST,
        expected: "> > !?\n> ab\n> ===",
        caret: 2,
        history: 2,
        ..BASE
    },
    Seam {
        name: "ordinary-typing-quote-bold",
        source: QUOTE,
        mode: Mode::Sequence(Some(EditorInlineFormat::Bold)),
        inputs: TYPED,
        expected: "> > **!?**\n> ab\n> ===",
        caret: 2,
        ..BASE
    },
    Seam {
        name: "ordinary-typing-quote-code",
        source: QUOTE,
        mode: Mode::Sequence(Some(EditorInlineFormat::Code)),
        inputs: TYPED,
        expected: "> > `!?`\n> ab\n> ===",
        caret: 2,
        ..BASE
    },
    // Typing at a divider's start writes a line of its own above it.
    Seam {
        name: "ordinary-typing-divider-edge",
        source: "---\n",
        mode: Mode::Sequence(None),
        inputs: TYPED,
        expected: "!?\n---\n",
        caret: 2,
        ..BASE
    },
    Seam {
        name: "isolated-first-divider-edge",
        source: "---\n",
        mode: Mode::Sequence(None),
        inputs: ISOLATED_FIRST,
        expected: "!?\n---\n",
        caret: 2,
        history: 2,
        ..BASE
    },
    // Code: an empty block's line, whole bodies, line breaks between code
    // lines, CRLF and the block that ends the note.
    Seam {
        name: "fence-empty-typing",
        source: "```\n```",
        text: "x",
        expected: "```\nx\n```",
        caret: 1,
        ..BASE
    },
    Seam {
        name: "fence-empty-enter",
        source: "```\n```",
        text: "\n",
        expected: "```\n\n\n```",
        caret: 1,
        ..BASE
    },
    Seam {
        name: "fence-empty-crlf",
        source: "~~~~Rust\r\n~~~~~  ",
        text: "猫",
        expected: "~~~~Rust\r\n猫\r\n~~~~~  ",
        caret: 1,
        ..BASE
    },
    Seam {
        name: "fence-empty-composition",
        source: "```\n```",
        mode: Mode::Commit,
        text: "日本",
        expected: "```\n日本\n```",
        caret: 2,
        ..BASE
    },
    Seam {
        name: "fence-empty-adjacent-typing",
        source: "```\n```",
        mode: Mode::Sequence(None),
        inputs: TYPED,
        expected: "```\n!?\n```",
        caret: 2,
        ..BASE
    },
    Seam {
        name: "fence-whole-body-delete",
        source: "```\na\n```",
        range: (0, 1),
        expected: "```\n\n```",
        ..BASE
    },
    Seam {
        name: "fence-whole-explicit-delete",
        source: "~~~\na\n~~~~~  ",
        mode: Mode::Runs,
        range: (0, 1),
        expected: "~~~\n\n~~~~~  ",
        ..BASE
    },
    Seam {
        name: "fence-os-body-delete",
        source: "~~~\na\n~~~~~  ",
        mode: Mode::Os,
        range: (0, 1),
        expected: "~~~\n\n~~~~~  ",
        ..BASE
    },
    Seam {
        name: "fence-authored-terminal-lf-delete",
        source: "~~~\na\n\n~~~~  ",
        range: (1, 2),
        expected: "~~~\na\n~~~~  ",
        caret: 1,
        ..BASE
    },
    Seam {
        name: "fence-open-noncloser",
        source: "```\na\n```\u{a0}",
        range: (6, 6),
        text: "!",
        expected: "```\na\n```\u{a0}!",
        caret: 7,
        ..BASE
    },
    Seam {
        name: "fence-literal-noncloser-keeps-frame",
        source: "```\na\n```",
        text: "```\u{a0}\n",
        expected: "```\n```\u{a0}\na\n```",
        caret: 5,
        ..BASE
    },
    Seam {
        name: "code-physical-blank-crlf-end",
        source: "```Rust\r\na\r\n\r\n",
        range: (3, 3),
        text: "X",
        expected: "```Rust\r\na\r\nX\r\n",
        caret: 4,
        ..BASE
    },
    Seam {
        name: "code-physical-internal-blank-crlf",
        source: "```Rust\r\na\r\n\r\nb\r\n```",
        range: (3, 3),
        text: "X",
        expected: "```Rust\r\na\r\nX\r\nb\r\n```",
        caret: 4,
        ..BASE
    },
    Seam {
        name: "code-physical-selected-lf-delete",
        source: "```\na\nb\n```",
        range: (1, 2),
        expected: "```\nab\n```",
        caret: 1,
        ..BASE
    },
    Seam {
        name: "code-physical-selected-lf-replace",
        source: "```\na\nb\n```",
        range: (1, 2),
        text: "X",
        expected: "```\naXb\n```",
        caret: 2,
        ..BASE
    },
    Seam {
        name: "code-physical-selected-lf-os",
        source: "```\na\nb\n```",
        mode: Mode::Os,
        range: (1, 2),
        text: "X",
        expected: "```\naXb\n```",
        caret: 2,
        ..BASE
    },
    Seam {
        name: "code-physical-selected-crlf-explicit",
        source: "~~~Rust\r\na\r\nb\r\n~~~~  ",
        mode: Mode::Runs,
        range: (1, 3),
        text: "X",
        expected: "~~~Rust\r\naXb\r\n~~~~  ",
        caret: 2,
        ..BASE
    },
    Seam {
        name: "code-physical-end-composition",
        source: "```Rust\r\na\r\n\r\n",
        mode: Mode::Commit,
        range: (3, 3),
        text: "猫🦊",
        expected: "```Rust\r\na\r\n猫🦊\r\n",
        caret: 6,
        ..BASE
    },
    Seam {
        name: "code-physical-shifted-end-explicit",
        source: "__猫🦊__\n\n~~~Rust\r\na\r\n\r\n",
        mode: Mode::Runs,
        range: (8, 8),
        text: "X",
        expected: "__猫🦊__\n\n~~~Rust\r\na\r\nX\r\n",
        caret: 9,
        ..BASE
    },
    Seam {
        name: "code-physical-enter-keeps-authored-cr",
        source: "```\r\na\r\nb\r\n```",
        range: (1, 1),
        text: "\n",
        expected: "```\r\na\n\r\nb\r\n```",
        caret: 2,
        ..BASE
    },
    Seam {
        name: "code-source-identity-many-changed",
        source: "```Rust\na\n\nb\n",
        mode: Mode::Runs,
        runs: &[(0, 3, "a\n\n"), (3, 4, "B")],
        expected: "```Rust\na\n\nB\n",
        caret: 4,
        ..BASE
    },
];
