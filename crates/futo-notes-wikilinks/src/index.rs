//! Port of the TS `buildWikilinkIndex`: one pass over the note ids answers
//! [`resolve_wikilink`](super::resolve_wikilink) and
//! [`shortest_unique_suffix`](super::shortest_unique_suffix) without rescanning
//! the ids for each link.
use std::collections::{HashMap, HashSet};

struct Entry {
    id: String,
    /// Every id carrying the suffix, repeats included (resolution's tally).
    matches: usize,
    /// Distinct ids carrying the suffix (display's tally).
    owners: usize,
}

#[derive(Default)]
pub struct WikilinkIndex {
    ids: HashSet<String>,
    by_suffix: HashMap<String, Entry>,
    /// Suffix entries visited while building; proportional to the id list.
    pub build_items: usize,
}

impl WikilinkIndex {
    pub fn new(all_ids: &[String]) -> Self {
        let mut index = Self::default();
        for id in all_ids {
            let first_seen = index.ids.insert(id.clone());
            for suffix in super::link_targets_naming(id) {
                index.build_items += 1;
                match index.by_suffix.get_mut(suffix) {
                    Some(entry) => {
                        entry.matches += 1;
                        entry.owners += usize::from(first_seen);
                    }
                    None => {
                        index.by_suffix.insert(
                            suffix.to_owned(),
                            Entry {
                                id: id.clone(),
                                matches: 1,
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

    pub fn resolve(&self, target: &str) -> Option<&str> {
        if target.is_empty() {
            return None;
        }
        if let Some(id) = self.ids.get(target) {
            return Some(id);
        }
        self.by_suffix
            .get(target)
            .filter(|entry| entry.matches == 1)
            .map(|entry| entry.id.as_str())
    }

    pub fn display_suffix(&self, id: &str) -> String {
        if !self.ids.contains(id) {
            let ids: Vec<String> = self.ids.iter().cloned().collect();
            return super::shortest_unique_suffix(id, &ids);
        }
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
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let index = WikilinkIndex::new(&ids);
        for target in [
            "Roadmap",
            "Notes",
            "Work/Notes",
            "c",
            "b/c",
            "a/b/c",
            "dup",
            "",
            "missing",
            "/c",
        ] {
            assert_eq!(
                index.resolve(target).map(str::to_owned),
                super::super::resolve_wikilink(target, &ids),
                "{target}"
            );
        }
        for id in &ids {
            assert_eq!(
                index.display_suffix(id),
                super::super::shortest_unique_suffix(id, &ids),
                "{id}"
            );
        }
    }
}
