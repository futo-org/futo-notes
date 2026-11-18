//! The characters paired typing acts on, and the pair each one writes.
use crate::lines::SpanKind;
use crate::InlineFormat::{self, Bold, Code, Italic, Strike};

/// Where a typed character may write a new pair.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Opening {
    Anywhere,
    /// Not where only a line's indent and quote markers stand before the
    /// caret (`* ` makes a bullet there), and not right after a letter, a
    /// digit or the same character (`2*3`, `a*`).
    AfterSpaceOrPunctuation,
    /// Only right after one lone half that follows no letter or digit: one
    /// `~` means nothing, so the second writes the pair.
    AfterLoneHalf,
}

pub(super) struct Pair {
    /// The character typed to open the pair.
    pub typed: &'static str,
    /// One level of the pair, before and after the caret.
    pub open: &'static str,
    pub close: &'static str,
    /// The level an empty pair grows to, one per typed `typed`; at it the
    /// character is typed plain. Zero for a pair that never grows.
    pub grows_to: usize,
    pub opening: Opening,
    /// The formats whose hidden closing marker a typed character passes.
    pub closes: &'static [SpanKind],
    /// The formats a selection takes, one level per typed character: the
    /// next level after the one the selection reads as. Empty where the
    /// character is typed over a selection.
    pub selection_levels: &'static [&'static [InlineFormat]],
}

/// The one character with block rules of its own: a lone pair makes a code
/// block, and over lines a selection becomes one.
pub(super) const BACKTICK: &str = "`";

impl Pair {
    pub fn is_backtick(&self) -> bool {
        self.typed == BACKTICK
    }

    /// The levels of an empty pair that paired Backspace removes one by one.
    pub fn levels(&self) -> usize {
        self.grows_to.max(1)
    }

    /// The character typed to step over the pair's closing half, when that
    /// half is not made of the opening character (`]`).
    pub fn closing(&self) -> Option<&'static str> {
        (!self.close.starts_with(self.typed)).then_some(self.close)
    }
}

pub(super) static PAIRS: [Pair; 4] = [
    Pair {
        typed: BACKTICK,
        open: BACKTICK,
        close: BACKTICK,
        grows_to: 0,
        opening: Opening::Anywhere,
        closes: &[SpanKind::Code],
        selection_levels: &[&[], &[Code]],
    },
    Pair {
        typed: "*",
        open: "*",
        close: "*",
        grows_to: 3,
        opening: Opening::AfterSpaceOrPunctuation,
        closes: &[SpanKind::Bold, SpanKind::Italic],
        selection_levels: &[&[], &[Italic], &[Bold], &[Bold, Italic]],
    },
    Pair {
        typed: "~",
        open: "~~",
        close: "~~",
        grows_to: 1,
        opening: Opening::AfterLoneHalf,
        closes: &[SpanKind::Strike],
        selection_levels: &[&[], &[Strike]],
    },
    Pair {
        typed: "[",
        open: "[",
        close: "]",
        grows_to: 2,
        opening: Opening::Anywhere,
        closes: &[],
        selection_levels: &[],
    },
];

/// What one typed text is to paired typing.
pub(super) enum PairKey {
    /// The character that opens (or grows) `Pair`.
    Open(&'static Pair),
    /// `Pair`'s distinct closing character (`]`), which only steps over.
    Close(&'static Pair),
}

/// Whether `text` is one character paired typing acts on: an opening
/// character of the table above, or a distinct closing one (`]`).
pub fn is_paired_typing_key(text: &str) -> bool {
    pair_key(text).is_some()
}

pub(super) fn pair_key(text: &str) -> Option<PairKey> {
    PAIRS.iter().find_map(|pair| {
        if text == pair.typed {
            return Some(PairKey::Open(pair));
        }
        (pair.closing() == Some(text)).then_some(PairKey::Close(pair))
    })
}
