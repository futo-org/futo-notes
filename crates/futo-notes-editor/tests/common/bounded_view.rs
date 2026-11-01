use std::collections::BTreeMap;

use futo_notes_editor::*;

#[path = "bounded_view/mapping.rs"]
mod mapping;
use mapping::boundary_offsets;

/// A deliberately small public-wire consumer. It never parses source or guesses
/// identity from the spelling/length of a correspondence record. Initial maps
/// are exact public answers; later maps come only from explicit frame tags.
pub struct BoundedView {
    pub text: String,
    pub cursor: BoundedCursor,
    pub selection: DisplayRange,
    pub affinity: Affinity,
    pub runs: Vec<SemanticRun>,
    blocks: Vec<ViewBlock>,
    pub links: Vec<LinkDescription>,
    boundaries: BTreeMap<usize, Vec<usize>>,
    source_len: usize,
    expected_fence_owner: SourceOffset,
}

#[derive(Clone)]
struct ViewBlock {
    description: BlockDescription,
    source_owner: Option<SourceOffset>,
    // None for CodeFragment, which makes no physical-boundary claim.
    continuation: Option<(bool, bool)>,
}

impl BoundedView {
    /// This finite fixture has one fence whose opener is supplied literally by
    /// the test. Full legacy block descriptions do not export fence identity.
    pub fn new(
        session: &EditorSession,
        cursor: BoundedCursor,
        expected_fence_owner: SourceOffset,
    ) -> Self {
        assert_eq!(cursor.revision, session.revision());
        assert_eq!(cursor.generation, 0);
        let text = session.display_text();
        let projection = session
            .project(session.revision(), range(0, text.len()))
            .unwrap();
        let boundaries = boundary_offsets(&text)
            .map(|at| {
                let low = session
                    .source_at(session.revision(), DisplayOffset(at), Affinity::Backward)
                    .unwrap()
                    .0;
                let high = session
                    .source_at(session.revision(), DisplayOffset(at), Affinity::Forward)
                    .unwrap()
                    .0;
                (at, vec![low, high])
            })
            .collect();
        let blocks = projection
            .blocks
            .into_iter()
            .map(|description| ViewBlock {
                description,
                // A physical-row source boundary does not prove fence identity.
                source_owner: None,
                continuation: Some((false, false)),
            })
            .collect();
        Self {
            text,
            cursor,
            selection: session.selection(),
            affinity: session.affinity(),
            runs: projection.runs,
            blocks,
            links: projection.links,
            boundaries,
            source_len: session.source_text().len(),
            expected_fence_owner,
        }
    }

    pub fn apply_code(&mut self, change: &BoundedChange) {
        assert_eq!(change.projection.range, change.projection.identity.display);
        assert_eq!(change.projection.block.range, change.projection.range);
        let meaning = BoundedMeaning {
            range: change.projection.range,
            text: change.projection.text.clone(),
            mapping: vec![BoundedMap {
                source: change.projection.identity.source,
                display: change.projection.identity.display,
                kind: BoundedMapKind::Literal,
            }],
            runs: vec![SemanticRun {
                range: change.projection.range,
                formats: Vec::new(),
            }],
            blocks: vec![BoundedBlock {
                description: BlockDescription {
                    range: change.projection.block.range,
                    heading: 0,
                    quote_depth: 0,
                    divider: false,
                    list: None,
                    code: true,
                    language: change.projection.block.language.clone(),
                    metadata: false,
                },
                source_owner: Some(change.projection.block.owner),
                // Ignored below: CodeFragment has no physical-boundary flags.
                continues_before: false,
                continues_after: false,
            }],
            links: Vec::new(),
        };
        self.apply_meaning(
            change.previous,
            change.cursor,
            change.range,
            &change.inserted,
            change.selection,
            change.affinity,
            Some(change.source_change),
            change.projection.identity.source,
            &meaning,
            change.continuation,
            false,
        );
    }

    pub fn apply_progress(&mut self, progress: &BoundedProgress) {
        match progress {
            BoundedProgress::Change(change) => self.apply_meaning(
                change.previous,
                change.cursor,
                change.range,
                &change.inserted,
                change.selection,
                change.affinity,
                change.source_change,
                change.source_footprint,
                &change.projection,
                change.continuation,
                true,
            ),
            BoundedProgress::Status(status) => {
                self.advance(status.previous, status.cursor, false, status.continuation);
                self.select(status.selection, status.affinity);
            }
        }
    }

    fn advance(
        &mut self,
        previous: BoundedCursor,
        cursor: BoundedCursor,
        source_changed: bool,
        continuation: Option<ProjectionContinuation>,
    ) {
        assert_eq!(previous, self.cursor);
        assert_eq!(cursor.token, previous.token);
        assert_eq!(cursor.incarnation, previous.incarnation);
        assert_eq!(cursor.generation, previous.generation + 1);
        assert_eq!(
            cursor.revision.0,
            previous.revision.0 + u64::from(source_changed)
        );
        if let Some(next) = continuation {
            assert_eq!(next.cursor, cursor);
        }
        self.cursor = cursor;
    }

    fn select(&mut self, selection: DisplayRange, affinity: Affinity) {
        valid_range(&self.text, selection);
        self.selection = selection;
        self.affinity = affinity;
    }

    fn replace_records(
        &mut self,
        old: DisplayRange,
        new: DisplayRange,
        delta: isize,
        meaning: &BoundedMeaning,
        physical_bounds: bool,
    ) {
        self.runs = self
            .runs
            .drain(..)
            .flat_map(|run| {
                surviving_ranges(run.range, old, delta)
                    .into_iter()
                    .map(move |range| SemanticRun {
                        range,
                        formats: run.formats.clone(),
                    })
            })
            .chain(meaning.runs.iter().cloned())
            .collect();
        self.links = self
            .links
            .drain(..)
            .flat_map(|link| {
                surviving_ranges(link.range, old, delta)
                    .into_iter()
                    .map(move |range| LinkDescription {
                        range,
                        destination: link.destination.clone(),
                        title: link.title.clone(),
                    })
            })
            .chain(meaning.links.iter().cloned())
            .collect();
        self.blocks = self
            .blocks
            .drain(..)
            .flat_map(|block| {
                surviving_ranges(block.description.range, old, delta)
                    .into_iter()
                    .map(move |range| {
                        let mut fragment = block.clone();
                        if let Some((before, after)) = &mut fragment.continuation {
                            *before |= range.start.0
                                > shifted(
                                    block.description.range.start.0,
                                    if block.description.range.start.0 >= old.end.0 {
                                        delta
                                    } else {
                                        0
                                    },
                                );
                            *after |= range.end.0
                                < shifted(
                                    block.description.range.end.0,
                                    if block.description.range.end.0 > old.end.0 {
                                        delta
                                    } else {
                                        0
                                    },
                                );
                        }
                        fragment.description.range = range;
                        fragment
                    })
            })
            .chain(meaning.blocks.iter().map(|block| ViewBlock {
                description: block.description.clone(),
                source_owner: block.source_owner,
                continuation:
                    physical_bounds.then_some((block.continues_before, block.continues_after)),
            }))
            .collect();
        for run in &meaning.runs {
            contained(&self.text, new, run.range);
        }
        for link in &meaning.links {
            contained(&self.text, new, link.range);
        }
        for block in &meaning.blocks {
            contained(&self.text, new, block.description.range);
            assert_eq!(block.description.code, block.source_owner.is_some());
            if let Some(owner) = block.source_owner {
                assert_eq!(owner, self.expected_fence_owner, "explicit fence owner");
            }
        }
    }

    /// Compare coverage rather than fragment layout: a renderer may retain many
    /// code fragments where the full public projection returns one block/run.
    pub fn assert_matches(&self, session: &EditorSession) {
        assert_eq!(self.text, session.display_text());
        assert_eq!(self.source_len, session.source_text().len());
        assert_eq!(self.selection, session.selection());
        assert_eq!(self.affinity, session.affinity());
        let full = session
            .project(session.revision(), range(0, self.text.len()))
            .unwrap();
        for at in boundary_offsets(&self.text) {
            for affinity in [Affinity::Backward, Affinity::Forward] {
                assert_eq!(
                    self.source_at(DisplayOffset(at), affinity),
                    session
                        .source_at(session.revision(), DisplayOffset(at), affinity)
                        .unwrap(),
                    "source map at {at}, {affinity:?}"
                );
            }
        }
        for (at, ch) in self.text.char_indices() {
            let end = at + ch.len_utf8();
            let mut actual_formats: Vec<_> = self
                .runs
                .iter()
                .filter(|run| covers(run.range, at, end))
                .map(|run| run.formats.clone())
                .collect();
            let mut expected_formats: Vec<_> = full
                .runs
                .iter()
                .filter(|run| covers(run.range, at, end))
                .map(|run| run.formats.clone())
                .collect();
            actual_formats.sort();
            actual_formats.dedup();
            expected_formats.sort();
            expected_formats.dedup();
            assert_eq!(actual_formats, expected_formats, "formats at {at}");
            let actual_links: Vec<_> = self
                .links
                .iter()
                .filter(|link| covers(link.range, at, end))
                .map(|link| (&link.destination, &link.title))
                .collect();
            let expected_links: Vec<_> = full
                .links
                .iter()
                .filter(|link| covers(link.range, at, end))
                .map(|link| (&link.destination, &link.title))
                .collect();
            assert_eq!(actual_links, expected_links, "links at {at}");
            let actual: Vec<_> = self
                .blocks
                .iter()
                .filter(|block| covers(block.description.range, at, end))
                .map(|block| block_fact(&block.description))
                .collect();
            let expected: Vec<_> = full
                .blocks
                .iter()
                .filter(|block| covers(block.range, at, end))
                .map(block_fact)
                .collect();
            assert_eq!(actual, expected, "block coverage at {at}");
        }
        let mut actual_links = self.links.clone();
        let mut expected_links = full.links.clone();
        actual_links.sort_by_key(|link| (link.range.start.0, link.range.end.0));
        expected_links.sort_by_key(|link| (link.range.start.0, link.range.end.0));
        assert_eq!(actual_links, expected_links, "complete link identities");
        for block in &self.blocks {
            if let Some(owner) = block.source_owner {
                let matching = full
                    .blocks
                    .iter()
                    .find(|candidate| {
                        candidate.code
                            && candidate.range.start.0 <= block.description.range.start.0
                            && block.description.range.end.0 <= candidate.range.end.0
                            && block_fact(candidate) == block_fact(&block.description)
                    })
                    .unwrap_or_else(|| {
                        panic!(
                            "code fragment belongs to a canonical block: fragment={:#?}, owner={owner:?}, continuation={:?}, canonical_blocks={:#?}",
                            block.description, block.continuation, full.blocks
                        )
                    });
                if let Some((before, after)) = block.continuation {
                    // True flags remain claims about interior physical bounds.
                    // A formerly complete block may acquire an adjacent fragment.
                    if before {
                        assert!(matching.range.start.0 < block.description.range.start.0);
                    }
                    if after {
                        assert!(block.description.range.end.0 < matching.range.end.0);
                    }
                }
                assert_eq!(owner, self.expected_fence_owner, "code fragment owner");
            }
        }
    }
}

fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}
fn width(range: DisplayRange) -> usize {
    range.end.0 - range.start.0
}
fn shifted(value: usize, delta: isize) -> usize {
    value
        .checked_add_signed(delta)
        .expect("coordinate rebasing underflow/overflow")
}
fn valid_range(text: &str, range: DisplayRange) {
    assert!(range.start.0 <= range.end.0 && range.end.0 <= text.len());
    assert!(text.is_char_boundary(range.start.0) && text.is_char_boundary(range.end.0));
}
fn contained(text: &str, outer: DisplayRange, inner: DisplayRange) {
    valid_range(text, inner);
    assert!(outer.start.0 <= inner.start.0 && inner.end.0 <= outer.end.0);
}
fn covers(range: DisplayRange, start: usize, end: usize) -> bool {
    range.start.0 <= start && end <= range.end.0
}
fn surviving_ranges(
    existing: DisplayRange,
    removed: DisplayRange,
    delta: isize,
) -> Vec<DisplayRange> {
    if existing.end.0 <= removed.start.0 {
        return vec![existing];
    }
    if existing.start.0 >= removed.end.0 {
        return vec![range(
            shifted(existing.start.0, delta),
            shifted(existing.end.0, delta),
        )];
    }
    let mut result = Vec::new();
    if existing.start.0 < removed.start.0 {
        result.push(range(existing.start.0, removed.start.0));
    }
    if existing.end.0 > removed.end.0 {
        result.push(range(
            shifted(removed.end.0, delta),
            shifted(existing.end.0, delta),
        ));
    }
    result
}
fn block_fact(
    block: &BlockDescription,
) -> (
    u8,
    usize,
    bool,
    Option<ListDescription>,
    bool,
    Option<String>,
) {
    (
        block.heading,
        block.quote_depth,
        block.divider,
        block.list.clone(),
        block.code,
        block.language.clone(),
    )
}
