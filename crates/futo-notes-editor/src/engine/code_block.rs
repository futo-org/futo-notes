//! The fenced block a shown code line belongs to. Opening and closing fence
//! lines alternate and the store counts them (`Size::frames`), so a line's
//! fence lines are found in the store's index, never by walking the block.
use super::line::{Entry, Role};
use super::store::{self, Store};
use crate::lines::{FenceInfo, FenceRole, Kind};
use crate::{CodeBlockDescription, CodeLineDescription, DisplayOffset, DisplayRange};
use std::sync::Arc;

pub(super) struct CodeBlock {
    /// Its opening line, and its closing line when something closes it.
    pub opener: usize,
    pub closer: Option<usize>,
    /// The first and last lines shown as its code.
    pub first: usize,
    pub last: usize,
    info: Arc<FenceInfo>,
    pub description: CodeBlockDescription,
}

/// Whether line `entry` shows as code: a code line, or an empty block's
/// opening line, which shows as its one empty line.
pub(super) fn is_code_line(entry: &Entry) -> bool {
    match entry.line.kind {
        Kind::Fence {
            role: FenceRole::Code,
            ..
        } => true,
        Kind::Fence {
            role: FenceRole::Open,
            ..
        } => entry.view.role == Role::Empty,
        _ => false,
    }
}

/// Whether line `entry` opens a block: the line below it, when code, is its
/// block's first.
pub(super) fn is_opening_fence(entry: &Entry) -> bool {
    matches!(
        entry.line.kind,
        Kind::Fence {
            role: FenceRole::Open,
            ..
        }
    )
}

/// The opening fence's leading whitespace for line `entry`, which shows as
/// code (`is_code_line`): a code line starting with it hides it, and every
/// code line the engine writes starts with it.
pub(super) fn fence_indent(entry: &Entry) -> &str {
    if is_opening_fence(entry) {
        return leading(entry.body());
    }
    entry.carry.fence.as_ref().map_or("", |fence| &fence.indent)
}

/// Leading spaces and tabs.
pub(super) fn leading(text: &str) -> &str {
    &text[..text.len() - text.trim_start_matches([' ', '\t']).len()]
}

/// Whether line-relative offset `column` of line `entry` is its opening
/// fence's hidden end, where a caret writes the block's language.
pub(super) fn is_opening_fence_end(entry: &Entry, column: usize) -> bool {
    is_opening_fence(entry) && column == entry.body_len()
}

fn line_count(lines: usize) -> u32 {
    u32::try_from(lines).unwrap_or(u32::MAX)
}

impl CodeBlock {
    /// The block of line `index`, which shows as code (`is_code_line`).
    pub fn holding(store: &Store, index: usize) -> Self {
        let empty = is_opening_fence(store.get(index));
        let (opener, first, last, closer) = if empty {
            // An empty block's line is the note's last, or a closing line follows it.
            let closer = (index + 1 < store.len()).then_some(index + 1);
            (index, index, index, closer)
        } else {
            // The fence lines before a code line end with its opening line.
            let opened = store.before(index).frames;
            let (opener, _) = store
                .line_past(store::frames, opened - 1)
                .expect("a code line's opening fence");
            let closer = store.line_past(store::frames, opened).map(|(at, _)| at);
            let last = closer.map_or(store.len() - 1, |closer| closer - 1);
            (opener, opener + 1, last, closer)
        };
        let info = match &store.get(opener).line.kind {
            Kind::Fence {
                info: Some(info), ..
            } => Arc::clone(info),
            _ => unreachable!("an opening fence carries its info"),
        };
        let end = store.before(last).display + store.get(last).shown_len();
        let description = CodeBlockDescription {
            range: DisplayRange {
                start: DisplayOffset(store.before(first).display),
                end: DisplayOffset(end),
            },
            language: info.language.clone(),
            name: info.name.clone(),
            line_count: line_count(last - first + 1),
        };
        Self {
            opener,
            closer,
            first,
            last,
            info,
            description,
        }
    }

    pub fn holds(&self, index: usize) -> bool {
        self.first <= index && index <= self.last
    }

    /// Line `index` of this block.
    pub fn line(&self, index: usize) -> CodeLineDescription {
        let line_number = line_count(index - self.first + 1);
        CodeLineDescription {
            line_number,
            first: index == self.first,
            last: index == self.last,
            mark: self.info.mark(line_number),
        }
    }
}
