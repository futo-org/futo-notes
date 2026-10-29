//! Text services may replace a whole field to correct several separate words.
use super::*;
use similar::{ChangeTag, TextDiff};

impl EditorSession {
    /// Placeholder ranges address the inserted UTF-8 string and must contain
    /// only actual platform U+FFFC placeholders. An untagged U+FFFC is literal
    /// user content, including when it already exists in exact source.
    pub fn replace_os(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
        placeholders: &[DisplayRange],
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.check_revision(expected)?;
        let text = clean_placeholders(text, placeholders)?;
        if self.composition.is_some() {
            return self.finish_provisional_input(expected, range, &text, accept);
        }
        self.validate_range(range)?;
        let old = self
            .projection
            .display
            .byte_slice(range.start.0..range.end.0)
            .to_string();
        let replacements = differing_runs(&old, &text, range.start.0);
        let mut change = if replacements.is_empty() {
            None
        } else {
            Some(self.replace_many(expected, &replacements, accept)?)
        };
        self.finish_os_selection(range.start.0 + text.len(), change.as_mut());
        Ok(change)
    }
    pub(super) fn finish_os_selection(&mut self, caret: usize, change: Option<&mut ViewChange>) {
        let selection = DisplayRange {
            start: DisplayOffset(caret),
            end: DisplayOffset(caret),
        };
        if self.selection != selection {
            self.selection = selection;
            self.pending_formats = None;
        }
        self.affinity = Affinity::Backward;
        self.typing = None;
        if let Some(change) = change {
            change.selection = self.selection;
            change.affinity = self.affinity;
            let entry = self.undo.last_mut().unwrap().entries.last_mut().unwrap();
            entry.after_selection = self.selection;
            entry.after_affinity = self.affinity;
            entry.after_formats = self.pending_formats.clone();
        }
    }
}

pub(super) fn clean_placeholders(
    text: &str,
    placeholders: &[DisplayRange],
) -> Result<String, EditorError> {
    let mut previous = 0;
    let mut result = String::new();
    for range in placeholders {
        let part = text
            .get(range.start.0..range.end.0)
            .ok_or(EditorError::InvalidRange)?;
        if range.start.0 < previous || part.is_empty() || !part.chars().all(|c| c == '\u{fffc}') {
            return Err(EditorError::InvalidRange);
        }
        result.push_str(&text[previous..range.start.0]);
        previous = range.end.0;
    }
    result.push_str(&text[previous..]);
    Ok(result)
}

fn differing_runs(old: &str, new: &str, start: usize) -> Vec<crate::DisplayReplacement> {
    let diff = TextDiff::from_chars(old, new);
    let mut position = start;
    let mut runs: Vec<crate::DisplayReplacement> = Vec::new();
    let mut current: Option<crate::DisplayReplacement> = None;
    for change in diff.iter_all_changes() {
        match change.tag() {
            ChangeTag::Equal => {
                if let Some(run) = current.take() {
                    runs.push(run);
                }
                position += change.value().len();
            }
            ChangeTag::Delete => {
                let run = current.get_or_insert_with(|| crate::DisplayReplacement {
                    range: DisplayRange {
                        start: DisplayOffset(position),
                        end: DisplayOffset(position),
                    },
                    inserted: String::new(),
                });
                position += change.value().len();
                run.range.end = DisplayOffset(position);
            }
            ChangeTag::Insert => {
                let run = current.get_or_insert_with(|| crate::DisplayReplacement {
                    range: DisplayRange {
                        start: DisplayOffset(position),
                        end: DisplayOffset(position),
                    },
                    inserted: String::new(),
                });
                run.inserted.push_str(change.value());
            }
        }
    }
    if let Some(run) = current {
        runs.push(run);
    }
    runs
}
