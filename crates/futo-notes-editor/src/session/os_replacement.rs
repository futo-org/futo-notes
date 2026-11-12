//! Text services may replace a whole field to correct several separate words.
use super::*;
use similar::{ChangeTag, TextDiff};
mod word;

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
            return self.finish_provisional_input(
                expected,
                range,
                &text,
                crate::InputAction::Isolated,
                accept,
            );
        }
        self.replace_os_with_targets(expected, range, &text, &[], accept)
            .map(|(change, _)| change)
    }

    /// Map targets in the intended raw replacement display to the protected
    /// display. Composition uses this when committing a provisional overlay
    /// before applying an input/command that still addresses that raw overlay.
    pub(super) fn replace_os_with_targets(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
        targets: &[usize],
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<(Option<ViewChange>, Vec<usize>), EditorError> {
        self.replace_os_with_targets_action(
            expected,
            range,
            text,
            targets,
            crate::InputAction::Isolated,
            accept,
        )
    }

    pub(super) fn replace_os_with_targets_action(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
        targets: &[usize],
        action: crate::InputAction,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<(Option<ViewChange>, Vec<usize>), EditorError> {
        self.validate_range(range)?;
        let old = self
            .projection
            .display
            .byte_slice(range.start.0..range.end.0)
            .to_string();
        let replacements = differing_runs(&old, &text, range.start.0);
        // A replacement that ends at the caret (a keyboard's double-space period turning
        // the trailing space into ". ", an autocorrected word) is typing, not a caret move:
        // the carried formats survive it, as they do a Backspace at the caret.
        let carried = (self.selection.start == self.selection.end
            && range.end == self.selection.end)
            .then(|| self.pending_formats.clone())
            .flatten();
        let whole_word =
            self.word_split_by_carried(range, &old, text, &replacements, carried.as_deref());
        let before = (!self.context.staged).then(|| self.before_input());
        let (mut change, targets, caret) = if replacements.is_empty() {
            (None, targets.to_vec(), range.end.0)
        } else {
            let mut targets = targets.to_vec();
            targets.push(range.start.0 + text.len());
            let shown = || {
                crate::inline::Expected::Replaced(vec![(
                    range.start.0..range.end.0,
                    text.to_owned(),
                )])
            };
            let plan =
                |session: &mut Self,
                 runs: &[crate::DisplayReplacement],
                 whole: bool,
                 accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>| {
                    session.word_takes_carried = whole;
                    let planned = session.checked_input(shown(), accept, |session, accept| {
                        session.replace_runs(expected, range, text, runs, &targets, action, accept)
                    });
                    session.word_takes_carried = false;
                    planned
                };
            // A word the carried formats would split (#360) is planned as one run under them.
            // Should that plan fail before the host sees an edit, the runs plan it as before.
            let (change, mut targets) =
                self.continuing_written(range, accept, |session, accept| {
                    if whole_word {
                        let whole = [crate::DisplayReplacement {
                            range,
                            inserted: text.to_owned(),
                        }];
                        let mut handed = false;
                        let first = plan(session, &whole, true, &mut |edit| {
                            handed = true;
                            accept(edit)
                        });
                        match first {
                            Err(_) if !handed => plan(session, &replacements, false, accept),
                            other => other,
                        }
                    } else {
                        plan(session, &replacements, false, accept)
                    }
                })?;
            let caret = targets.pop().unwrap();
            (Some(change), targets, caret)
        };
        self.finish_os_selection(caret, carried, change.as_mut());
        if let Some(before) = before {
            self.track_written(before);
        }
        Ok((change, targets))
    }

    /// The text-service runs, as before repairs. Refused, the input is
    /// planned as one run replacing the whole range, as typing over it is,
    /// which a code block's frame repair can keep (`inline::Repair`), but
    /// only when the text the runs keep is plain text inside one line: one
    /// run would respell its hidden formatting and blocks.
    #[allow(clippy::too_many_arguments)]
    fn replace_runs(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
        runs: &[crate::DisplayReplacement],
        targets: &[usize],
        action: crate::InputAction,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<(ViewChange, Vec<usize>), EditorError> {
        let planned = {
            let _as_before = crate::inline::Repair::bar();
            self.replace_many_with_targets(expected, runs, targets, action, accept)
        };
        match planned {
            Err(EditorError::UnrepresentableFormat)
                if crate::inline::Repair::may() && self.keeps_plain(range, runs) =>
            {
                crate::inline::Repair::mark();
                let whole = crate::DisplayReplacement {
                    range,
                    inserted: text.to_owned(),
                };
                self.replace_many_with_targets(expected, &[whole], targets, action, accept)
            }
            other => other,
        }
    }

    /// Whether the stretches of `range` between `runs` are plain text: no
    /// line break, source spelled as shown, and formatted as the text one run
    /// lands at the range's start is. One run puts the kept text there, so
    /// text kept after a code span's closing marker (hidden at its edge) would
    /// turn into inline code (#350). A block's own markers, which the code
    /// block's frame repair keeps, open no format. A stretch of fewer than
    /// three letters or digits is letters the character diff shares by chance
    /// (dictation over mixed formatting), not text the user kept, and is not
    /// held to it.
    fn keeps_plain(&self, range: DisplayRange, runs: &[crate::DisplayReplacement]) -> bool {
        let lands = self
            .projection
            .formats_at(self.projection.source_bounds(range.start.0).1);
        let ends = runs.iter().map(|run| (run.range.start.0, run.range.end.0));
        let mut at = range.start.0;
        ends.chain([(range.end.0, range.end.0)])
            .all(|(start, end)| {
                let kept = self.projection.display.byte_slice(at..start).to_string();
                let source =
                    self.projection.source_bounds(at).1..self.projection.source_bounds(start).0;
                at = end;
                let formatted = |formats: Vec<InlineFormat>| {
                    kept.chars().filter(|c| c.is_alphanumeric()).count() < 3
                        || formats.len() == lands.len() && formats.iter().all(|f| lands.contains(f))
                };
                !kept.contains('\n')
                    && (kept.is_empty()
                        || self
                            .source
                            .get_byte_slice(source.clone())
                            .is_some_and(|raw| raw == kept.as_str())
                            && formatted(self.projection.formats_at(source.start)))
            })
    }

    pub(super) fn finish_os_selection(
        &mut self,
        caret: usize,
        carried: Option<Vec<InlineFormat>>,
        change: Option<&mut ViewChange>,
    ) {
        let selection = DisplayRange {
            start: DisplayOffset(caret),
            end: DisplayOffset(caret),
        };
        if self.selection != selection {
            self.selection = selection;
            self.pending_formats = None;
        }
        if carried.is_some() {
            self.pending_formats = carried;
        }
        self.affinity = Affinity::Backward;
        self.typing = None;
        if let Some(change) = change {
            let (source, work) = self.capture_history_selection();
            change.work.link_metadata_items += work;
            change.selection = self.selection;
            change.affinity = self.affinity;
            let entry = self.undo.last_mut().unwrap().entries.last_mut().unwrap();
            entry.after_selection = self.selection;
            entry.after_source = source;
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

pub(super) fn differing_runs(old: &str, new: &str, start: usize) -> Vec<crate::DisplayReplacement> {
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
