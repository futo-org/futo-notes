//! Document-wide reference read context with row-relative occurrence witnesses.
//! Only the canonical parsers normalize labels and identify declarations/uses.
use super::row::LinkMeaning;
use pulldown_cmark::{BrokenLink, CowStr, Event, LinkType, Options, Parser, Tag};
use std::{collections::HashMap, ops::Range, sync::Arc};
use unicase::UniCase;

#[derive(Clone, Debug, Default)]
pub(crate) struct ReferenceWork {
    pub parsed: usize,
    pub items: usize,
    pub copied: usize,
}

#[derive(Default)]
pub(crate) struct References {
    targets: HashMap<UniCase<CowStr<'static>>, Arc<LinkMeaning>>,
    uses: HashMap<Arc<str>, usize>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Definition {
    pub range: Range<usize>,
    pub key: UniCase<String>,
    pub destination: String,
    pub title: Option<String>,
    pub winner: bool,
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

impl References {
    pub fn scan(source: &str) -> (Arc<Self>, Vec<Winner>, ReferenceWork) {
        if !source.contains('[') || !source.contains(':') {
            return (
                Arc::new(Self::default()),
                Vec::new(),
                ReferenceWork::default(),
            );
        }
        let parser = Parser::new_ext(source, Options::ENABLE_STRIKETHROUGH);
        let mut work = ReferenceWork {
            parsed: source.len(),
            ..Default::default()
        };
        let mut targets = HashMap::new();
        let mut winners = Vec::new();
        for (key, definition) in parser.reference_definitions().iter() {
            work.items += 2;
            work.copied += 2 * key.len()
                + definition.dest.len()
                + definition.title.as_ref().map_or(0, |title| title.len());
            let key: Arc<str> = Arc::from(key);
            targets.insert(
                UniCase::new(CowStr::from(key.to_string())),
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
                    if let Some(target) = targets.get(&UniCase::new(id)) {
                        let key = target.reference.as_ref().unwrap().clone();
                        *uses.entry(key).or_insert(0) += 1;
                    }
                }
            }
        }
        winners.sort_by_key(|winner| winner.range.start);
        (Arc::new(Self { targets, uses }), winners, work)
    }

    pub fn target(&self, parsed_key: &str) -> Option<&Arc<LinkMeaning>> {
        // UniCase's borrowed key supports lookup without cloning the map or its
        // values. The parser already normalized whitespace in parsed_key.
        self.targets
            .get(&UniCase::new(CowStr::Borrowed(parsed_key)))
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
    if !source.contains('[') || !source.contains(':') {
        return (Vec::new(), ReferenceWork::default());
    }
    let tree = markdown::to_mdast(source, &markdown::ParseOptions::default())
        .expect("CommonMark declarations are infallible");
    let mut work = ReferenceWork {
        parsed: source.len(),
        ..Default::default()
    };
    let mut result = Vec::new();
    let mut pending = vec![&tree];
    while let Some(node) = pending.pop() {
        if let markdown::mdast::Node::Definition(definition) = node {
            if let Some(position) = &definition.position {
                let range = position.start.offset..position.end.offset;
                let key = UniCase::new(definition.identifier.clone());
                work.items += 1 + winners.len();
                work.copied += definition.identifier.len()
                    + definition.url.len()
                    + definition.title.as_ref().map_or(0, String::len);
                let winner = winners.iter().any(|winner| {
                    UniCase::new(winner.key.as_ref())
                        == UniCase::new(definition.identifier.as_str())
                        && winner.range.start <= range.start
                        && range.start < winner.range.end
                });
                result.push(Definition {
                    range,
                    key,
                    destination: definition.url.clone(),
                    title: definition.title.clone(),
                    winner,
                });
            }
        }
        if let Some(children) = node.children() {
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
