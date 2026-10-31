//! Document-wide reference read context with row-relative occurrence witnesses.
//! Only the canonical parsers normalize labels and identify declarations/uses.
mod repair;
use super::row::LinkMeaning;
use pulldown_cmark::{BrokenLink, CowStr, Event, LinkType, Options, Parser, Tag};
pub(crate) use repair::{BodyIntent, RetainedBody};
use std::{collections::HashMap, ops::Range, sync::Arc};
use unicase::UniCase;

#[derive(Clone, Debug, Default)]
pub(crate) struct ReferenceWork {
    pub parsed: usize,
    pub items: usize,
    pub copied: usize,
}

/// An exact stage owns a detached persistent canonical source root. Rope
/// clones share their immutable tree; no note String or Rows snapshot is copied.
pub(crate) struct SourceOrigin {
    pub source: ropey::Rope,
    pub start: usize,
}
impl SourceOrigin {
    pub fn mirror(&mut self, edit: &crate::SourceEdit) -> usize {
        let start = self.source.byte_to_char(self.start + edit.range.start.0);
        let end = self.source.byte_to_char(self.start + edit.range.end.0);
        self.source.remove(start..end);
        self.source.insert(start, &edit.inserted);
        edit.inserted.len()
    }
}

#[derive(Default)]
pub(crate) struct References {
    targets: HashMap<UniCase<String>, Arc<LinkMeaning>>,
    uses: HashMap<Arc<str>, usize>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Definition {
    pub range: Range<usize>,
    pub key: UniCase<String>,
    pub destination: String,
    pub title: Option<String>,
    pub winner: bool,
    pub witness: Option<Arc<str>>,
}

#[derive(Clone, Debug)]
pub(crate) struct Winner {
    pub range: Range<usize>,
    pub key: Arc<str>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ReferenceUse {
    pub range: Range<usize>,
    pub key: Arc<str>,
    pub image: bool,
}

pub(super) fn is_reference(kind: &LinkType) -> bool {
    matches!(
        kind,
        LinkType::Reference
            | LinkType::ReferenceUnknown
            | LinkType::Collapsed
            | LinkType::CollapsedUnknown
            | LinkType::Shortcut
            | LinkType::ShortcutUnknown
    )
}

/// Byte eligibility guards perform no parsing, but their visits still count.
fn declaration_eligible(source: &str, work: &mut ReferenceWork) -> bool {
    [b'[', b':'].into_iter().all(|wanted| {
        source.bytes().any(|byte| {
            work.items += 1;
            byte == wanted
        })
    })
}

impl References {
    pub fn scan(source: &str) -> (Arc<Self>, Vec<Winner>, ReferenceWork) {
        let mut work = ReferenceWork::default();
        if !declaration_eligible(source, &mut work) {
            return (Arc::new(Self::default()), Vec::new(), work);
        }
        let parser = Parser::new_ext(
            source,
            Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS,
        );
        work.parsed = source.len();
        let mut targets = HashMap::new();
        let mut winners = Vec::new();
        for (key, definition) in parser.reference_definitions().iter() {
            work.items += 2;
            work.copied += 2 * key.len()
                + definition.dest.len()
                + definition.title.as_ref().map_or(0, |title| title.len());
            let key: Arc<str> = Arc::from(key);
            targets.insert(
                UniCase::new(key.to_string()),
                Arc::new(LinkMeaning {
                    destination: definition.dest.to_string(),
                    title: definition.title.as_ref().map(ToString::to_string),
                    reference: Some(key.clone()),
                }),
            );
            winners.push(Winner {
                range: definition.span.clone(),
                key,
            });
        }
        let mut uses = HashMap::new();
        for event in parser {
            if let Event::Start(
                Tag::Link { link_type, id, .. } | Tag::Image { link_type, id, .. },
            ) = event
            {
                if is_reference(&link_type) {
                    work.items += 1;
                    work.copied += id.len();
                    if let Some(target) = targets.get(&UniCase::new(id.to_string())) {
                        let key = target.reference.as_ref().unwrap().clone();
                        *uses.entry(key).or_insert(0) += 1;
                    }
                }
            }
        }
        winners.sort_by(|a, b| {
            work.items += 1;
            a.range.start.cmp(&b.range.start)
        });
        (Arc::new(Self { targets, uses }), winners, work)
    }

    pub fn target(&self, parsed_key: &str) -> Option<&Arc<LinkMeaning>> {
        // A lookup owns only this parser-normalized key, never the map or its
        // values. UniCase supplies the same case folding as pulldown.
        self.targets.get(&UniCase::new(parsed_key.to_owned()))
    }

    pub fn broken<'a>(&'a self, link: BrokenLink<'_>) -> Option<(CowStr<'a>, CowStr<'a>)> {
        self.target(&link.reference).map(|target| {
            (
                CowStr::Borrowed(&target.destination),
                CowStr::Borrowed(target.title.as_deref().unwrap_or("")),
            )
        })
    }

    pub fn used(&self, key: &str) -> bool {
        self.target(key)
            .and_then(|target| self.uses.get(target.reference.as_ref().unwrap()))
            .is_some_and(|count| *count > 0)
    }
}

/// Collect every definition occurrence, including later duplicates omitted by
/// pulldown's first-definition map. mdast owns positions and normalization.
pub(super) fn declarations(source: &str, winners: &[Winner]) -> (Vec<Definition>, ReferenceWork) {
    let mut work = ReferenceWork::default();
    if !declaration_eligible(source, &mut work) {
        return (Vec::new(), work);
    }
    let tree = markdown::to_mdast(source, &markdown::ParseOptions::default())
        .expect("CommonMark declarations are infallible");
    work.parsed = source.len();
    let mut result = Vec::new();
    let mut pending = vec![&tree];
    while let Some(node) = pending.pop() {
        work.items += 1;
        if let markdown::mdast::Node::Definition(definition) = node {
            if let Some(position) = &definition.position {
                let range = position.start.offset..position.end.offset;
                work.items += 1;
                let witness = winners
                    .iter()
                    .find(|winner| {
                        work.items += 1;
                        winner.range.start <= range.start && range.end <= winner.range.end
                    })
                    .map(|winner| winner.key.clone());
                // Parser identifiers are not a cross-library representation:
                // mdast can remove whitespace that pulldown collapses. The
                // actual canonical source occurrence joins their ownership;
                // only its resolver key may query the canonical use table.
                let resolved_key = witness.as_deref().unwrap_or(&definition.identifier);
                work.copied += resolved_key.len()
                    + definition.url.len()
                    + definition.title.as_ref().map_or(0, String::len);
                let key = UniCase::new(resolved_key.to_owned());
                result.push(Definition {
                    range,
                    key,
                    destination: definition.url.clone(),
                    title: definition.title.clone(),
                    winner: witness.is_some(),
                    witness,
                });
            }
        }
        if let Some(children) = node.children() {
            work.items += children.len();
            pending.extend(children.iter().rev());
        }
    }
    (result, work)
}

pub(super) fn hidden_definition(source: &str, definition: &Definition) -> Range<usize> {
    let start = source[..definition.range.start]
        .rfind('\n')
        .map_or(0, |at| at + 1);
    let mut end = source[definition.range.end..]
        .find('\n')
        .map_or(source.len(), |at| definition.range.end + at + 1);
    while end < source.len() {
        let line_end = source[end..]
            .find('\n')
            .map_or(source.len(), |at| end + at + 1);
        if !source[end..line_end]
            .trim_matches([' ', '\t', '\r', '\n'])
            .is_empty()
        {
            break;
        }
        end = line_end;
    }
    start..end
}

pub(super) fn window_winners(
    winners: &[Winner],
    origin: usize,
    length: usize,
) -> (Vec<Winner>, usize) {
    let first = winners.partition_point(|winner| winner.range.start < origin);
    let last = winners.partition_point(|winner| winner.range.start < origin + length);
    let items = 2 * (usize::BITS - winners.len().leading_zeros()) as usize + 2 * (last - first);
    let result = winners[first..last]
        .iter()
        .filter(|winner| winner.range.end <= origin + length)
        .map(|winner| Winner {
            range: winner.range.start - origin..winner.range.end - origin,
            key: winner.key.clone(),
        })
        .collect();
    (result, items)
}

impl super::Projection {
    /// Only occurrence witnesses in the exact source window cross a stage.
    /// The immutable document resolver itself is shared without enumeration.
    pub(crate) fn reference_winners(&self, window: Range<usize>) -> (Vec<Winner>, ReferenceWork) {
        #[cfg(test)]
        let visits = super::coordinate_work_tests::visits();
        let first = self.rows.locate(window.start, false);
        let last = self.rows.locate(
            window.end.saturating_sub(usize::from(!window.is_empty())),
            false,
        );
        let mut winners = Vec::new();
        let mut work = ReferenceWork::default();
        for index in first..=last {
            let (row, origin, _) = self.rows.at(index);
            work.items += row.definitions.len();
            for definition in row
                .definitions
                .iter()
                .filter(|definition| definition.winner)
            {
                let range = origin + definition.range.start..origin + definition.range.end;
                if window.start <= range.start && range.end <= window.end {
                    work.items += 2;
                    work.copied += definition.key.as_ref().len();
                    if let Some(target) = self.references.target(definition.key.as_ref()) {
                        winners.push(Winner {
                            range: range.start - window.start..range.end - window.start,
                            key: target.reference.as_ref().unwrap().clone(),
                        });
                    }
                }
            }
        }
        #[cfg(test)]
        super::coordinate_work_tests::query("reference-winners", visits, work.items);
        (winners, work)
    }
}

impl super::Projection {
    /// Compare ordered local occurrence meaning across the whole reparsed
    /// envelope, independently of its new paragraph boundaries. Surviving
    /// declarations retain physical source identity through the exact edit.
    pub(super) fn reference_meaning_changed(
        &self,
        first: usize,
        last: usize,
        source_start: usize,
        parsed: &[super::row::Row],
        edit: &crate::SourceEdit,
    ) -> (bool, usize) {
        let mut old_definitions = Vec::new();
        let mut old_uses = Vec::new();
        let mut work = 0;
        for index in first..=last {
            let (row, origin, _) = self.rows.at(index);
            work += row.definitions.len() + row.reference_uses.len();
            for definition in &row.definitions {
                let mut range = origin + definition.range.start..origin + definition.range.end;
                if edit.range.end.0 <= range.start {
                    range.start = range.start - edit.removed.len() + edit.inserted.len();
                    range.end = range.end - edit.removed.len() + edit.inserted.len();
                } else if edit.range.start.0 < range.end && range.start < edit.range.end.0 {
                    return (true, work);
                }
                old_definitions.push((range, definition));
            }
            old_uses.extend(row.reference_uses.iter());
        }
        let mut definitions = old_definitions.into_iter();
        let mut uses = old_uses.into_iter();
        let mut origin = source_start;
        for row in parsed {
            work += row.definitions.len() + row.reference_uses.len();
            for definition in &row.definitions {
                work += 1;
                let Some((range, previous)) = definitions.next() else {
                    return (true, work);
                };
                if range != (origin + definition.range.start..origin + definition.range.end)
                    || previous.key != definition.key
                    || previous.destination != definition.destination
                    || previous.title != definition.title
                {
                    return (true, work);
                }
            }
            for usage in &row.reference_uses {
                work += 1;
                let Some(previous) = uses.next() else {
                    return (true, work);
                };
                if previous.key != usage.key || previous.image != usage.image {
                    return (true, work);
                }
            }
            origin += row.source_len;
        }
        (definitions.next().is_some() || uses.next().is_some(), work)
    }

    /// True declaration/use mutations can affect remote targets or visibility.
    /// This deliberately charged whole-document fallback belongs to #301's
    /// correctness boundary; progressive global work remains #313's scope.
    pub(super) fn rebuild_references(
        &mut self,
        source: &ropey::Rope,
        edit: &crate::SourceEdit,
        local_materialized: usize,
        local_parsed: usize,
        local_items: usize,
        local_copied: usize,
        origin: Option<&SourceOrigin>,
    ) -> super::Update {
        let old = self.display.to_string();
        let old_source_len = source.len_bytes() - edit.inserted.len() + edit.removed.len();
        let mut pending = self.pending_links(0..old_source_len);
        let mut pending_work = pending.work + pending.ranges.len();
        pending.guarded_words = pending
            .guarded_words
            .iter()
            .filter_map(|word| {
                let (word, work) = word.raw_edit(edit);
                pending_work += work;
                word
            })
            .collect();
        pending.typed_inputs = pending
            .typed_inputs
            .iter()
            .filter_map(|origin| {
                let (origin, work) = origin.raw_edit(edit);
                pending_work += work;
                origin
            })
            .collect();
        pending.ranges.retain_mut(|range| {
            if range.end <= edit.range.start.0 {
            } else if edit.range.end.0 <= range.start {
                range.start = range.start - edit.removed.len() + edit.inserted.len();
                range.end = range.end - edit.removed.len() + edit.inserted.len();
            } else {
                return false;
            }
            true
        });
        pending.delimiters.retain_mut(|range| {
            if range.end <= edit.range.start.0 {
            } else if edit.range.end.0 <= range.start {
                range.start = range.start - edit.removed.len() + edit.inserted.len();
                range.end = range.end - edit.removed.len() + edit.inserted.len();
            } else {
                return false;
            }
            true
        });
        let raw = source.to_string();
        let mut origin_materialized = 0;
        let mut fresh = if self.references_complete {
            Self::new(&raw)
        } else {
            let origin = origin.expect("an exact canonical source origin was checked");
            let canonical = origin.source.to_string();
            origin_materialized = canonical.len();
            let (references, winners, mut work) = References::scan(&canonical);
            let (local, visits) = window_winners(&winners, origin.start, raw.len());
            work.items += visits;
            Self::with_references(&raw, references, &local, work)
        };
        pending.window = 0..raw.len();
        let pending_work = pending_work + fresh.restore_pending(&pending);
        let inserted = fresh.display.to_string();
        let prefix: usize = old
            .chars()
            .zip(inserted.chars())
            .take_while(|(a, b)| a == b)
            .map(|(ch, _)| ch.len_utf8())
            .sum();
        let suffix: usize = old[prefix..]
            .chars()
            .rev()
            .zip(inserted[prefix..].chars().rev())
            .take_while(|(a, b)| a == b)
            .map(|(ch, _)| ch.len_utf8())
            .sum();
        let update = super::Update {
            range: crate::DisplayRange {
                start: crate::DisplayOffset(prefix),
                end: crate::DisplayOffset(old.len() - suffix),
            },
            inserted: inserted[prefix..inserted.len() - suffix].into(),
            parsed_source_bytes: local_parsed + fresh.initial_parse_work,
            materialized_source_bytes: local_materialized
                + raw.len()
                + old.len()
                + inserted.len()
                + origin_materialized,
            semantic_range: crate::DisplayRange {
                start: crate::DisplayOffset(0),
                end: crate::DisplayOffset(inserted.len()),
            },
            link_metadata_items: local_items + fresh.initial_link_metadata_items + pending_work,
            link_copied_bytes: local_copied + fresh.initial_link_copied_bytes,
        };
        fresh.has_rebuilt_references = true;
        *self = fresh;
        update
    }
}
