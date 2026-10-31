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
            physical_tail: PhysicalTail::Eof,
            original_canonical: true,
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

    fn stage_with_context(&self, raw: &str, window: Range<usize>, exact: bool) -> Self {
        let physical_tail = if !exact || matches!(self.physical_tail(), PhysicalTail::Unknown) {
            PhysicalTail::Unknown
        } else if window.end == self.source.len_bytes() {
            self.physical_tail()
        } else if window.end < self.source.len_bytes() && self.context.original_canonical {
            // source_prefix_at succeeds only at an actual physical row start.
            // No visible-neighbor query or global source coordinate is evidence
            // for this untouched outside row's identity.
            self.projection
                .source_prefix_at(window.end)
                .map_or(PhysicalTail::Unknown, |prefix| PhysicalTail::Row {
                    code: prefix.code,
                    quote_depth: prefix.quote_depth,
                    first_item: prefix.list.as_ref().map(|list| list.first),
                })
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
mod tests {
    use super::*;

    #[test]
    fn capturing_nested_origins_skips_foreign_bodies_and_blank_subtrees() {
        for blanks in [9, 1000, 20_000] {
            for body_bytes in [8, 100_000] {
                let gap = "\n".repeat(blanks + 1);
                let raw = format!(
                    "999. {}\n1. lazy{gap}body\n{gap}7) {}",
                    "x".repeat(body_bytes),
                    "y".repeat(body_bytes)
                );
                let session = EditorSession::open(&raw);
                let at = raw.find("body").unwrap();
                crate::inline::CONTEXT_VISITS.with(|visits| visits.set(0));
                let staged = session.stage_source("body\n", at..at + 5);
                let nested = staged.stage_source("body\n", 0..5);
                let before = nested.semantic_neighbor(0, false, 0).unwrap();
                let after = nested.semantic_neighbor(5, true, 0).unwrap();
                assert_eq!(before.witness.list.unwrap().ordinal, Some(1000));
                assert_eq!(after.witness.list.unwrap().ordinal, Some(7));
                let visits = crate::inline::CONTEXT_VISITS.with(|visits| visits.get());
                assert!(
                    visits > 0 && visits < 640,
                    "blanks={blanks}, body={body_bytes}, visits={visits}"
                );
                assert_eq!(nested.source.len_bytes(), 5);
            }
        }
    }

    fn meaning(
        neighbor: Option<Neighbor>,
    ) -> Option<(
        usize,
        bool,
        bool,
        Option<usize>,
        Option<u8>,
        Option<u64>,
        Option<usize>,
    )> {
        neighbor.map(|n| {
            (
                n.witness.quote_depth,
                n.witness.code,
                n.witness.empty_comment,
                n.witness.transparent_quote,
                n.marker,
                n.witness.list.as_ref().and_then(|l| l.ordinal),
                n.witness.list.as_ref().map(|l| l.depth),
            )
        })
    }

    #[test]
    fn boundary_carriers_equal_canonical_queries_at_every_source_cut_and_quote_depth() {
        for eol in ["\n", "\r\n"] {
            for middle in [
                "",
                "\n\n",
                ">\n>\n",
                "> >\n> >\n",
                ">\n\n> >\n",
                "<!-- -->\n",
                "```\ncode\n```\n",
                "**a\nb**\n",
                "`a\nb`\n",
                "# heading\n",
            ] {
                let raw =
                    format!("999. before\n1. lazy\n\n{middle}\n7) after\n").replace('\n', eol);
                let session = EditorSession::open(&raw);
                for at in raw
                    .char_indices()
                    .filter_map(|(at, ch)| (ch == '\n').then_some(at + 1))
                    .chain([0, raw.len()])
                {
                    let staged = session.stage_source("", at..at);
                    let nested = staged.stage_source("", 0..0);
                    for quote in [0, 1, 2, 3, 19, usize::MAX] {
                        for forward in [false, true] {
                            let expected = meaning(session.semantic_neighbor(at, forward, quote));
                            assert_eq!(
                                meaning(staged.semantic_neighbor(0, forward, quote)),
                                expected,
                                "{raw:?} at={at} quote={quote} forward={forward}"
                            );
                            assert_eq!(
                                meaning(nested.semantic_neighbor(0, forward, quote)),
                                expected
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn local_edits_override_external_witnesses_without_reusing_foreign_coordinates() {
        let session = EditorSession::open("999. before\n1. lazy\n\nbody\n\n\n7) after");
        let at = session.source_text().find("body").unwrap();
        for replacement in [
            "",
            "\n\n",
            ">\n",
            "> >\n",
            "<!-- -->\n",
            "plain\n",
            "3. body\n",
        ] {
            let mut staged = session.stage_source("body\n", at..at + 5);
            staged
                .replace_action(
                    staged.revision(),
                    DisplayRange {
                        start: DisplayOffset(0),
                        end: DisplayOffset(5),
                    },
                    replacement,
                    crate::InputAction::Isolated,
                    &mut |_| Ok(()),
                )
                .unwrap();
            let local = EditorSession::open(&staged.source_text());
            for quote in [0, 1, 2, 3] {
                for forward in [false, true] {
                    let point = if forward {
                        0
                    } else {
                        staged.source.len_bytes()
                    };
                    let expected = local.semantic_neighbor(point, forward, quote);
                    let actual = staged.semantic_neighbor(point, forward, quote);
                    if expected.is_some() {
                        assert_eq!(
                            meaning(actual),
                            meaning(expected),
                            "{replacement:?}, quote={quote}"
                        );
                    } else if let Some(neighbor) = actual {
                        assert!(!neighbor.local);
                        assert_eq!(
                            meaning(Some(neighbor)),
                            meaning(session.semantic_neighbor(
                                if forward { at + 5 } else { at },
                                forward,
                                quote
                            ))
                        );
                    }
                }
            }
            let nested = staged.stage_source(&staged.source_text(), 0..staged.source.len_bytes());
            assert_eq!(
                meaning(nested.semantic_neighbor(0, false, 0)),
                meaning(staged.semantic_neighbor(0, false, 0))
            );
            assert_eq!(
                meaning(nested.semantic_neighbor(nested.source.len_bytes(), true, 0)),
                meaning(staged.semantic_neighbor(staged.source.len_bytes(), true, 0))
            );
        }
    }
}

#[cfg(test)]
#[path = "staging_physical_tests.rs"]
mod physical_tests;
