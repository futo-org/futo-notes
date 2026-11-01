//! Port of the TS `buildWikilinkIndex`: one pass over the note ids answers
//! [`resolve_wikilink`](super::resolve_wikilink) and
//! [`shortest_unique_suffix`](super::shortest_unique_suffix) without rescanning
//! the ids for each link.
use std::collections::{HashMap, HashSet};

struct Entry {
    id: String,
    /// Distinct ids carrying the suffix: resolution and display both need one.
    owners: usize,
}

/// Locale-independent folding shared with the shipping suggestion rule:
/// lowercase the whole text, then every Greek sigma becomes one letter.
pub fn fold(text: &str) -> String {
    text.to_lowercase().replace('ς', "σ")
}

#[derive(Default)]
pub struct WikilinkIndex {
    ids: HashSet<String>,
    /// Distinct ids in delivery order, so completion keeps the host's ranking,
    /// each with its folded text so a request never re-folds the catalog.
    order: Vec<(String, String)>,
    by_suffix: HashMap<String, Entry>,
    /// Suffix entries visited while building; proportional to the id list.
    pub build_items: usize,
}

impl WikilinkIndex {
    pub fn new(all_ids: &[String]) -> Self {
        let mut index = Self::default();
        for id in all_ids {
            if !index.ids.insert(id.clone()) {
                continue; // a repeated id is one note
            }
            index.order.push((id.clone(), fold(id)));
            for suffix in super::link_targets_naming(id) {
                index.build_items += 1;
                match index.by_suffix.get_mut(suffix) {
                    Some(entry) => entry.owners += 1,
                    None => {
                        index.by_suffix.insert(
                            suffix.to_owned(),
                            Entry {
                                id: id.clone(),
                                owners: 1,
                            },
                        );
                    }
                }
            }
        }
        index
    }

    pub fn contains(&self, id: &str) -> bool {
        self.ids.contains(id)
    }

    pub fn ids(&self) -> impl Iterator<Item = &str> {
        self.ids.iter().map(String::as_str)
    }

    /// Distinct `(id, folded id)` pairs in the order they were delivered.
    pub fn ordered(&self) -> impl Iterator<Item = (&str, &str)> {
        self.order.iter().map(|(id, folded)| (&**id, &**folded))
    }

    pub fn resolve(&self, target: &str) -> Option<&str> {
        if target.is_empty() {
            return None;
        }
        if let Some(id) = self.ids.get(target) {
            return Some(id);
        }
        self.by_suffix
            .get(target)
            .filter(|entry| entry.owners == 1)
            .map(|entry| entry.id.as_str())
    }

    /// Shortest suffix naming `id` among the delivered ids; callers pass a
    /// delivered id.
    pub fn display_suffix(&self, id: &str) -> String {
        let mut suffixes: Vec<&str> = super::link_targets_naming(id).collect();
        suffixes.reverse();
        suffixes
            .into_iter()
            .find(|suffix| self.by_suffix.get(*suffix).is_some_and(|e| e.owners == 1))
            .unwrap_or(id)
            .to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_answers_equal_the_scanning_rules() {
        let ids: Vec<String> = [
            "Projects/Roadmap",
            "Other/Notes",
            "Work/Notes",
            "Notes",
            "a/b/c",
            "x/b/c",
            "dup",
            "dup",
            "a/dup",
            "a/dup",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let index = WikilinkIndex::new(&ids);
        // A repeated id is one note: the scanning rules see the distinct list.
        let mut distinct = ids.clone();
        distinct.sort();
        distinct.dedup();
        for target in [
            "Roadmap",
            "Notes",
            "Work/Notes",
            "c",
            "b/c",
            "a/b/c",
            "dup",
            "a/dup",
            "",
            "missing",
            "/c",
        ] {
            assert_eq!(
                index.resolve(target).map(str::to_owned),
                super::super::resolve_wikilink(target, &distinct),
                "{target}"
            );
        }
        for id in &distinct {
            assert_eq!(
                index.display_suffix(id),
                super::super::shortest_unique_suffix(id, &distinct),
                "{id}"
            );
        }
    }
}
