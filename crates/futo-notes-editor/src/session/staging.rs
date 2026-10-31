//! Semantic reads beyond a temporary source window retain their real origin.
//! Only fixed-size canonical witnesses cross this boundary; local interpretation
//! is always read again after each seam edit or marked-text commit.
use super::*;
use crate::inline::ContextWitness;
use std::ops::Range;

#[derive(Clone)]
pub(super) struct Neighbor {
    pub witness: ContextWitness,
    pub marker: Option<u8>,
    pub local: bool,
}

#[derive(Clone, Default)]
struct Boundary {
    nearest: Option<Neighbor>,
    beyond_blank: Option<Neighbor>,
}

impl Boundary {
    fn read(&self, quote: usize) -> Option<Neighbor> {
        let nearest = self.nearest.as_ref()?;
        let found = if nearest.witness.transparent_quote == Some(quote) {
            self.beyond_blank.as_ref()
        } else {
            Some(nearest)
        };
        found.cloned().map(|mut neighbor| {
            neighbor.local = false;
            neighbor
        })
    }
}

/// Opening-generation boundary facts, without source offsets or identity.
/// Edits within a staged window do not move or change its untouched outside.
#[derive(Clone, Copy, Debug, Default)]
pub(super) enum PhysicalTail {
    Eof,
    Row {
        code: bool,
        quote_depth: usize,
        first_item: Option<bool>,
        item_depth: Option<usize>,
        empty_comment: bool,
        quote_start: bool,
    },
    #[default]
    Unknown,
}

/// Original complete-item ownership, separate from physical EOF/tail facts.
/// It has no source offsets, body references or cross-generation identity.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct FenceBoundary {
    pub depth: usize,
    pub list_quote: usize,
    pub code_quote: usize,
    pub gap_bytes: usize,
}

pub(super) struct StageContext {
    before: Boundary,
    after: Boundary,
    physical_tail: PhysicalTail,
    original_canonical: bool,
    fence_edge: Option<FenceBoundary>,
}

impl Default for StageContext {
    fn default() -> Self {
        Self {
            before: Boundary::default(),
            after: Boundary::default(),
            physical_tail: PhysicalTail::Unknown,
            original_canonical: false,
            fence_edge: None,
        }
    }
}

impl StageContext {
    /// Only the constructor for a complete real source may certify its edge.
    pub(super) fn complete_source() -> Self {
        Self {
            physical_tail: PhysicalTail::Eof,
            original_canonical: true,
            ..Self::default()
        }
    }
}

impl EditorSession {
    pub(super) fn semantic_neighbor(
        &self,
        at: usize,
        forward: bool,
        quote: usize,
    ) -> Option<Neighbor> {
        if let Some(witness) = self.projection.rows.context_neighbor(at, forward, quote) {
            let marker = witness.list.as_ref().map(|list| {
                self.source
                    .byte_slice(list.marker.end - 1..list.marker.end)
                    .bytes()
                    .next()
                    .unwrap()
            });
            return Some(Neighbor {
                witness,
                marker,
                local: true,
            });
        }
        if forward {
            &self.context.after
        } else {
            &self.context.before
        }
        .read(quote)
    }

    fn stage_boundary(&self, at: usize, forward: bool) -> Boundary {
        // No physical quote depth can equal usize::MAX. First retain the
        // nearest run including blanks. A query either stops at that run, or
        // skips its one transparent depth and uses the second witness.
        let nearest = self.semantic_neighbor(at, forward, usize::MAX);
        let beyond_blank = nearest
            .as_ref()
            .and_then(|neighbor| neighbor.witness.transparent_quote)
            .and_then(|quote| self.semantic_neighbor(at, forward, quote));
        Boundary {
            nearest,
            beyond_blank,
        }
    }

    /// `raw` is the exact opening source window, never display coordinates.
    /// Its two outside contexts remain valid as local source changes: every
    /// new read searches the current local rows before consulting either edge.
    /// Nested windows capture through the same interface, so an absent local
    /// witness reaches the true document edge rather than inventing an EOF.
    pub(super) fn stage_source(&self, raw: &str, window: Range<usize>) -> Self {
        debug_assert_eq!(raw.len(), window.len());
        self.stage_with_context(raw, window, true)
    }

    /// Inline spelling may transform a body before its isolated split. Only
    /// the outside semantic context uses these original source edges. Interior
    /// source/display anchors must use the inline owner's body correspondence;
    /// they must never be copied by an arithmetic window offset.
    pub(super) fn stage_body_source(&self, raw: &str, window: Range<usize>) -> Self {
        self.stage_with_context(raw, window, false)
    }

    pub(super) fn physical_tail(&self) -> PhysicalTail {
        self.context.physical_tail
    }

    pub(super) fn physical_tail_at(&self, at: usize) -> PhysicalTail {
        if matches!(self.physical_tail(), PhysicalTail::Unknown) {
            PhysicalTail::Unknown
        } else if at == self.source.len_bytes() {
            self.physical_tail()
        } else if at < self.source.len_bytes() && self.context.original_canonical {
            let Some(prefix) = self.projection.source_prefix_at(at) else {
                return PhysicalTail::Unknown;
            };
            let Some((block, base)) = self.projection.block_ref_at_source(at) else {
                return PhysicalTail::Unknown;
            };
            PhysicalTail::Row {
                code: prefix.code,
                quote_depth: prefix.quote_depth,
                first_item: prefix.list.as_ref().map(|list| list.first),
                item_depth: prefix.list.as_ref().map(|list| list.depth),
                empty_comment: block.empty_comment,
                quote_start: block.quote_start && base + block.source.start == at,
            }
        } else {
            PhysicalTail::Unknown
        }
    }

    /// Only the complete canonical source may construct original ownership.
    /// Gap rows are actual item-owned physical blanks, never omitted content.
    fn original_fence_boundary(&self, at: usize, end: usize) -> Option<FenceBoundary> {
        if !self.context.original_canonical {
            return None;
        }
        let (block, base) = self.projection.block_ref_at_source(at)?;
        let (fence, item) = (block.fence.as_ref()?, block.list.as_ref()?);
        crate::inline::visit_container();
        if base + item.item.end != end {
            return None;
        }
        let physical_end = if let Some(close) = &fence.closer {
            let physical = self
                .source
                .line_to_byte(self.source.byte_to_line(base + close.start));
            let row = self.projection.source_prefix_at(physical)?;
            if !row.code {
                return None;
            }
            row.source.end
        } else {
            base + fence.whole.end
        };
        if physical_end > end {
            return None;
        }
        if !self.blank_item_gap(physical_end, end, base + item.item.start) {
            return None;
        }
        Some(FenceBoundary {
            depth: item.depth,
            list_quote: item.quote_depth,
            code_quote: block.quote_depth,
            gap_bytes: end - physical_end,
        })
    }

    /// Current blank syntax is checked separately from original authority;
    /// matching extents alone never establish retained content or ownership.
    fn blank_item_gap(&self, start: usize, end: usize, item_start: usize) -> bool {
        let mut next = start;
        while next < end {
            crate::inline::visit_container();
            let Some(row) = self.projection.source_prefix_at(next) else {
                return false;
            };
            if row.source.end <= next
                || row.source.end > end
                || row.code
                || row.quote_depth != 0
                || !row.list.as_ref().is_some_and(|list| {
                    !list.first && list.item.start == item_start && list.item.end == end
                })
                || self.source.byte(row.source.end - 1) != b'\n'
                || !self
                    .source
                    .byte_slice(row.source.clone())
                    .bytes()
                    .all(|byte| {
                        crate::inline::visit_container();
                        matches!(byte, b' ' | b'\t' | b'\r' | b'\n')
                    })
            {
                return false;
            }
            next = row.source.end;
        }
        next == end
    }

    /// Original facts can be inherited only with the whole opening item kept.
    /// Trimming a staged start retains physical EOF but loses item authority.
    fn capture_fence_edge(&self, window: &Range<usize>) -> Option<FenceBoundary> {
        if !self.context.original_canonical {
            return (window.start == 0 && window.end == self.source.len_bytes())
                .then_some(self.context.fence_edge)
                .flatten();
        }
        let mut at = window.end;
        while at > window.start {
            crate::inline::visit_container();
            let previous = self.source.line_to_byte(self.source.byte_to_line(at - 1));
            if previous < window.start {
                return None;
            }
            let row = self.projection.source_prefix_at(previous)?;
            let item = row.list.as_ref()?;
            if item.depth != 1 || item.item.start < window.start || item.item.end != window.end {
                return None;
            }
            if row.code {
                return self.original_fence_boundary(previous, window.end);
            }
            if row.source.end != at
                || row.quote_depth != 0
                || !self
                    .source
                    .byte_slice(row.source.clone())
                    .bytes()
                    .all(|byte| {
                        crate::inline::visit_container();
                        matches!(byte, b' ' | b'\t' | b'\r' | b'\n')
                    })
            {
                return None;
            }
            at = previous;
        }
        None
    }

    pub(super) fn physical_fence_tail_at(
        &self,
        opener: usize,
        fence_end: usize,
        end: usize,
    ) -> (PhysicalTail, Option<FenceBoundary>) {
        let outside = self.physical_tail_at(end);
        let boundary = if self.context.original_canonical {
            self.original_fence_boundary(opener, end)
        } else if end == self.source.len_bytes() {
            self.context.fence_edge
        } else {
            None
        };
        let boundary = boundary
            .filter(|proof| end.checked_sub(fence_end) == Some(proof.gap_bytes))
            .filter(|proof| {
                if self.context.original_canonical || proof.gap_bytes == 0 {
                    return true;
                }
                let Some((block, base)) = self.projection.block_ref_at_source(opener) else {
                    return false;
                };
                let Some(item) = block.list.as_ref() else {
                    return false;
                };
                crate::inline::visit_container();
                self.blank_item_gap(fence_end, end, base + item.item.start)
            });
        (outside, boundary)
    }

    fn stage_with_context(&self, raw: &str, window: Range<usize>, exact: bool) -> Self {
        let physical_tail = if exact {
            self.physical_tail_at(window.end)
        } else {
            PhysicalTail::Unknown
        };
        let mut staged = Self::open_with_clock(raw, self.clock.clone());
        staged.context = StageContext {
            before: self.stage_boundary(window.start, false),
            after: self.stage_boundary(window.end, true),
            physical_tail,
            original_canonical: false,
            fence_edge: if exact {
                self.capture_fence_edge(&window)
            } else {
                None
            },
        };
        staged
    }
}

#[cfg(test)]
#[path = "staging_context_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "staging_physical_tests.rs"]
mod physical_tests;
