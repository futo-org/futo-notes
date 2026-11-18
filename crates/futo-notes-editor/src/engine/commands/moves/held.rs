//! Which lines a list holds, for the landing rule that only an item or one
//! plain line lands strictly between two lines of a list. A line belongs to
//! a list when it is an unquoted item, or an unquoted item holds it as
//! Indent moves it (`list_subtree_end`). Each line is asked about near the
//! lines asked before it, so a listing reads what is near its range, not the
//! note from its top.
use crate::engine::Engine;
use crate::lines::{FenceRole, Kind};
use crate::EditWork;
use std::collections::HashMap;

/// The lines one listing has asked about: each one's holder.
#[derive(Default)]
pub(super) struct Held(HashMap<usize, Option<usize>>);

impl Engine {
    /// The indent of the innermost unquoted item holding line `index` (an
    /// item holds itself), or `None` when no list holds it.
    pub(super) fn holder(
        &self,
        index: usize,
        held: &mut Held,
        work: &mut EditWork,
    ) -> Option<usize> {
        if let Some(&found) = held.0.get(&index) {
            return found;
        }
        work.link_metadata_items += 1;
        let line = &self.line(index).line;
        let above = index.checked_sub(1).and_then(|at| held.0.get(&at).copied());
        let found = match line.kind {
            _ if line.quote > 0 => None,
            Kind::List { indent, .. } => Some(indent),
            Kind::Plain { indent }
            | Kind::Fence {
                role: FenceRole::Open,
                indent,
                ..
            } if indent > 0 => match above {
                // A line no list holds passes none down; one held by an item
                // less indented than this line is held by it too.
                Some(None) => None,
                Some(Some(outer)) if indent > outer => Some(outer),
                _ => self.holder_above(index, indent, work),
            },
            // A code or closing line is held as its opening fence is.
            Kind::Fence {
                role: FenceRole::Code | FenceRole::Close,
                ..
            } => match above {
                Some(found) => found,
                None => {
                    let open = self.fence_opening(index, work);
                    (open < index)
                        .then(|| self.holder(open, held, work))
                        .flatten()
                }
            },
            _ => None,
        };
        held.0.insert(index, found);
        found
    }

    /// Walk up from line `index`, indented `indent`, to the item holding it:
    /// the first unquoted item less indented than every line between, past
    /// lines that continue an item (indented plain lines and items, and
    /// fences opened under one). Any other line, or an unindented one, ends
    /// the walk with none.
    fn holder_above(&self, index: usize, indent: usize, work: &mut EditWork) -> Option<usize> {
        let mut least = indent;
        let mut at = index;
        while at > 0 {
            at -= 1;
            work.link_metadata_items += 1;
            if matches!(
                self.line(at).line.kind,
                Kind::Fence {
                    role: FenceRole::Code | FenceRole::Close,
                    ..
                }
            ) {
                at = self.fence_opening(at, work);
            }
            let line = &self.line(at).line;
            let indent = match line.kind {
                _ if line.quote > 0 => return None,
                Kind::List { indent, .. } if indent < least => return Some(indent),
                Kind::List { indent, .. }
                | Kind::Plain { indent }
                | Kind::Fence {
                    role: FenceRole::Open,
                    indent,
                    ..
                } => indent,
                _ => return None,
            };
            if indent == 0 {
                return None;
            }
            least = least.min(indent);
        }
        None
    }

    /// The opening fence of the code or closing line `index`.
    fn fence_opening(&self, index: usize, work: &mut EditWork) -> usize {
        let mut at = index;
        while at > 0
            && matches!(
                self.line(at).line.kind,
                Kind::Fence {
                    role: FenceRole::Code | FenceRole::Close,
                    ..
                }
            )
        {
            at -= 1;
            work.link_metadata_items += 1;
        }
        at
    }
}
