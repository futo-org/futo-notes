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
    #[default]
    Eof,
    Row {
        code: bool,
        quote_depth: usize,
        first_item: Option<bool>,
        item_depth: Option<usize>,
        empty_comment: bool,
        // Original canonical fence and item end at this exact physical edge.
        // Tuple is list depth, list quote depth, fence quote depth; no offsets.
        fence_item_end: Option<(usize, usize, usize)>,
    },
    Unknown,
}

pub(super) struct StageContext {
    before: Boundary,
    after: Boundary,
    physical_tail: PhysicalTail,
    original_canonical: bool,
}

impl Default for StageContext {
    fn default() -> Self {
        Self {
            before: Boundary::default(),
            after: Boundary::default(),
            physical_tail: PhysicalTail::Unknown,
            original_canonical: false,
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

    /// Original physical proof is queried only through its authority owner.
    /// A locally present tail in derived/truncated source cannot recertify it.
    pub(super) fn physical_tail_at(&self, at: usize) -> PhysicalTail {
        if matches!(self.physical_tail(), PhysicalTail::Unknown) {
            PhysicalTail::Unknown
        } else if at == self.source.len_bytes() {
            self.physical_tail()
        } else if at < self.source.len_bytes() && self.context.original_canonical {
            self.projection
                .source_prefix_at(at)
                .map_or(PhysicalTail::Unknown, |prefix| PhysicalTail::Row {
                    code: prefix.code,
                    quote_depth: prefix.quote_depth,
                    first_item: prefix.list.as_ref().map(|list| list.first),
                    item_depth: prefix.list.as_ref().map(|list| list.depth),
                    fence_item_end: self.projection.fence_item_end_at(at),
                    empty_comment: self
                        .projection
                        .list_command_line_at_source(at)
                        .is_some_and(|line| line.empty_comment),
                })
        } else {
            PhysicalTail::Unknown
        }
    }

    /// Normalize only original item-owned unquoted blank rows after a fence.
    /// Temporary parses cannot create this original relationship certificate.
    pub(super) fn physical_fence_tail_at(
        &self,
        opener: usize,
        fence_end: usize,
        end: usize,
    ) -> PhysicalTail {
        let mut tail = self.physical_tail_at(end);
        if !self.context.original_canonical {
            return if fence_end == end {
                tail
            } else {
                PhysicalTail::Unknown
            };
        }
        let Some((block, base)) = self.projection.block_ref_at_source(opener) else {
            return PhysicalTail::Unknown;
        };
        let (Some(fence), Some(item)) = (&block.fence, &block.list) else {
            return PhysicalTail::Unknown;
        };
        crate::inline::visit_container();
        if fence.closer.is_some()
            || base + fence.opener.start != opener
            || base + fence.whole.end != fence_end
            || base + item.item.end != end
            || fence_end > end
        {
            return PhysicalTail::Unknown;
        }
        let mut at = fence_end;
        while at < end {
            crate::inline::visit_container();
            let Some(row) = self.projection.source_prefix_at(at) else {
                return PhysicalTail::Unknown;
            };
            if row.source.end <= at
                || row.source.end > end
                || row.code
                || row.quote_depth != 0
                || !row.list.as_ref().is_some_and(|list| {
                    !list.first && list.item.start == base + item.item.start && list.item.end == end
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
                return PhysicalTail::Unknown;
            }
            at = row.source.end;
        }
        if let PhysicalTail::Row { fence_item_end, .. } = &mut tail {
            *fence_item_end = Some((item.depth, item.quote_depth, block.quote_depth));
        }
        tail
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
